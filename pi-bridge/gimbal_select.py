"""Which Bluetooth gimbal this bridge drives, and how the operator changes it.

One Pi sits next to one gimbal, but a Pi hears every DJI gimbal in the room, and a DJI gimbal accepts only ONE
Bluetooth connection. So the choice must be explicit and must not drift:

* The selection is saved in gimbal.json in the state directory (DJI_BRIDGE_STATE_DIR, default /var/lib/dji-bridge;
  gimbal-<instance>.json for a templated dji-bridge@<instance>). It overrides DJI_RS3_BLE_ADDRESS.
* With nothing saved and no DJI_RS3_BLE_ADDRESS, the bridge is in AUTO mode: it scans for advertising DJI gimbals
  (names starting "DJI RS"), takes the strongest signal, and SAVES that choice, so a later change in signal strength
  never silently swaps gimbals. The strongest is usually the one next to the Pi, but not always: the operator can
  change it (GET /gimbals, POST /gimbal?address=...).
* Scanning can upset a live BlueZ link, so scans happen only when asked for (GET /gimbals?scan=1, a switch to "auto")
  or while no gimbal is linked. A gimbal already linked (to this bridge or to another host) does not advertise, so
  the selected gimbal is always listed even when the scan cannot see it.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import tempfile
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional

log = logging.getLogger("dji-bridge.select")

DJI_NAME_PREFIXES = ("DJI RS",)
MAC_RE = re.compile(r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
DEFAULT_STATE_DIR = "/var/lib/dji-bridge"
STATE_DIR_ENV = "DJI_BRIDGE_STATE_DIR"
# Long enough to hear a gimbal that advertises every ~1 s a few times; short enough for an HTTP request.
SCAN_S = 4.0
# After dropping a link, a DJI gimbal takes a moment to start advertising again.
RELEASE_SETTLE_S = 2.0
# A scan result older than this is not shown as the current picture.
SCAN_FRESH_S = 120.0


class SelectionError(Exception):
    """A selection request that cannot be carried out (bad address, nothing found, busy)."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def normalize_address(raw: Any) -> Optional[str]:
    """AA:BB:CC:DD:EE:FF in upper case, or None when it is not a Bluetooth address."""
    if not isinstance(raw, str):
        return None
    value = raw.strip().upper().replace("-", ":")
    return value if MAC_RE.match(value) else None


def is_dji_gimbal(name: Any) -> bool:
    return isinstance(name, str) and any(name.strip().upper().startswith(p.upper()) for p in DJI_NAME_PREFIXES)


