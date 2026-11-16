// Synthetic producer: colour bars + a moving frame-position marker + 440 Hz (L) / 1 kHz (R) tone, pushed through the SAME
// Pipeline/Matroska path as the card. Optional signal-loss simulation exercises the filler and no-input-source handling.
#pragma once
#include <cmath>
#include "pipeline.hpp"

class Synthetic {
 public:
  struct Opts { double loss_at = -1, loss_for = 0; bool loss_nosignal = false; bool impulse = false; };  // seconds after start; stall = no callbacks, nosignal = flagged frames
  Synthetic(Pipeline& p, const StreamConfig& c, Opts o) : p_(p), c_(c), o_(o) {}
  void start() { th_ = std::thread([this] { run(); }); }
  void stop() { stop_ = true; if (th_.joinable()) th_.join(); }
  ~Synthetic() { stop(); }

 private:
  Pipeline& p_; StreamConfig c_; Opts o_; std::atomic<bool> stop_{false}; std::thread th_;
  static void px(uint8_t* d, int x, uint8_t y0, uint8_t u, uint8_t y1, uint8_t v) { d[x * 2] = u; d[x * 2 + 1] = y0; d[x * 2 + 2] = v; d[x * 2 + 3] = y1; }
  void run() {
    static const uint8_t bars[8][3] = {{235, 128, 128}, {210, 16, 146}, {170, 166, 16}, {145, 54, 34}, {106, 202, 222}, {81, 90, 240}, {41, 240, 110}, {16, 128, 128}};
    const int W = c_.width, H = c_.height; const size_t row = size_t(W) * 2;
    std::vector<uint8_t> base(c_.frame_bytes()), frame;
    for (int y = 0; y < H; y++) for (int x = 0; x < W; x += 2) {
      uint8_t* r = base.data() + y * row;
      if (y < H * 7 / 8) { auto& b = bars[x * 8 / W]; px(r, x, b[0], b[1], b[0], b[2]); } else px(r, x, 16, 128, 16, 128);
    }
    const int64_t rate = c_.audio_rate; const size_t fb = c_.audio_frame_bytes();
    const int64_t t0 = mono_ns(); int64_t n = 0; const int64_t period = (2 * c_.fr_num + c_.fr_den / 2) / c_.fr_den; const size_t frame_bytes = c_.frame_bytes();
    auto pts_of = [&](int64_t k) { return k * 1000000000LL * c_.fr_den / c_.fr_num; };
    while (!stop_) {
      int64_t now = mono_ns() - t0;
      int64_t due = pts_of(n);
      if (now < due) { std::this_thread::sleep_for(std::chrono::nanoseconds(std::min<int64_t>(due - now, 2000000))); continue; }
      if (now - due > 3 * c_.frame_ns()) { n = now * c_.fr_num / (1000000000LL * c_.fr_den); due = pts_of(n); }  // hardware clock keeps running: skip ahead, never replay
      double sec = double(now) / 1e9;
      bool in_loss = o_.loss_at >= 0 && sec >= o_.loss_at && sec < o_.loss_at + o_.loss_for;
      if (!in_loss || o_.loss_nosignal) {
        const bool flash = o_.impulse && n % period == 0;
        if (o_.impulse) {  // issue #68 timing source: black picture, one white flash frame + 5 ms 1 kHz click every ~2 s, burnt-in 24-bit frame counter
          frame.assign(frame_bytes, 0); for (size_t i = 0; i + 1 < frame.size(); i += 2) { frame[i] = 128; frame[i + 1] = flash ? 235 : 16; }
          const int bw = (W / 32) & ~1;
          for (int bit = 0; bit < 24; bit++) if ((n >> (23 - bit)) & 1) for (int y = 0; y < 48; y++) for (int x = bit * bw; x < (bit + 1) * bw; x += 2) px(frame.data() + y * row, x, flash ? 16 : 235, 128, flash ? 16 : 235, 128);
          if (flash) jl::event("impulse", jl::Obj().i("n", n).i("pts_ns", pts_of(n)));
        } else {
        frame = base; int mx = int((n * 16) % (W - 32)) & ~1; int y0 = H * 7 / 8 + 4;
        for (int y = y0; y < H - 4; y++) for (int x = mx; x < mx + 32; x += 2) px(frame.data() + y * row, x, 235, 128, 235, 128);
        }
        int64_t s0 = (pts_of(n) * rate + 500000000LL) / 1000000000LL, s1 = (pts_of(n + 1) * rate + 500000000LL) / 1000000000LL;
        std::vector<uint8_t> audio(size_t(s1 - s0) * fb);
        for (int64_t i = 0; i < s1 - s0; i++) for (int ch = 0; ch < c_.audio_channels; ch++) {
          double hz = ch == 0 ? 440.0 : ch == 1 ? 1000.0 : 0.0; double v = hz > 0 ? 0.5 * std::sin(2.0 * M_PI * hz * double(s0 + i) / double(rate)) : 0.0;
          if (o_.impulse) v = (flash && ch < 2 && i < rate / 200) ? 0.8 * std::cos(2.0 * M_PI * 1000.0 * double(i) / double(rate)) : 0.0;
          uint8_t* d = audio.data() + (size_t(i) * c_.audio_channels + ch) * (c_.audio_bits / 8);
          if (c_.audio_bits == 32) { int32_t s = int32_t(v * 2147483647.0); std::memcpy(d, &s, 4); } else { int16_t s = int16_t(v * 32767.0); std::memcpy(d, &s, 2); }
        }
        p_.on_frame(pts_of(n), frame.data(), row, in_loss, in_loss ? nullptr : audio.data(), in_loss ? 0 : size_t(s1 - s0));
      }
      n++;
    }
  }
};
