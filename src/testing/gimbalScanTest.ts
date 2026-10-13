import assert from 'assert';
import { VirtualDjiBridge } from './virtualDjiBridge';
import { fetchBridgeInfo, probeBridge, mergeBridges, FoundBridge } from '../devices/gimbalScan';

/**
 * Finding gimbal bridges (plan D16, F4). Run: npx ts-node src/testing/gimbalScanTest.ts
 * GET /info must identify a bridge without opening a session (a session's end makes the Pi stop its gimbal),
 * and one bridge reached at two addresses must be listed once.
 */
let passed = 0;
const check = (name: string, condition: boolean): void => { assert.ok(condition, `FAILED ${name}`); passed++; };

const entry = (over: Partial<FoundBridge>): FoundBridge => ({
  host: 'h', port: 7878, address: null, aliases: [], reachable: true, model: 'RS3', gimbalConnected: true, via: 'info',
  hostname: null, instance: null, gimbalAddress: null, clients: null, ...over,
});

async function main(): Promise<void> {
  const fresh = new VirtualDjiBridge({ port: 0, hostname: 'stage-pi', instance: 'rs3pro-a', gimbalAddress: '48:1C:B9:54:C6:BC', gimbalModel: 'RS3' });
  const old = new VirtualDjiBridge({ port: 0, info: false });
  const freshPort = await fresh.start();
  const oldPort = await old.start();
  try {
    const info = await fetchBridgeInfo('127.0.0.1', freshPort);
    check('GET /info names the Pi, instance, port and gimbal', info?.hostname === 'stage-pi' && info?.instance === 'rs3pro-a' && info?.port === freshPort && info?.gimbalAddress === '48:1C:B9:54:C6:BC' && info?.model === 'RS3' && info?.gimbalConnected === true && info?.via === 'info');
    check('GET /info opens no session, so it can never make the bridge stop its gimbal', fresh.infoRequests === 1 && fresh.sessionsOpened === 0);
    check('an older bridge without /info gives no answer there', (await fetchBridgeInfo('127.0.0.1', oldPort)) === null && old.sessionsOpened === 0);
    const hello = await probeBridge('127.0.0.1', oldPort);
    check('an older bridge is still found by hello (which does open a session)', hello.reachable === true && hello.via === 'hello' && old.sessionsOpened === 1);
    check('nothing answers on a closed port', (await fetchBridgeInfo('127.0.0.1', 1)) === null);
  } finally {
    await fresh.stop();
    await old.stop();
  }

  const merged = mergeBridges([
    entry({ host: '192.168.50.150', address: '192.168.50.150', port: 7879, hostname: 'dji-bridge' }),
    entry({ host: 'dji-bridge.local', address: '192.168.50.151', port: 7879, hostname: 'dji-bridge' }),
    entry({ host: 'dji-bridge.local', address: '192.168.50.151', port: 7880, hostname: 'dji-bridge' }),
  ], ['dji-bridge.local']);
  check('one Pi reached on two addresses is listed once per port', merged.length === 2);
  const p7879 = merged.find((b) => b.port === 7879)!;
  check('the kept entry uses the host the inventory already knows, and lists both addresses', p7879.host === 'dji-bridge.local' && p7879.aliases.join() === '192.168.50.150:7879,dji-bridge.local:7879');
  const viaName = mergeBridges([entry({ host: '10.0.0.5', hostname: 'pi-2' }), entry({ host: 'pi-2.local', hostname: 'pi-2' })], []);
  check('without an inventory host, the Pi\'s .local name is preferred over an address', viaName.length === 1 && viaName[0].host === 'pi-2.local');
  const byBle = mergeBridges([entry({ host: 'a', gimbalAddress: '48:1c:b9:54:c6:bc' }), entry({ host: 'b', gimbalAddress: '48:1C:B9:54:C6:BC' })], []);
  check('bridges that report no host name are matched by the gimbal\'s Bluetooth address', byBle.length === 1);
  const unknown = mergeBridges([entry({ host: 'a' }), entry({ host: 'b' })], []);
  check('bridges with no identity are never merged (two old bridges stay two)', unknown.length === 2);
  check('same Pi, different ports stay separate gimbals', mergeBridges([entry({ host: 'a', hostname: 'x', port: 7878 }), entry({ host: 'a', hostname: 'x', port: 7879 })], []).length === 2);
  const reach = mergeBridges([entry({ host: 'dji-bridge.local', hostname: 'x', reachable: false, gimbalConnected: null }), entry({ host: '10.0.0.9', hostname: 'x', reachable: true })], ['dji-bridge.local']);
  check('an alias that answered supplies the state, under the preferred host', reach.length === 1 && reach[0].reachable === true && reach[0].host === 'dji-bridge.local');

  console.log(`gimbal scan: ${passed} checks passed`);
}

main().catch((error) => { console.error(error); process.exit(1); });
