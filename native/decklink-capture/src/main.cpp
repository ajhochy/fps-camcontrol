// camcontrol-capture: DeckLink (or synthetic) capture -> Matroska for its consumers; JSON status lines on stderr.
//  - single-output mode (default): one consumer on stdout (or --output FILE); stdout closing ends the helper.
//  - service mode (--serve, issue #95): the helper is the card's only owner and serves N consumers that attach and detach
//    over a line protocol on stdin ("attach ID FIFO" / "detach ID"); stdin EOF (the app went away) stops it.
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
#include <regex>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <memory>
#include "decklink_source.hpp"
#include "modes.hpp"
#include "pipeline.hpp"
#include "synthetic.hpp"

static volatile sig_atomic_t g_stop = 0;
static void on_signal(int) { g_stop = 1; }

static void usage() {
  std::fprintf(stderr,
    "usage: camcontrol-capture [options] > matroska-pipe\n"
    "  --device N|NAME        DeckLink device index or name substring (default: first input-capable)\n"
    "  --mode NAME            initial/fallback mode when no signal is detected (default 1080p30); formats: 720p50 720p5994 720p60 1080p25 1080p2997 1080p30\n"
    "                         1080p50 1080p5994 1080p60 1080i50 1080i5994 1080i60. Auto-detect picks the real mode before the first frame is written.\n"
    "  --detect-timeout SEC   wait this long for a signal before starting with filler in --mode (default 3)\n"
    "  --channels 2|8|16      embedded audio channels (default 2)      --sample-bits 16|32 (default 32)\n"
    "  --queue-frames N       backpressure queue depth before video frames are dropped (default 12)\n"
    "  --duration SEC         stop cleanly SEC seconds after the first frame is written           --stats-interval MS (default 1000)\n"
    "  --output FILE|-        default '-' (stdout, must not be a terminal)\n"
    "  --list-devices         print devices as JSON on stdout and exit\n"
    "  --serve                service mode: no stdout output; consumers attach on stdin with 'attach ID /path/to/fifo' and leave with 'detach ID'\n"
    "  --stall-ms MS          service mode: drop a consumer whose writer has been blocked this long (default 2000; 0 = never)\n"
    "  --synthetic [--synthetic-mode NAME] [--synthetic-loss AT:FOR[:nosignal]] [--synthetic-impulse]   bars+tone through the same output path, no card needed;\n"
    "                         --synthetic-format-change SEC: report an input format change SEC seconds after start (exit 5 path)\n"
    "                         --synthetic-impulse: black picture with a white flash frame, a 5 ms 1 kHz click on both channels at the same stream time every 2 s and a burnt-in 24-bit frame counter (A/V timing proofs)\n"
    "exit codes: 0 clean, 2 usage, 3 no driver/device, 4 device busy/enable failed, 5 input format changed (restart session), 6 write failure\n");
}