def pick_strongest(found: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The DJI gimbal with the strongest RSSI (ties broken by address, so the pick is deterministic)."""
    candidates = [g for g in found if is_dji_gimbal(g.get("name")) and isinstance(g.get("rssi"), (int, float))]
    if not candidates:
        return None
    return sorted(candidates, key=lambda g: (-float(g["rssi"]), str(g["address"])))[0]


def state_path(instance: Optional[str] = None, state_dir: Optional[str] = None) -> str:
    base = state_dir or os.environ.get(STATE_DIR_ENV) or DEFAULT_STATE_DIR
    name = f"gimbal-{instance}.json" if instance else "gimbal.json"
    return os.path.join(base, name)


class SelectionStore:
    """gimbal.json: {"address", "name", "rssi", "chosenBy", "chosenAt"}. Tolerates a missing or broken file."""

    def __init__(self, path: str) -> None:
        self.path = path

    def load(self) -> Optional[Dict[str, Any]]:
        try:
            with open(self.path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as exc:
            log.warning("ignoring unreadable gimbal selection %s: %s", self.path, exc)
            return None
        address = normalize_address(raw.get("address")) if isinstance(raw, dict) else None
        if not address:
            log.warning("ignoring gimbal selection %s: no valid address in it", self.path)
            return None
        return {
            "address": address,
            "name": raw.get("name") if isinstance(raw.get("name"), str) else None,
            "rssi": raw.get("rssi") if isinstance(raw.get("rssi"), (int, float)) else None,
            "chosenBy": raw.get("chosenBy") if isinstance(raw.get("chosenBy"), str) else "saved",
            "chosenAt": raw.get("chosenAt") if isinstance(raw.get("chosenAt"), (int, float)) else None,
        }

    def save(self, selection: Dict[str, Any]) -> bool:
        """Write atomically (temp file + rename). False, logged, when the directory is missing or read-only."""
        body = {k: selection.get(k) for k in ("address", "name", "rssi", "chosenBy", "chosenAt")}
        directory = os.path.dirname(self.path) or "."
        try:
            fd, tmp = tempfile.mkstemp(prefix=".gimbal-", dir=directory)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(body, fh, indent=2)
                    fh.write("\n")
                os.replace(tmp, self.path)
            except BaseException:
                with contextlib.suppress(OSError):
                    os.unlink(tmp)
                raise
        except OSError as exc:
            log.warning("could not save the gimbal selection to %s: %s (kept in memory only)", self.path, exc)
            return False
        return True


LockAcquire = Callable[[], Awaitable[Any]]
LockRelease = Callable[[Any], None]


class GimbalSelector:
    """Owns the choice of gimbal for one bridge process and carries out switches.

    Every scan and every switch holds the host-wide BLE lock that maintain_gimbal() holds while connecting, so a
    scan never races a connect (BlueZ allows one such operation per adapter) and a switch never interleaves with a
    reconnect of the old gimbal.
    """

    def __init__(
        self,
        driver: Any,
        store: SelectionStore,
        configured_address: Optional[str],
        acquire: LockAcquire,
        release: LockRelease,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.driver = driver
        self.store = store
        self.acquire = acquire
        self.release = release
        self.clock = clock
        self.switching = False
        self.persisted: Optional[bool] = None
        self.last_scan: Optional[Dict[str, Any]] = None
        self.last_error: Optional[str] = None
        saved = store.load()
        configured = normalize_address(configured_address)
        if saved:
            self.selected: Optional[Dict[str, Any]] = saved
            self.source = "saved"
            self.persisted = True
        elif configured:
            self.selected = {"address": configured, "name": None, "rssi": None, "chosenBy": "config", "chosenAt": None}
            self.source = "config"
        else:
            self.selected = None
            self.source = "auto"
        if self.selected:
            log.info("gimbal selection: %s (%s)", self.selected["address"], self.source)
        else:
            log.info("gimbal selection: AUTO (strongest advertising DJI gimbal, saved once found)")

    @property
    def can_scan(self) -> bool:
        return callable(getattr(self.driver, "scan", None))

    @property
    def address(self) -> Optional[str]:
        return self.selected["address"] if self.selected else None

    # ------------------------------------------------------------ scanning

    async def _scan_locked(self, timeout: float) -> List[Dict[str, Any]]:
        found = await self.driver.scan(timeout)
        clean: Dict[str, Dict[str, Any]] = {}
        for g in found or []:
            address = normalize_address(g.get("address"))
            if not address:
                continue
            entry = {"address": address, "name": g.get("name") if isinstance(g.get("name"), str) else None,
                     "rssi": g.get("rssi") if isinstance(g.get("rssi"), (int, float)) else None}
            if address not in clean or (entry["rssi"] or -999) > (clean[address]["rssi"] or -999):
                clean[address] = entry
        gimbals = [g for g in clean.values() if is_dji_gimbal(g["name"])]
        self.last_scan = {"at": self.clock(), "gimbals": gimbals}
        if self.selected:
            seen = clean.get(self.selected["address"])
            if seen:
                self.selected["rssi"] = seen["rssi"]
                self.selected["rssiAt"] = self.clock()
                if seen["name"]:
                    self.selected["name"] = seen["name"]
        return gimbals

    async def scan(self, timeout: float = SCAN_S) -> List[Dict[str, Any]]:
        if not self.can_scan:
            raise SelectionError("this driver cannot scan for Bluetooth gimbals", 501)
        lock = await self.acquire()
        try:
            return await self._scan_locked(timeout)
        finally:
            self.release(lock)

    async def auto_pick(self) -> bool:
        """AUTO mode, nothing linked: scan, take the strongest DJI gimbal, save it. False when none was heard."""
        if self.selected or not self.can_scan or self.switching:
            return bool(self.selected)
        gimbals = await self.scan()
        best = pick_strongest(gimbals)
        if best is None:
            self.last_error = "no DJI gimbal is advertising (off, asleep, out of range, or connected to another host)"
            log.warning("auto gimbal selection: %s", self.last_error)
            return False
        self._commit(best, "auto-strongest")
        log.warning("auto gimbal selection: picked %s %s (RSSI %s, strongest of %d) and saved it",
                    best["name"], best["address"], best["rssi"], len(gimbals))
        await self.driver.set_address(best["address"])
        return True

    # ------------------------------------------------------------ switching

    def _commit(self, entry: Dict[str, Any], chosen_by: str) -> None:
        now = self.clock()
        self.selected = {"address": entry["address"], "name": entry.get("name"), "rssi": entry.get("rssi"),
                         "rssiAt": now if entry.get("rssi") is not None else None, "chosenBy": chosen_by, "chosenAt": now}
        self.source = "saved"
        self.persisted = self.store.save(self.selected)
        self.last_error = None

    async def select(self, target: Any) -> Dict[str, Any]:
        """Switch to `target` (an address or "auto"): stop, drop the current link, save, and let maintain_gimbal()
        connect the new one. "auto" drops the link first (a linked gimbal does not advertise), scans, and takes the
        strongest; if nothing is heard it goes back to the previous gimbal and raises."""
        auto = isinstance(target, str) and target.strip().lower() == "auto"
        address = None if auto else normalize_address(target)
        if not auto and not address:
            raise SelectionError("address must be a Bluetooth address like 48:1C:B9:54:C6:BC, or \"auto\"")
        if self.switching:
            raise SelectionError("a gimbal switch is already in progress", 409)
        if auto and not self.can_scan:
            raise SelectionError("this driver cannot scan, so it cannot pick a gimbal automatically", 501)
        if address and address == self.address and getattr(self.driver, "connected", False):
            return self.describe_selection()
        self.switching = True
        previous = dict(self.selected) if self.selected else None
        try:
            lock = await self.acquire()
            try:
                with contextlib.suppress(Exception):
                    await self.driver.stop()
                log.warning("gimbal switch requested: %s -> %s", self.address or "none", "AUTO" if auto else address)
                await self.driver.set_address(None)  # drops the link: a DJI gimbal takes one connection only
                if auto:
                    await asyncio.sleep(RELEASE_SETTLE_S)
                    best = pick_strongest(await self._scan_locked(SCAN_S))
                    if best is None:
                        await self.driver.set_address(previous["address"] if previous else None)
                        raise SelectionError("no DJI gimbal is advertising; kept the previous gimbal", 404)
                    self._commit(best, "auto-strongest")
                else:
                    known = next((g for g in (self.last_scan or {}).get("gimbals", []) if g["address"] == address), None)
                    self._commit(known or {"address": address, "name": None, "rssi": None}, "operator")
                await self.driver.set_address(self.selected["address"])
            finally:
                self.release(lock)
        finally:
            self.switching = False
        log.warning("gimbal switched to %s %s (saved: %s)", self.selected.get("name") or "", self.address, self.persisted)
        return self.describe_selection()

    # ------------------------------------------------------------ reporting

    def describe_selection(self) -> Dict[str, Any]:
        """The `bluetooth` block of /info and status: which gimbal, how it was chosen, whether it is linked."""
        sel = self.selected or {}
        linked_name = getattr(self.driver, "linked_name", None)
        linked_rssi = getattr(self.driver, "linked_rssi", None)
        return {
            "mode": "auto" if not self.selected else "fixed",
            "address": sel.get("address"),
            "name": linked_name or sel.get("name"),
            # RSSI is only measurable while a gimbal advertises, so this is the value from the last scan or connect.
            "rssi": linked_rssi if linked_rssi is not None else sel.get("rssi"),
            "chosenBy": sel.get("chosenBy"),
            "chosenAt": sel.get("chosenAt"),
            "saved": self.persisted,
            "connected": bool(getattr(self.driver, "connected", False)),
            "switching": self.switching,
            "canScan": self.can_scan,
            "error": self.last_error,
        }

    async def gimbals_body(self, scan: bool) -> Dict[str, Any]:
        """GET /gimbals. Scans only when asked (scan=True) or while nothing is linked; says which it did."""
        linked = bool(getattr(self.driver, "connected", False))
        scanned = False
        error = None
        if self.can_scan and (scan or not linked) and not self.switching:
            try:
                await self.scan()
                scanned = True
            except Exception as exc:  # noqa: BLE001 - a failed scan is reported, not fatal
                error = f"scan failed: {exc}"
        cached = self.last_scan if self.last_scan and self.clock() - self.last_scan["at"] <= SCAN_FRESH_S else None
        seen = list(cached["gimbals"]) if cached else []
        rows: List[Dict[str, Any]] = []
        for g in sorted(seen, key=lambda g: (-(g["rssi"] if g["rssi"] is not None else -999), g["address"])):
            rows.append({**g, "advertising": True})
        if self.selected and not any(r["address"] == self.selected["address"] for r in rows):
            # Linked gimbals do not advertise: keep the selected one on the list regardless.
            rows.insert(0, {"address": self.selected["address"], "name": getattr(self.driver, "linked_name", None) or self.selected.get("name"),
                            "rssi": self.selected.get("rssi"), "advertising": False})
        # "Strongest" goes by the last signal heard from each gimbal, the linked one included (its RSSI is from
        # its last scan or connect): the operator's rule of thumb is that the strongest is the one by the Pi.
        strongest = pick_strongest(rows)
        for r in rows:
            r["selected"] = bool(self.selected) and r["address"] == self.selected["address"]
            r["connected"] = r["selected"] and linked
            if r["connected"]:
                r["advertising"] = False  # a cached sighting from before the link: it cannot be advertising now
            r["strongest"] = bool(strongest) and r["address"] == strongest["address"]
        note = ("Scanned just now while the gimbal was linked: a scan can briefly disturb a live Bluetooth link."
                if scanned and linked else
                "Scanned just now (no gimbal linked)." if scanned else
                "Not scanned: a gimbal is linked and scanning can disturb its link. Ask with ?scan=1." if self.can_scan else
                "This driver cannot scan for Bluetooth gimbals.")
        return {
            "scanned": scanned,
            "scannedAt": cached["at"] if cached else None,
            "note": note,
            "error": error,
            "selected": self.describe_selection(),
            "gimbals": rows,
        }
