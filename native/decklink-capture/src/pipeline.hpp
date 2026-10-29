// Frame/audio pipeline between a source (DeckLink callback or synthetic producer) and the Matroska writer on stdout.
//  - Timeline: PTS = source time minus the first frame's time; audio is counter-driven from the same origin.
//  - Continuity: a watchdog emits black + silence at the nominal rate when the source stalls; frames the card flags as
//    "no input source" are replaced by black so repeated/stale content never reaches the encoder.
//  - Backpressure: bounded queue; when the writer is blocked, video is dropped (counted) before memory grows.
#pragma once
#include <poll.h>
#include <unistd.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "json.hpp"
#include "mkv.hpp"

struct StreamConfig {
  int width = 1920, height = 1080;
  int64_t fr_num = 30, fr_den = 1;  // frames per second = fr_num / fr_den
  bool interlaced = false; int field_order = 0;
  int audio_channels = 2, audio_bits = 32, audio_rate = 48000;
  std::string mode_name = "1080p30";
  int64_t frame_ns() const { return (1000000000LL * fr_den + fr_num / 2) / fr_num; }
  size_t frame_bytes() const { return size_t(width) * height * 2; }
  size_t audio_frame_bytes() const { return size_t(audio_channels) * (audio_bits / 8); }
};

inline int64_t mono_ns() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

class Pipeline {
 public:
  struct Unit { int64_t vpts = 0; std::shared_ptr<const std::vector<uint8_t>> video; int64_t apts = 0; std::vector<uint8_t> audio; };
  std::atomic<long long> frames_in{0}, frames_out{0}, dropped_backpressure{0}, dropped_late{0}, filler_frames{0}, audio_resyncs{0},
      audio_dropped{0}, bytes_out{0}, real_frames_window{0}, audio_real_window{0}, audio_peak_window{0}, max_block_ms{0}, blocked_now_ms{0};
  std::atomic<bool> epipe{false}, write_failed{false}, signal_locked{false}, audio_present{false};
  std::atomic<int> queue_depth{0};

  Pipeline(int fd, size_t queue_cap) : fd_(fd), cap_(queue_cap < 2 ? 2 : queue_cap) {}
  ~Pipeline() { stop(0); }
  bool started() const { return started_.load(); }
  const StreamConfig& cfg() const { return cfg_; }

  void start(const StreamConfig& c) {
    cfg_ = c;
    black_ = std::make_shared<std::vector<uint8_t>>(cfg_.frame_bytes());
    for (size_t i = 0; i + 1 < black_->size(); i += 2) { (*black_)[i] = 0x80; (*black_)[i + 1] = 0x10; }
    mkv::TrackInfo t; t.width = cfg_.width; t.height = cfg_.height; t.frame_ns = cfg_.frame_ns(); t.interlaced = cfg_.interlaced; t.field_order = cfg_.field_order;
    t.audio_channels = cfg_.audio_channels; t.audio_bits = cfg_.audio_bits; t.audio_rate = cfg_.audio_rate;
    if (cfg_.height <= 576) { t.matrix = 6; t.transfer = 6; t.primaries = 6; }
    header_ = mkv::header(t);
    start_wall_ = mono_ns(); due_wall_ = start_wall_ + frame_wall_ns() * 5 / 2;
    started_ = true;
    writer_ = std::thread([this] { writer_loop(); });
    watchdog_ = std::thread([this] { watchdog_loop(); });
  }

