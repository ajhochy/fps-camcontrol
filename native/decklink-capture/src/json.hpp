// Tiny JSON-line helpers: status/events go to stderr, one object per line.
#pragma once
#include <chrono>
#include <cstdio>
#include <mutex>
#include <string>

namespace jl {
inline std::string esc(const std::string& s) {
  std::string o; for (unsigned char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += char(c); } else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); o += b; } else o += char(c); }
  return o;
}
class Obj {
  std::string s_ = "{"; bool first_ = true;
  void key(const char* k) { if (!first_) s_ += ','; first_ = false; s_ += '"'; s_ += k; s_ += "\":"; }
 public:
  Obj& str(const char* k, const std::string& v) { key(k); s_ += '"'; s_ += esc(v); s_ += '"'; return *this; }
  Obj& i(const char* k, long long v) { key(k); s_ += std::to_string(v); return *this; }
  Obj& f(const char* k, double v) { key(k); char b[32]; std::snprintf(b, sizeof b, "%.3f", v); s_ += b; return *this; }
  Obj& b(const char* k, bool v) { key(k); s_ += v ? "true" : "false"; return *this; }
  Obj& raw(const char* k, const std::string& v) { key(k); s_ += v; return *this; }
  std::string done() const { return s_ + "}"; }
};
inline std::mutex& mu() { static std::mutex m; return m; }
inline long long now_ms() {
  static const auto t0 = std::chrono::steady_clock::now();
  return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
}
inline void emit(const std::string& line) { std::lock_guard<std::mutex> g(mu()); std::fprintf(stderr, "%s\n", line.c_str()); std::fflush(stderr); }
inline void event(const char* name, Obj extra = Obj()) {
  std::string e = extra.done();
  std::string body = std::string("{\"type\":\"event\",\"event\":\"") + name + "\",\"t_ms\":" + std::to_string(now_ms());
  if (e.size() > 2) body += "," + e.substr(1, e.size() - 2);
  emit(body + "}");
}
[[noreturn]] inline void fatal(const char* code, const std::string& message, int exit_code, Obj extra = Obj()) {
  std::string e = extra.done();
  std::string body = std::string("{\"type\":\"error\",\"code\":\"") + code + "\",\"message\":\"" + esc(message) + "\",\"exit\":" + std::to_string(exit_code) + ",\"t_ms\":" + std::to_string(now_ms());
  if (e.size() > 2) body += "," + e.substr(1, e.size() - 2);
  emit(body + "}"); std::_Exit(exit_code);
}
}  // namespace jl