// Service-mode control channel (stdin, one command per line). Opening a consumer's FIFO waits up to 5 s for its reader,
// so it runs on this thread and never stalls capture. stdin EOF means the supervising app is gone: stop.
static bool open_consumer(const std::string& path, int* fd_out, std::string* why) {
  struct stat st;
  if (::lstat(path.c_str(), &st) != 0) { *why = "missing"; return false; }
  if (!S_ISFIFO(st.st_mode)) { *why = "not-a-fifo"; return false; }
  for (int i = 0; i < 250 && !g_stop; i++) {
    int fd = ::open(path.c_str(), O_WRONLY | O_NONBLOCK);
    if (fd >= 0) { *fd_out = fd; return true; }
    if (errno != ENXIO) { *why = std::string("open-failed: ") + std::strerror(errno); return false; }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));  // no reader yet
  }
  *why = "no-reader"; return false;
}
static void serve_control(Pipeline& pl, size_t queue, int stall_ms) {
  std::thread([&pl, queue, stall_ms] {
    static const std::regex attach_re("^attach ([A-Za-z0-9_-]{1,32}) (/[^\\s]{1,1000})$"), detach_re("^detach ([A-Za-z0-9_-]{1,32})$");
    std::string line; char c;
    for (;;) {
      ssize_t n = ::read(0, &c, 1);
      if (n < 0 && errno == EINTR) continue;
      if (n <= 0) { jl::event("control-closed"); g_stop = 1; return; }
      if (c != '\n') { if (line.size() < 1100) line += c; continue; }
      std::smatch m;
      if (std::regex_match(line, m, attach_re)) {
        const std::string id = m[1], path = m[2]; int fd = -1; std::string why;
        if (pl.find(id)) jl::event("consumer-attach-failed", jl::Obj().str("id", id).str("reason", "duplicate"));
        else if (!open_consumer(path, &fd, &why)) jl::event("consumer-attach-failed", jl::Obj().str("id", id).str("reason", why));
        else if (!pl.add_sink(std::make_shared<Sink>(id, fd, queue, stall_ms, true))) { jl::event("consumer-attach-failed", jl::Obj().str("id", id).str("reason", "duplicate")); }
        else jl::event("consumer-attached", jl::Obj().str("id", id).b("waiting_format", !pl.started()));
      } else if (std::regex_match(line, m, detach_re)) {
        auto s = pl.detach(m[1]);
        if (s) jl::event("consumer-detached", s->stats().str("reason", s->reason())); else jl::event("consumer-detach-failed", jl::Obj().str("id", std::string(m[1])).str("reason", "unknown"));
      } else if (!line.empty()) jl::event("control-rejected", jl::Obj().i("length", (long long)line.size()));
      line.clear();
    }
  }).detach();
}

int main(int argc, char** argv) {
  jl::now_ms();
  std::string device, mode = "1080p30", output = "-", synth_mode = "1080p30", loss; double detect = 3, duration = 0; int channels = 2, bits = 32, queue = 12, stats_ms = 1000;
  bool synthetic = false, list = false, impulse = false, serve = false; int stall_ms = -1; double fmt_change = 0;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i]; auto next = [&]() -> std::string { if (i + 1 >= argc) { usage(); jl::fatal("usage", "missing value for " + a, 2); } return argv[++i]; };
    if (a == "--device") device = next(); else if (a == "--mode") mode = next(); else if (a == "--detect-timeout") detect = std::atof(next().c_str());
    else if (a == "--channels") channels = std::atoi(next().c_str()); else if (a == "--sample-bits") bits = std::atoi(next().c_str());
    else if (a == "--queue-frames") queue = std::atoi(next().c_str()); else if (a == "--duration") duration = std::atof(next().c_str());
    else if (a == "--stats-interval") stats_ms = std::atoi(next().c_str()); else if (a == "--output") output = next();
    else if (a == "--list-devices") list = true; else if (a == "--synthetic") synthetic = true;
    else if (a == "--synthetic-impulse") impulse = true; else if (a == "--synthetic-mode") synth_mode = next(); else if (a == "--synthetic-loss") loss = next();
    else if (a == "--serve") serve = true; else if (a == "--stall-ms") stall_ms = std::atoi(next().c_str()); else if (a == "--synthetic-format-change") fmt_change = std::atof(next().c_str());
    else if (a == "--help" || a == "-h") { usage(); return 0; }
    else { usage(); jl::fatal("usage", "unknown option " + a, 2); }
  }
  if ((channels != 2 && channels != 8 && channels != 16) || (bits != 16 && bits != 32) || queue < 2 || stats_ms < 100 || detect < 0 || stall_ms < -1 || fmt_change < 0) jl::fatal("usage", "invalid --channels/--sample-bits/--queue-frames/--stats-interval/--detect-timeout", 2);
  if (!find_mode(mode)) jl::fatal("usage", "unknown --mode " + mode, 2);
  if (list) {
#ifdef HAVE_DECKLINK
    return dl::Source::list();
#else
    jl::fatal("no-decklink", "built without the DeckLink SDK (set DECKLINK_SDK_DIR and rebuild)", 3);
#endif
  }
