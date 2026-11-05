// Frame/audio pipeline between a source (DeckLink callback or synthetic producer) and its consumers (sink.hpp).
//  - Timeline: PTS = source time minus the first frame's time; audio is counter-driven from the same origin.
//  - Continuity: a watchdog emits black + silence at the nominal rate when the source stalls; frames the card flags as
//    "no input source" are replaced by black so repeated/stale content never reaches the encoder.
//  - Fan-out: every unit goes to every attached sink; each sink has its own bounded queue and writer (issue #95), so
//    backpressure or death of one consumer is that consumer's problem only. Sinks can attach/detach while capture runs.
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
#include "sink.hpp"

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

class Pipeline {
 public:
  std::atomic<long long> frames_in{0}, units_out{0}, dropped_late{0}, filler_frames{0}, audio_resyncs{0},
      audio_dropped{0}, real_frames_window{0}, audio_real_window{0}, audio_peak_window{0}, consumers_lost{0};
  std::atomic<bool> signal_locked{false}, audio_present{false};

  bool started() const { return started_.load(); }
  const StreamConfig& cfg() const { return cfg_; }
  ~Pipeline() { stop(0); }

  void start(const StreamConfig& c) {
    cfg_ = c;
    black_ = std::make_shared<std::vector<uint8_t>>(cfg_.frame_bytes());
    for (size_t i = 0; i + 1 < black_->size(); i += 2) { (*black_)[i] = 0x80; (*black_)[i + 1] = 0x10; }
    mkv::TrackInfo t; t.width = cfg_.width; t.height = cfg_.height; t.frame_ns = cfg_.frame_ns(); t.interlaced = cfg_.interlaced; t.field_order = cfg_.field_order;
    t.audio_channels = cfg_.audio_channels; t.audio_bits = cfg_.audio_bits; t.audio_rate = cfg_.audio_rate;
    if (cfg_.height <= 576) { t.matrix = 6; t.transfer = 6; t.primaries = 6; }
    { std::lock_guard<std::mutex> g(sinks_m_); header_ = mkv::header(t); for (auto& s : sinks_) s->begin(header_); started_ = true; }
    start_wall_ = mono_ns(); due_wall_ = start_wall_ + frame_wall_ns() * 5 / 2;
    watchdog_ = std::thread([this] { watchdog_loop(); });
  }

  // Attach a consumer; before the format is known it waits and gets the header when capture starts. False: duplicate id.
  bool add_sink(std::shared_ptr<Sink> s) {
    std::lock_guard<std::mutex> g(sinks_m_);
    for (auto& e : sinks_) if (e->id == s->id) return false;
    if (stopping_) return false;
    if (started_) s->begin(header_);
    sinks_.push_back(std::move(s));
    return true;
  }
  // Detach by id (drains briefly so the consumer sees a clean end of stream). Null when no such consumer.
  std::shared_ptr<Sink> detach(const std::string& id, int drain_ms = 500) {
    std::shared_ptr<Sink> s;
    { std::lock_guard<std::mutex> g(sinks_m_);
      for (auto it = sinks_.begin(); it != sinks_.end(); ++it) if ((*it)->id == id) { s = *it; sinks_.erase(it); break; } }
    if (s) s->stop(drain_ms, "detached");
    return s;
  }
  // Remove consumers whose writer has ended (closed / stalled / write-failed) and close their fds.
  std::vector<std::shared_ptr<Sink>> reap() {
    std::vector<std::shared_ptr<Sink>> out;
    { std::lock_guard<std::mutex> g(sinks_m_);
      for (auto it = sinks_.begin(); it != sinks_.end();) if ((*it)->finished()) { out.push_back(*it); it = sinks_.erase(it); } else ++it; }
    for (auto& s : out) { s->stop(0, nullptr); consumers_lost++; }
    return out;
  }
  std::shared_ptr<Sink> find(const std::string& id) {
    std::lock_guard<std::mutex> g(sinks_m_);
    for (auto& s : sinks_) if (s->id == id) return s;
    return nullptr;
  }
  std::string consumers_json() {
    std::lock_guard<std::mutex> g(sinks_m_);
    std::string a = "[";
    for (size_t i = 0; i < sinks_.size(); i++) { if (i) a += ','; a += sinks_[i]->stats().done(); }
    return a + "]";
  }
  size_t consumer_count() { std::lock_guard<std::mutex> g(sinks_m_); return sinks_.size(); }

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
    wd_cv_.notify_all();
    if (watchdog_.joinable()) watchdog_.join();
    std::vector<std::shared_ptr<Sink>> all;
    { std::lock_guard<std::mutex> g(sinks_m_); all.swap(sinks_); }
    for (auto& s : all) s->stop(drain_ms, "stopped");
  }

 private:
  StreamConfig cfg_;
  std::atomic<bool> started_{false}, stopping_{false};
  std::shared_ptr<std::vector<uint8_t>> black_; mkv::Buf header_;
  std::mutex m_; bool have_t0_ = false, filler_started_ = false; int64_t t0_abs_ = 0, wall0_ = 0, last_pts_ = -1, start_wall_ = 0, due_wall_ = 0;
  int64_t audio_samples_ = 0; bool last_locked_ = false, locked_known_ = false;
  std::mutex sinks_m_; std::vector<std::shared_ptr<Sink>> sinks_;
  std::condition_variable wd_cv_; std::thread watchdog_;

  int64_t frame_wall_ns() const { return cfg_.frame_ns(); }
  void set_locked(bool locked) {
    signal_locked = locked;
    if (!locked_known_ || locked != last_locked_) { locked_known_ = true; last_locked_ = locked; jl::event("signal", jl::Obj().b("locked", locked)); }
  }
  // Assemble the audio for the frame ending at pts+duration (real samples when present, otherwise silence) and fan out.
  void emit_unit(int64_t pts, std::shared_ptr<const std::vector<uint8_t>> video, const void* audio, size_t audio_frames) {
    const int64_t dur = cfg_.frame_ns(), rate = cfg_.audio_rate;
    const size_t fb = cfg_.audio_frame_bytes();
    auto samples_at = [&](int64_t ns) { return (ns * rate + 500000000LL) / 1000000000LL; };
    const int64_t target = samples_at(pts + dur);  // cumulative samples that should exist once this frame's audio is written
    Unit u; u.vpts = pts; u.video = std::move(video); u.apts = audio_samples_ * 1000000000LL / rate;
    auto a = std::make_shared<std::vector<uint8_t>>();
    int64_t k = int64_t(audio_frames);
    if (k > 0) {
      const int64_t slack = samples_at(dur);
      if (audio_samples_ + k > target + 2 * slack) { int64_t keep = target + 2 * slack - audio_samples_; audio_dropped += (k - keep > 0 ? k - keep : 0); k = keep > 0 ? keep : 0; audio_resyncs++; }
      a->assign(static_cast<const uint8_t*>(audio), static_cast<const uint8_t*>(audio) + size_t(k) * fb);
      if (audio_samples_ + k < target - slack) { int64_t pad = target - (audio_samples_ + k); a->resize(a->size() + size_t(pad) * fb, 0); k += pad; audio_resyncs++; }
    } else if (target > audio_samples_) { k = target - audio_samples_; a->assign(size_t(k) * fb, 0); }
    audio_samples_ += k;
    last_pts_ = pts;
    u.audio = std::move(a);
    units_out++;
    std::lock_guard<std::mutex> g(sinks_m_);
    for (auto& s : sinks_) s->push(u);
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
};
