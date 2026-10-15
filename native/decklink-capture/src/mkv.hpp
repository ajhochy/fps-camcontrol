// Minimal live-streaming Matroska (EBML) writer: unknown-size Segment, one known-size Cluster per video frame.
// SDK-free so it builds and unit-tests without any Blackmagic header. Timestamps are carried in the container
// (TimecodeScale = 10 us), which is the whole reason this transport was chosen over raw pipes.
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include <utility>
#include <vector>

namespace mkv {
using Buf = std::vector<uint8_t>;
constexpr int64_t kTimecodeScaleNs = 10000;  // one timecode tick = 10 us; SimpleBlock offset range is +-327 ms.

inline void put_id(Buf& b, uint32_t id) {
  if (id > 0xFFFFFFu) b.push_back(uint8_t(id >> 24));
  if (id > 0xFFFFu) b.push_back(uint8_t(id >> 16));
  if (id > 0xFFu) b.push_back(uint8_t(id >> 8));
  b.push_back(uint8_t(id));
}
inline int size_len(uint64_t v) { int n = 1; while (n < 8 && v >= ((1ULL << (7 * n)) - 1)) n++; return n; }
inline void put_size(Buf& b, uint64_t v) {
  int n = size_len(v); uint64_t m = v | (1ULL << (7 * n));
  for (int i = n - 1; i >= 0; i--) b.push_back(uint8_t((m >> (8 * i)) & 0xFF));
}
inline void put_unknown_size(Buf& b) { b.push_back(0x01); for (int i = 0; i < 7; i++) b.push_back(0xFF); }
inline void put_be(Buf& b, uint64_t v, int n) { for (int i = n - 1; i >= 0; i--) b.push_back(uint8_t((v >> (8 * i)) & 0xFF)); }
inline void put_le(Buf& b, uint64_t v, int n) { for (int i = 0; i < n; i++) b.push_back(uint8_t((v >> (8 * i)) & 0xFF)); }

inline void elem_uint(Buf& b, uint32_t id, uint64_t v) {
  int n = 1; while (n < 8 && (v >> (8 * n)) != 0) n++;
  put_id(b, id); put_size(b, n); put_be(b, v, n);
}
inline void elem_str(Buf& b, uint32_t id, const std::string& s) { put_id(b, id); put_size(b, s.size()); b.insert(b.end(), s.begin(), s.end()); }
inline void elem_bin(Buf& b, uint32_t id, const Buf& d) { put_id(b, id); put_size(b, d.size()); b.insert(b.end(), d.begin(), d.end()); }
inline void elem_f64(Buf& b, uint32_t id, double v) { uint64_t u; std::memcpy(&u, &v, 8); put_id(b, id); put_size(b, 8); put_be(b, u, 8); }
inline void elem_master(Buf& b, uint32_t id, const Buf& inner) { put_id(b, id); put_size(b, inner.size()); b.insert(b.end(), inner.begin(), inner.end()); }

struct TrackInfo {
  int width = 1920, height = 1080;
  int64_t frame_ns = 33333333;           // DefaultDuration of one video frame
  bool interlaced = false; int field_order = 0;  // Matroska FieldOrder: 0 progressive, 1 TFF, 6 BFF
  int audio_channels = 2, audio_bits = 32; int audio_rate = 48000;
  int matrix = 1, transfer = 1, primaries = 1;   // 1 = BT.709 (HD); 6 = SMPTE 170M (SD)
};
constexpr int kVideoTrack = 1, kAudioTrack = 2;

// EBML header + Segment (unknown size) + Info + Tracks. Everything after this is Clusters.
inline Buf header(const TrackInfo& t) {
  Buf out, e;
  elem_uint(e, 0x4286, 1); elem_uint(e, 0x42F7, 1); elem_uint(e, 0x42F2, 4); elem_uint(e, 0x42F3, 8);
  elem_str(e, 0x4282, "matroska"); elem_uint(e, 0x4287, 4); elem_uint(e, 0x4285, 2);
  elem_master(out, 0x1A45DFA3, e);
  put_id(out, 0x18538067); put_unknown_size(out);
  Buf info; elem_uint(info, 0x2AD7B1, kTimecodeScaleNs); elem_str(info, 0x4D80, "camcontrol-capture"); elem_str(info, 0x5741, "camcontrol-capture");
  elem_master(out, 0x1549A966, info);

  Buf tracks;
  { // video: raw UYVY via the VFW fourcc mapping (FFmpeg: rawvideo / uyvy422)
    Buf bmp; put_le(bmp, 40, 4); put_le(bmp, uint32_t(t.width), 4); put_le(bmp, uint32_t(t.height), 4); put_le(bmp, 1, 2); put_le(bmp, 16, 2);
    bmp.push_back('U'); bmp.push_back('Y'); bmp.push_back('V'); bmp.push_back('Y');
    put_le(bmp, uint64_t(t.width) * t.height * 2, 4); put_le(bmp, 0, 16);
    Buf colour; elem_uint(colour, 0x55B1, t.matrix); elem_uint(colour, 0x55B9, 1 /* broadcast/limited */); elem_uint(colour, 0x55BA, t.transfer); elem_uint(colour, 0x55BB, t.primaries);
    Buf video; elem_uint(video, 0x9A, t.interlaced ? 1 : 2); elem_uint(video, 0x9D, t.field_order);
    elem_uint(video, 0xB0, t.width); elem_uint(video, 0xBA, t.height); elem_master(video, 0x55B0, colour);
    Buf te; elem_uint(te, 0xD7, kVideoTrack); elem_uint(te, 0x73C5, 1); elem_uint(te, 0x83, 1); elem_uint(te, 0x9C, 0);
    elem_str(te, 0x86, "V_MS/VFW/FOURCC"); elem_uint(te, 0x23E383, uint64_t(t.frame_ns)); elem_bin(te, 0x63A2, bmp); elem_master(te, 0xE0, video);
    elem_master(tracks, 0xAE, te);
  }
  { // audio: interleaved little-endian signed PCM
    Buf audio; elem_f64(audio, 0xB5, t.audio_rate); elem_uint(audio, 0x9F, t.audio_channels); elem_uint(audio, 0x6264, t.audio_bits);
    Buf te; elem_uint(te, 0xD7, kAudioTrack); elem_uint(te, 0x73C5, 2); elem_uint(te, 0x83, 2); elem_uint(te, 0x9C, 0);
    elem_str(te, 0x86, "A_PCM/INT/LIT"); elem_master(te, 0xE1, audio);
    elem_master(tracks, 0xAE, te);
  }
  elem_master(out, 0x1654AE6B, tracks);
  return out;
}

struct Span { const uint8_t* p; size_t n; };
// One cluster = Timecode + a video SimpleBlock (optional) + an audio SimpleBlock (optional). Payloads are referenced, not copied.
// `meta` must outlive `spans` (it is reserved up front so its storage never moves).
inline int64_t to_ticks(int64_t ns) { return ns / kTimecodeScaleNs; }
inline bool build_cluster(Buf& meta, std::vector<Span>& spans, int64_t video_pts_ns, const uint8_t* vdata, size_t vlen,
                          int64_t audio_pts_ns, const uint8_t* adata, size_t alen) {
  const bool hv = vdata && vlen, ha = adata && alen;
  if (!hv && !ha) return false;
  int64_t base = hv ? to_ticks(video_pts_ns) : to_ticks(audio_pts_ns);
  meta.clear(); meta.reserve(160); spans.clear();
  struct Blk { int track; int64_t rel; uint8_t flags; size_t hdr_off, hdr_len; const uint8_t* d; size_t n; };
  Blk blks[2]; int nb = 0;
  Buf tc; elem_uint(tc, 0xE7, uint64_t(base < 0 ? 0 : base));
  uint64_t inner = tc.size();
  auto describe = [&](int track, int64_t pts_ns, const uint8_t* d, size_t n, uint8_t flags) {
    int64_t rel = to_ticks(pts_ns) - base;
    if (rel < -32768) rel = -32768; if (rel > 32767) rel = 32767;  // clamped; audio is never more than ~1 frame from its cluster
    blks[nb++] = Blk{track, rel, flags, 0, 0, d, n};
    uint64_t payload = 4 + n; inner += 1 + size_len(payload) + payload;
  };
  if (hv) describe(kVideoTrack, video_pts_ns, vdata, vlen, 0x80);
  if (ha) describe(kAudioTrack, audio_pts_ns, adata, alen, 0x80);
  put_id(meta, 0x1F43B675); put_size(meta, inner); meta.insert(meta.end(), tc.begin(), tc.end());
  for (int i = 0; i < nb; i++) {
    size_t off = meta.size();
    put_id(meta, 0xA3); put_size(meta, 4 + blks[i].n); meta.push_back(uint8_t(0x80 | blks[i].track));
    put_be(meta, uint16_t(int16_t(blks[i].rel)), 2); meta.push_back(blks[i].flags);
    blks[i].hdr_off = off; blks[i].hdr_len = meta.size() - off;
  }
  // Spans: cluster header+timecode+first block header live in meta contiguously; walk blocks in order.
  size_t cursor = 0;
  for (int i = 0; i < nb; i++) {
    spans.push_back({meta.data() + cursor, blks[i].hdr_off + blks[i].hdr_len - cursor});
    spans.push_back({blks[i].d, blks[i].n});
    cursor = blks[i].hdr_off + blks[i].hdr_len;
  }
  return true;
}
}  // namespace mkv