#ifndef HAVE_DECKLINK
  if (!synthetic) jl::fatal("no-decklink", "built without the DeckLink SDK (set DECKLINK_SDK_DIR and rebuild); use --synthetic", 3);
#endif
  struct sigaction sa; std::memset(&sa, 0, sizeof sa); sa.sa_handler = on_signal; sigemptyset(&sa.sa_mask);
  sigaction(SIGTERM, &sa, nullptr); sigaction(SIGINT, &sa, nullptr); signal(SIGPIPE, SIG_IGN);

  Pipeline pl;
  std::shared_ptr<Sink> primary;  // single-output mode only
  if (serve) {
    if (output != "-") jl::fatal("usage", "--serve and --output are exclusive", 2);
    serve_control(pl, size_t(queue), stall_ms < 0 ? 2000 : stall_ms);
  } else {
    int fd = 1;
    if (output != "-") { fd = ::open(output.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644); if (fd < 0) jl::fatal("output-open-failed", "cannot open " + output, 6); }
    else if (isatty(1)) jl::fatal("usage", "refusing to write Matroska to a terminal; pipe stdout into ffmpeg or pass --output FILE", 2);
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    primary = std::make_shared<Sink>("stdout", fd, size_t(queue), stall_ms < 0 ? 0 : stall_ms, fd != 1);
    pl.add_sink(primary);
  }
  std::unique_ptr<Synthetic> synth;
#ifdef HAVE_DECKLINK
  dl::Source src;
  if (!synthetic) src.open({device, mode, channels, bits}, &pl);