  // Called by the source for every frame the card (or the synthetic producer) delivers. `abs_pts_ns` is the source clock.
  void on_frame(int64_t abs_pts_ns, const uint8_t* data, size_t rowbytes, bool nosignal, const void* audio, size_t audio_frames) {
    if (!started_ || stopping_) return;
    std::lock_guard<std::mutex> g(m_);
    int64_t now = mono_ns();
    if (!have_t0_) { t0_abs_ = filler_started_ ? abs_pts_ns - (now - wall0_) : abs_pts_ns; have_t0_ = true; }
    int64_t pts = abs_pts_ns - t0_abs_;
    frames_in++;
    if (pts < 0 || pts <= last_pts_) { dropped_late++; return; }
    due_wall_ = now + frame_wall_ns() * 5 / 2;
    set_locked(!nosignal);
    std::shared_ptr<const std::vector<uint8_t>> video;
    if (nosignal || !data) { video = black_; filler_frames++; }
    else {
      auto v = std::make_shared<std::vector<uint8_t>>(cfg_.frame_bytes());
      const size_t row = size_t(cfg_.width) * 2;
      if (rowbytes == row) std::memcpy(v->data(), data, v->size()); else for (int y = 0; y < cfg_.height; y++) std::memcpy(v->data() + y * row, data + y * rowbytes, row);
      video = v; real_frames_window++;
    }
    const bool real_audio = audio && audio_frames > 0 && !nosignal;
    if (real_audio) {
      audio_real_window++;
      long long peak = audio_peak_window.load(); const size_t n = audio_frames * size_t(cfg_.audio_channels);
      if (cfg_.audio_bits == 32) { const int32_t* a = static_cast<const int32_t*>(audio); for (size_t i = 0; i < n; i++) { long long v = a[i] < 0 ? -(long long)a[i] : a[i]; if (v > peak) peak = v; } }
      else { const int16_t* a = static_cast<const int16_t*>(audio); for (size_t i = 0; i < n; i++) { long long v = (a[i] < 0 ? -(long long)a[i] : a[i]) << 16; if (v > peak) peak = v; } }
      audio_peak_window = peak;
    }
    emit_unit(pts, video, real_audio ? audio : nullptr, real_audio ? audio_frames : 0);
  }

  void stop(int drain_ms) {
    bool expected = false;
    if (!stopping_.compare_exchange_strong(expected, true)) return;
    { std::lock_guard<std::mutex> g(q_m_); }
    wd_cv_.notify_all(); q_cv_.notify_all();
    if (watchdog_.joinable()) watchdog_.join();
    if (writer_.joinable()) {
      auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(drain_ms);
      while ((queue_depth > 0 || writing_) && std::chrono::steady_clock::now() < deadline && !write_failed && !epipe) std::this_thread::sleep_for(std::chrono::milliseconds(10));
      abort_write_ = true; q_cv_.notify_all(); writer_.join();
    }
  }

 private:
  int fd_; size_t cap_; StreamConfig cfg_;
  std::atomic<bool> started_{false}, stopping_{false}, abort_write_{false}, writing_{false};
  std::shared_ptr<std::vector<uint8_t>> black_; mkv::Buf header_;
  std::mutex m_; bool have_t0_ = false, filler_started_ = false; int64_t t0_abs_ = 0, wall0_ = 0, last_pts_ = -1, start_wall_ = 0, due_wall_ = 0;
  int64_t audio_samples_ = 0; bool last_locked_ = false, locked_known_ = false;
  std::mutex q_m_; std::condition_variable q_cv_; std::deque<Unit> q_; std::thread writer_;
  std::condition_variable wd_cv_; std::thread watchdog_;

