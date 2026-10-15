// camcontrol-capture: DeckLink (or synthetic) capture -> Matroska on stdout for ONE FFmpeg process; JSON status lines on stderr.
#include <fcntl.h>
#include <signal.h>
#include <sys/stat.h>
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
    "  --synthetic [--synthetic-mode NAME] [--synthetic-loss AT:FOR[:nosignal]]   bars+tone through the same output path, no card needed\n"
    "exit codes: 0 clean, 2 usage, 3 no driver/device, 4 device busy/enable failed, 5 input format changed (restart session), 6 write failure\n");
}

int main(int argc, char** argv) {
  jl::now_ms();
  std::string device, mode = "1080p30", output = "-", synth_mode = "1080p30", loss; double detect = 3, duration = 0; int channels = 2, bits = 32, queue = 12, stats_ms = 1000;
  bool synthetic = false, list = false;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i]; auto next = [&]() -> std::string { if (i + 1 >= argc) { usage(); jl::fatal("usage", "missing value for " + a, 2); } return argv[++i]; };
    if (a == "--device") device = next(); else if (a == "--mode") mode = next(); else if (a == "--detect-timeout") detect = std::atof(next().c_str());
    else if (a == "--channels") channels = std::atoi(next().c_str()); else if (a == "--sample-bits") bits = std::atoi(next().c_str());
    else if (a == "--queue-frames") queue = std::atoi(next().c_str()); else if (a == "--duration") duration = std::atof(next().c_str());
    else if (a == "--stats-interval") stats_ms = std::atoi(next().c_str()); else if (a == "--output") output = next();
    else if (a == "--list-devices") list = true; else if (a == "--synthetic") synthetic = true;
    else if (a == "--synthetic-mode") synth_mode = next(); else if (a == "--synthetic-loss") loss = next();
    else if (a == "--help" || a == "-h") { usage(); return 0; }
    else { usage(); jl::fatal("usage", "unknown option " + a, 2); }
  }
  if ((channels != 2 && channels != 8 && channels != 16) || (bits != 16 && bits != 32) || queue < 2 || stats_ms < 100 || detect < 0) jl::fatal("usage", "invalid --channels/--sample-bits/--queue-frames/--stats-interval/--detect-timeout", 2);
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

  int fd = 1;
  if (output != "-") { fd = ::open(output.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644); if (fd < 0) jl::fatal("output-open-failed", "cannot open " + output, 6); }
  else if (isatty(1)) jl::fatal("usage", "refusing to write Matroska to a terminal; pipe stdout into ffmpeg or pass --output FILE", 2);
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);

  Pipeline pl(fd, size_t(queue));
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
    Synthetic::Opts so; if (!loss.empty()) { double at = 0, len = 0; char kind[16] = ""; if (std::sscanf(loss.c_str(), "%lf:%lf:%15s", &at, &len, kind) >= 2) { so.loss_at = at; so.loss_for = len; so.loss_nosignal = std::strcmp(kind, "nosignal") == 0; } }
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
    if (pl.epipe) { jl::event("stdout-closed"); break; }
    if (pl.write_failed) { jl::emit(jl::Obj().str("type", "error").str("code", "write-failed").str("message", "write to the output failed").i("exit", 6).done()); exit_code = 6; break; }
    if (duration > 0 && t_run && now - t_run > int64_t(duration * 1e9)) { jl::event("duration-reached"); break; }
    if (now >= next_stats) {
      next_stats += int64_t(stats_ms) * 1000000; if (next_stats < now) next_stats = now + int64_t(stats_ms) * 1000000;
      long long real = pl.real_frames_window.exchange(0), arec = pl.audio_real_window.exchange(0), apeak = pl.audio_peak_window.exchange(0); (void)last_real;
      double dbfs = apeak > 0 ? 20.0 * std::log10(double(apeak) / 2147483648.0) : -120.0;
      double fps = double(real) * 1000.0 / stats_ms;
      jl::Obj o; o.str("type", "status").i("t_ms", jl::now_ms()).str("state", state);
      if (pl.started()) o.str("mode", active.mode_name).i("width", active.width).i("height", active.height).f("fps_nominal", double(active.fr_num) / double(active.fr_den));
      o.f("fps", fps).b("signal_locked", pl.signal_locked).b("audio_packets", arec > 0).f("audio_peak_dbfs", dbfs).b("audio_present", dbfs > -90.0).i("frames_in", pl.frames_in).i("frames_out", pl.frames_out)
       .i("filler_frames", pl.filler_frames).i("dropped_backpressure", pl.dropped_backpressure).i("dropped_late", pl.dropped_late)
       .i("audio_resyncs", pl.audio_resyncs).i("audio_dropped", pl.audio_dropped).i("queue_depth", pl.queue_depth).i("queue_cap", queue)
       .i("blocked_ms", pl.blocked_now_ms).i("max_block_ms", pl.max_block_ms).i("bytes_out", pl.bytes_out);
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
  jl::Obj fin; fin.str("type", "exit").i("code", exit_code).i("frames_in", pl.frames_in).i("frames_out", pl.frames_out).i("filler_frames", pl.filler_frames)
    .i("dropped_backpressure", pl.dropped_backpressure).i("dropped_late", pl.dropped_late).i("bytes_out", pl.bytes_out);
  jl::emit(fin.done());
  if (fd != 1) ::close(fd);
  return exit_code;
}
