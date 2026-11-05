// One consumer of the capture (issue #95): its own fd, bounded queue and writer thread, so a slow or dead consumer never
// blocks capture or the other consumers. Timestamps are rebased per consumer, so every attachment starts at 0 whenever it
// joins. Video is raw UYVY (every frame is a key frame), so a consumer can start on any unit.
#pragma once
#include <poll.h>
#include <unistd.h>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include "json.hpp"
#include "mkv.hpp"

inline int64_t mono_ns() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }

struct Unit { int64_t vpts = 0; std::shared_ptr<const std::vector<uint8_t>> video; int64_t apts = 0; std::shared_ptr<const std::vector<uint8_t>> audio; };

class Sink {
 public:
  const std::string id;
  std::atomic<long long> frames_out{0}, dropped_backpressure{0}, dropped_units{0}, bytes_out{0}, max_block_ms{0}, blocked_now_ms{0};
  std::atomic<int> queue_depth{0};

  // stall_ms 0 = never give up on a blocked writer (single-output mode keeps the old drop-video-only behaviour).
  Sink(std::string sink_id, int fd, size_t cap, int stall_ms, bool close_fd) : id(std::move(sink_id)), fd_(fd), cap_(cap < 2 ? 2 : cap), stall_ms_(stall_ms), close_fd_(close_fd) {}
  ~Sink() { stop(0, nullptr); }

  void begin(const mkv::Buf& header) {
    std::lock_guard<std::mutex> g(q_m_);
    if (begun_) return;
    begun_ = true; header_ = header; writer_ = std::thread([this] { writer_loop(); });
  }
  void push(const Unit& u) {
    std::lock_guard<std::mutex> g(q_m_);
    if (!begun_ || stopping_ || done_) return;
    if (q_.size() >= cap_) dropped_backpressure++;              // its video frame never reaches this consumer
    if (q_.size() >= cap_ * 2) { dropped_units++; return; }   // consumer far behind: drop the whole unit, keep memory bounded
    Unit c = u;
    if (q_.size() >= cap_) c.video.reset();                   // writer blocked: drop video, keep the audio timeline
    q_.push_back(std::move(c)); queue_depth = int(q_.size());
    q_cv_.notify_one();
  }
  bool finished() const { return done_.load(); }
  std::string reason() const { std::lock_guard<std::mutex> g(r_m_); return reason_; }

  // Drain up to drain_ms, then stop the writer and close the fd. `why` is recorded unless a failure reason already is.
  void stop(int drain_ms, const char* why) {
    bool expected = false;
    if (!stop_called_.compare_exchange_strong(expected, true)) return;
    { std::lock_guard<std::mutex> g(q_m_); stopping_ = true; }
    if (why) set_reason(why);
    if (writer_.joinable()) {
      auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(drain_ms);
      while ((queue_depth > 0 || writing_) && !done_ && std::chrono::steady_clock::now() < deadline) std::this_thread::sleep_for(std::chrono::milliseconds(10));
      abort_ = true; q_cv_.notify_all(); writer_.join();
    }
    done_ = true;
    if (close_fd_ && fd_ >= 0) { ::close(fd_); fd_ = -1; }
  }
  jl::Obj stats() const {
    jl::Obj o; o.str("id", id).i("frames_out", frames_out).i("dropped_backpressure", dropped_backpressure).i("dropped_units", dropped_units)
      .i("queue_depth", queue_depth).i("blocked_ms", blocked_now_ms).i("max_block_ms", max_block_ms).i("bytes_out", bytes_out);
    return o;
  }

 private:
  int fd_; size_t cap_; int stall_ms_; bool close_fd_;
  std::mutex q_m_; std::condition_variable q_cv_; std::deque<Unit> q_; std::thread writer_; mkv::Buf header_;
  bool begun_ = false, stopping_ = false;
  std::atomic<bool> done_{false}, abort_{false}, writing_{false}, stop_called_{false};
  mutable std::mutex r_m_; std::string reason_;
  bool have_off_ = false; int64_t off_ = 0;

  void set_reason(const char* r) { std::lock_guard<std::mutex> g(r_m_); if (reason_.empty()) reason_ = r; }
  bool write_all(const uint8_t* p, size_t n) {
    size_t off = 0; int64_t last = mono_ns();
    while (off < n) {
      ssize_t w = ::write(fd_, p + off, n - off);
      if (w > 0) { off += size_t(w); last = mono_ns(); blocked_now_ms = 0; continue; }
      if (w < 0 && errno == EINTR) continue;
      if (w < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        pollfd pf{fd_, POLLOUT, 0}; ::poll(&pf, 1, 100);
        long long b = (mono_ns() - last) / 1000000; blocked_now_ms = b; if (b > max_block_ms) max_block_ms = b;
        if (abort_) return false;
        if (stall_ms_ > 0 && b >= stall_ms_) { set_reason("stalled"); return false; }
        continue;
      }
      set_reason(w < 0 && errno == EPIPE ? "closed" : "write-failed");
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
        q_cv_.wait(lk, [&] { return !q_.empty() || stopping_ || abort_; });
        if (q_.empty() || abort_) break;
        u = std::move(q_.front()); q_.pop_front(); writing_ = true; queue_depth = int(q_.size()); }
      if (!have_off_) { off_ = u.vpts < u.apts ? u.vpts : u.apts; have_off_ = true; }
      const uint8_t* vd = u.video ? u.video->data() : nullptr; size_t vl = u.video ? u.video->size() : 0;
      const uint8_t* ad = u.audio ? u.audio->data() : nullptr; size_t al = u.audio ? u.audio->size() : 0;
      if (!mkv::build_cluster(meta, spans, u.vpts - off_, vd, vl, u.apts - off_, ad, al)) { writing_ = false; continue; }
      for (auto& s : spans) if (!(ok = write_all(s.p, s.n))) break;
      if (ok) { frames_out++; for (auto& s : spans) bytes_out += (long long)s.n; }
      writing_ = false;
    }
    writing_ = false;
    { std::lock_guard<std::mutex> g(q_m_); q_.clear(); queue_depth = 0; }
    done_ = true;
  }
};