  int64_t frame_wall_ns() const { return cfg_.frame_ns(); }
  void set_locked(bool locked) {
    signal_locked = locked;
    if (!locked_known_ || locked != last_locked_) { locked_known_ = true; last_locked_ = locked; jl::event("signal", jl::Obj().b("locked", locked)); }
  }
  // Assemble the audio for the frame ending at pts+duration (real samples when present, otherwise silence) and enqueue.
  void emit_unit(int64_t pts, std::shared_ptr<const std::vector<uint8_t>> video, const void* audio, size_t audio_frames) {
    const int64_t dur = cfg_.frame_ns(), rate = cfg_.audio_rate;
    const size_t fb = cfg_.audio_frame_bytes();
    auto samples_at = [&](int64_t ns) { return (ns * rate + 500000000LL) / 1000000000LL; };
    const int64_t target = samples_at(pts + dur);  // cumulative samples that should exist once this frame's audio is written
    Unit u; u.vpts = pts; u.video = std::move(video); u.apts = audio_samples_ * 1000000000LL / rate;
    int64_t k = int64_t(audio_frames);
    if (k > 0) {
      const int64_t slack = samples_at(dur);
      if (audio_samples_ + k > target + 2 * slack) { int64_t keep = target + 2 * slack - audio_samples_; audio_dropped += (k - keep > 0 ? k - keep : 0); k = keep > 0 ? keep : 0; audio_resyncs++; }
      u.audio.assign(static_cast<const uint8_t*>(audio), static_cast<const uint8_t*>(audio) + size_t(k) * fb);
      if (audio_samples_ + k < target - slack) { int64_t pad = target - (audio_samples_ + k); u.audio.resize(u.audio.size() + size_t(pad) * fb, 0); k += pad; audio_resyncs++; }
    } else if (target > audio_samples_) { k = target - audio_samples_; u.audio.assign(size_t(k) * fb, 0); }
    audio_samples_ += k;
    last_pts_ = pts;
    std::lock_guard<std::mutex> g(q_m_);
    if (q_.size() >= cap_) { u.video.reset(); dropped_backpressure++; }   // writer blocked: drop video, keep the audio timeline
    if (q_.size() >= cap_ * 2) { audio_dropped += int64_t(u.audio.size() / (fb ? fb : 1)); return; }
    q_.push_back(std::move(u)); queue_depth = int(q_.size());
    q_cv_.notify_one();
  }

  void watchdog_loop() {
    std::unique_lock<std::mutex> lk(m_);
    const int64_t period = frame_wall_ns();
    while (!stopping_) {
      wd_cv_.wait_for(lk, std::chrono::nanoseconds(period / 2));
      if (stopping_) break;
      int64_t now = mono_ns();
      while (now >= due_wall_ && !stopping_) {  // source stalled: keep the timeline moving at the nominal rate
        if (!filler_started_) { filler_started_ = true; wall0_ = now; if (!have_t0_) { t0_abs_ = 0; } }
        set_locked(false);
        int64_t pts = last_pts_ < 0 ? 0 : last_pts_ + period;
        filler_frames++; emit_unit(pts, black_, nullptr, 0);
        due_wall_ += period;
        if (now - due_wall_ > period * 5) due_wall_ = now;  // never burst-catch-up after a long scheduling gap
      }
    }
  }

  bool write_all(const uint8_t* p, size_t n) {
    size_t off = 0; int64_t last = mono_ns();
    while (off < n) {
      ssize_t w = ::write(fd_, p + off, n - off);
      if (w > 0) { off += size_t(w); last = mono_ns(); blocked_now_ms = 0; continue; }
      if (w < 0 && errno == EINTR) continue;
      if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        pollfd pf{fd_, POLLOUT, 0}; ::poll(&pf, 1, 100);
        long long b = (mono_ns() - last) / 1000000; blocked_now_ms = b; if (b > max_block_ms) max_block_ms = b;
        if (abort_write_) return false;
        continue;
      }
      if (w < 0 && errno == EPIPE) epipe = true; else write_failed = true;
      return false;
    }
    return true;
  }
  void writer_loop() {
    bool ok = write_all(header_.data(), header_.size());
    mkv::Buf meta; std::vector<mkv::Span> spans;
    while (ok) {
      Unit u;
      { std::unique_lock<std::mutex> lk(q_m_);
        q_cv_.wait(lk, [&] { return !q_.empty() || stopping_ || abort_write_; });
        if (q_.empty()) break;
        u = std::move(q_.front()); q_.pop_front(); writing_ = true; queue_depth = int(q_.size()); }
      const uint8_t* vd = u.video ? u.video->data() : nullptr; size_t vl = u.video ? u.video->size() : 0;
      if (!mkv::build_cluster(meta, spans, u.vpts, vd, vl, u.apts, u.audio.data(), u.audio.size())) { writing_ = false; continue; }
      for (auto& s : spans) if (!(ok = write_all(s.p, s.n))) break;
      if (ok) { frames_out++; for (auto& s : spans) bytes_out += (long long)s.n; }
      writing_ = false;
    }
    writing_ = false;
    { std::lock_guard<std::mutex> g(q_m_); q_.clear(); queue_depth = 0; }
  }
};