#endif
  const int64_t t_begin = mono_ns(); int64_t next_stats = t_begin + int64_t(stats_ms) * 1000000; int exit_code = 0; long long last_real = 0;
  std::string state = "waiting-signal"; StreamConfig active; int64_t t_run = 0;

  auto start_pipeline = [&](StreamConfig c, const char* why) {
    active = c; pl.start(c); state = "running"; t_run = mono_ns();
    jl::event("started", jl::Obj().str("mode", c.mode_name).i("width", c.width).i("height", c.height).i("fps_num", c.fr_num).i("fps_den", c.fr_den).b("interlaced", c.interlaced)
      .i("audio_channels", c.audio_channels).i("audio_bits", c.audio_bits).str("pixel_format", "uyvy422").str("reason", why));
  };
  if (synthetic) {
    start_pipeline(config_for(*find_mode(synth_mode.empty() ? mode : synth_mode), channels, bits), "synthetic");
    Synthetic::Opts so; so.impulse = impulse; if (!loss.empty()) { double at = 0, len = 0; char kind[16] = ""; if (std::sscanf(loss.c_str(), "%lf:%lf:%15s", &at, &len, kind) >= 2) { so.loss_at = at; so.loss_for = len; so.loss_nosignal = std::strcmp(kind, "nosignal") == 0; } }
    synth.reset(new Synthetic(pl, active, so)); synth->start();
    jl::event("device", jl::Obj().str("name", "synthetic").i("index", -1));
  }

  while (!g_stop) {
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
    int64_t now = mono_ns();
#ifdef HAVE_DECKLINK
    if (!synthetic && !pl.started() && (src.signal_seen || now - t_begin > int64_t(detect * 1e9))) start_pipeline(src.config(), src.signal_seen ? "signal-detected" : "detect-timeout-filler");
    if (!synthetic && src.format_changed) { jl::emit(jl::Obj().str("type", "error").str("code", "format-changed").str("message", "input format changed to " + src.changed_to + "; restart the session to re-negotiate").i("exit", 5).done()); exit_code = 5; break; }
#endif
    if (synthetic && fmt_change > 0 && t_run && now - t_run > int64_t(fmt_change * 1e9)) { jl::emit(jl::Obj().str("type", "error").str("code", "format-changed").str("message", "input format changed (synthetic); restart the session to re-negotiate").i("exit", 5).done()); exit_code = 5; break; }
    if (primary && primary->finished()) {
      if (primary->reason() == "closed") { jl::event("stdout-closed"); break; }
      jl::emit(jl::Obj().str("type", "error").str("code", "write-failed").str("message", "write to the output failed").i("exit", 6).done()); exit_code = 6; break;
    }
    if (serve) for (auto& s : pl.reap()) jl::event("consumer-detached", s->stats().str("reason", s->reason()));
    if (duration > 0 && t_run && now - t_run > int64_t(duration * 1e9)) { jl::event("duration-reached"); break; }
    if (now >= next_stats) {
      next_stats += int64_t(stats_ms) * 1000000; if (next_stats < now) next_stats = now + int64_t(stats_ms) * 1000000;
      long long real = pl.real_frames_window.exchange(0), arec = pl.audio_real_window.exchange(0), apeak = pl.audio_peak_window.exchange(0); (void)last_real;
      double dbfs = apeak > 0 ? 20.0 * std::log10(double(apeak) / 2147483648.0) : -120.0;
      double fps = double(real) * 1000.0 / stats_ms;
      jl::Obj o; o.str("type", "status").i("t_ms", jl::now_ms()).str("state", state);
      // Top-level writer numbers: the one consumer in single-output mode; in service mode the worst consumer, per-consumer detail in "consumers".
      long long fout = primary ? (long long)primary->frames_out : (long long)pl.units_out, dbp = 0, qd = 0, blk = 0, mblk = 0, bout = 0;
      if (primary) { dbp = primary->dropped_backpressure; qd = primary->queue_depth; blk = primary->blocked_now_ms; mblk = primary->max_block_ms; bout = primary->bytes_out; }
      if (pl.started()) o.str("mode", active.mode_name).i("width", active.width).i("height", active.height).f("fps_nominal", double(active.fr_num) / double(active.fr_den));
      o.f("fps", fps).b("signal_locked", pl.signal_locked).b("audio_packets", arec > 0).f("audio_peak_dbfs", dbfs).b("audio_present", dbfs > -90.0).i("frames_in", pl.frames_in).i("frames_out", fout)
       .i("filler_frames", pl.filler_frames).i("dropped_backpressure", dbp).i("dropped_late", pl.dropped_late)
       .i("audio_resyncs", pl.audio_resyncs).i("audio_dropped", pl.audio_dropped).i("queue_depth", qd).i("queue_cap", queue)
       .i("blocked_ms", blk).i("max_block_ms", mblk).i("bytes_out", bout);
      if (serve) o.raw("consumers", pl.consumers_json()).i("consumers_lost", pl.consumers_lost);
#ifdef HAVE_DECKLINK
      if (!synthetic) src.poll(o);
#endif
      jl::emit(o.done());
    }
  }
  jl::event("stopping", jl::Obj().str("reason", g_stop ? "signal" : "requested"));
  if (synth) synth->stop();
#ifdef HAVE_DECKLINK
  if (!synthetic) src.shutdown();
#endif
  pl.stop(1500);
  jl::Obj fin; fin.str("type", "exit").i("code", exit_code).i("frames_in", pl.frames_in).i("frames_out", primary ? (long long)primary->frames_out : (long long)pl.units_out).i("filler_frames", pl.filler_frames)
    .i("dropped_backpressure", primary ? (long long)primary->dropped_backpressure : 0).i("dropped_late", pl.dropped_late).i("bytes_out", primary ? (long long)primary->bytes_out : 0);
  if (serve) fin.i("consumers_lost", pl.consumers_lost);
  jl::emit(fin.done());
  return exit_code;
}
