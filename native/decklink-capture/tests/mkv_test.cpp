// SDK-free unit test for the Matroska writer: EBML size/ID encoding, header layout, cluster size accounting and timecodes.
#include <cstdio>
#include <cstdlib>
#include "../src/mkv.hpp"
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::fprintf(stderr, "FAIL %s:%d %s\n", __FILE__, __LINE__, #c); failures++; } } while (0)
static mkv::Buf cat(const std::vector<mkv::Span>& s) { mkv::Buf b; for (auto& x : s) b.insert(b.end(), x.p, x.p + x.n); return b; }
int main() {
  { mkv::Buf b; mkv::put_size(b, 0); CHECK(b.size() == 1 && b[0] == 0x80); }
  { mkv::Buf b; mkv::put_size(b, 126); CHECK(b.size() == 1 && b[0] == 0xFE); }
  { mkv::Buf b; mkv::put_size(b, 127); CHECK(b.size() == 2 && b[0] == 0x40 && b[1] == 0x7F); }  // 0x7F is reserved as unknown in 1 byte, so 2 bytes
  { mkv::Buf b; mkv::put_size(b, 4 * 1024 * 1024); CHECK(b.size() == 4 && (b[0] & 0xF0) == 0x10); }
  { mkv::Buf b; mkv::put_unknown_size(b); CHECK(b.size() == 8 && b[0] == 0x01 && b[7] == 0xFF); }
  { mkv::Buf b; mkv::elem_uint(b, 0xE7, 300); CHECK(b.size() == 4 && b[0] == 0xE7 && b[1] == 0x82 && b[2] == 0x01 && b[3] == 0x2C); }
  { mkv::Buf b; mkv::put_id(b, 0x1A45DFA3); CHECK(b.size() == 4 && b[0] == 0x1A && b[3] == 0xA3); }
  mkv::TrackInfo t; mkv::Buf h = mkv::header(t);
  CHECK(h.size() > 100 && h[0] == 0x1A && h[1] == 0x45 && h[2] == 0xDF && h[3] == 0xA3);
  std::string hs(h.begin(), h.end());
  CHECK(hs.find("matroska") != std::string::npos && hs.find("V_MS/VFW/FOURCC") != std::string::npos && hs.find("A_PCM/INT/LIT") != std::string::npos && hs.find("UYVY") != std::string::npos);
  size_t seg = hs.find(std::string("\x18\x53\x80\x67\x01\xFF\xFF\xFF\xFF\xFF\xFF\xFF", 12)); CHECK(seg != std::string::npos);
  // cluster: video at 1.000000 s, audio 3 ms earlier
  std::vector<uint8_t> v(100, 7), a(40, 9); mkv::Buf meta; std::vector<mkv::Span> spans;
  CHECK(mkv::build_cluster(meta, spans, 1000000000LL, v.data(), v.size(), 997000000LL, a.data(), a.size()));
  mkv::Buf c = cat(spans);
  CHECK(c[0] == 0x1F && c[1] == 0x43 && c[2] == 0xB6 && c[3] == 0x75);
  size_t p = 4; uint8_t first = c[p]; int n = 1; while (!(first & (0x80 >> (n - 1)))) n++;
  uint64_t size = first & (0xFF >> n); for (int i = 1; i < n; i++) size = (size << 8) | c[p + i]; p += n;
  CHECK(size == c.size() - p);
  CHECK(c[p] == 0xE7 && c[p + 1] == 0x83);  // Timecode 100000 ticks (10 us) = 0x0186A0 -> 3-byte payload
  mkv::Buf none; std::vector<mkv::Span> s2; CHECK(!mkv::build_cluster(none, s2, 0, nullptr, 0, 0, nullptr, 0));
  // audio-only cluster after a dropped video frame keeps its own timecode
  CHECK(mkv::build_cluster(meta, spans, 0, nullptr, 0, 500000000LL, a.data(), a.size()) && spans.size() == 2);
  if (failures) { std::fprintf(stderr, "%d failure(s)\n", failures); return 1; }
  std::printf("mkv_test: ok\n"); return 0;
}
