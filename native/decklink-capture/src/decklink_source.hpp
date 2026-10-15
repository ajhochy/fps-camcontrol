// DeckLink SDK input path. Compiled only with -DHAVE_DECKLINK and DECKLINK_SDK_DIR pointing at an unpacked SDK;
// the SDK headers/sources are never copied into this repository. The driver (DeckLinkAPI.framework) is loaded at runtime.
#pragma once
#ifdef HAVE_DECKLINK
#include <CoreFoundation/CoreFoundation.h>
#include <numeric>
#include "DeckLinkAPI.h"
#include "modes.hpp"

namespace dl {
inline std::string cfs(CFStringRef s) {
  if (!s) return "";
  char buf[256] = "";
  CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8);
  CFRelease(s);
  return buf;
}
struct ModeId { const char* name; BMDDisplayMode mode; };
static const ModeId kIds[] = {
  {"720p50", bmdModeHD720p50}, {"720p5994", bmdModeHD720p5994}, {"720p60", bmdModeHD720p60},
  {"1080p25", bmdModeHD1080p25}, {"1080p2997", bmdModeHD1080p2997}, {"1080p30", bmdModeHD1080p30},
  {"1080p50", bmdModeHD1080p50}, {"1080p5994", bmdModeHD1080p5994}, {"1080p60", bmdModeHD1080p6000},
  {"1080i50", bmdModeHD1080i50}, {"1080i5994", bmdModeHD1080i5994}, {"1080i60", bmdModeHD1080i6000},
};
inline bool mode_by_name(const std::string& n, BMDDisplayMode* out) {
  for (auto& m : kIds) if (n == m.name) { *out = m.mode; return true; }
  return false;
}
inline std::string name_of(BMDDisplayMode mode) {
  for (auto& m : kIds) if (m.mode == mode) return m.name;
  return "unsupported";
}

class Source : public IDeckLinkInputCallback {
 public:
  struct Options { std::string device = ""; std::string mode = "1080p30"; int channels = 2, bits = 32; };
  std::atomic<bool> signal_seen{false}, format_changed{false};
  std::atomic<long long> last_callback_ns{0}, callbacks{0};
  std::string changed_to;

  // Print every device (stdout JSON) for --list-devices.
  static int list() {
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) return 3;
    IDeckLink* d = nullptr; int idx = 0; std::string arr = "[";
    while (it->Next(&d) == S_OK) {
      jl::Obj o; std::string name, model; CFStringRef s = nullptr;
      if (d->GetDisplayName(&s) == S_OK) name = cfs(s);
      s = nullptr; if (d->GetModelName(&s) == S_OK) model = cfs(s);
      IDeckLinkInput* in = nullptr; bool input = d->QueryInterface(IID_IDeckLinkInput, (void**)&in) == S_OK; if (in) in->Release();
      o.i("index", idx).str("name", name).str("model", model).b("input", input);
      IDeckLinkStatus* st = nullptr;
      if (d->QueryInterface(IID_IDeckLinkStatus, (void**)&st) == S_OK) {
        bool lk = false; int64_t busy = 0;
        st->GetFlag(bmdDeckLinkStatusVideoInputSignalLocked, &lk); st->GetInt(bmdDeckLinkStatusBusy, &busy);
        o.b("signal_locked", lk).i("busy_flags", busy); st->Release();
      }
      if (idx) arr += ",";
      arr += o.done(); idx++; d->Release();
    }
    it->Release();
    std::printf("{\"type\":\"devices\",\"devices\":%s]}\n", arr.c_str());
    return 0;
  }

  // Select the device, claim the input (exits with a JSON error if it is busy) and start streams.
  // Frames are discarded until the pipeline is started by the main loop.
  void open(const Options& opt, Pipeline* pl) {
    opt_ = opt; pl_ = pl;
    BMDDisplayMode m;
    if (!mode_by_name(opt.mode, &m)) jl::fatal("bad-mode", "unsupported --mode " + opt.mode, 2);
    IDeckLinkIterator* it = CreateDeckLinkIteratorInstance();
    if (!it) jl::fatal("no-driver", "DeckLink driver (Desktop Video) is not installed or could not be loaded", 3);
    char* end = nullptr; long want = std::strtol(opt.device.c_str(), &end, 10);
    bool by_index = !opt.device.empty() && *end == 0;
    IDeckLink* d = nullptr; int idx = 0;
    while (it->Next(&d) == S_OK) {
      CFStringRef s = nullptr; std::string name;
      if (d->GetDisplayName(&s) == S_OK) name = cfs(s);
      IDeckLinkInput* in = nullptr; bool has_input = d->QueryInterface(IID_IDeckLinkInput, (void**)&in) == S_OK;
      bool pick = has_input && (opt.device.empty() || (by_index ? idx == want : name.find(opt.device) != std::string::npos));
      if (pick) { in_ = in; dl_ = d; name_ = name; break; }
      if (in) in->Release();
      d->Release(); idx++;
    }
    it->Release();
    if (!in_) jl::fatal("no-device", opt.device.empty() ? "no input-capable DeckLink device found" : "no input-capable DeckLink device matches '" + opt.device + "'", 3);
    index_ = idx;
    dl_->QueryInterface(IID_IDeckLinkStatus, (void**)&st_);
    if (busy()) jl::fatal("device-busy", "the DeckLink input is already in use by another process (capture busy)", 4, jl::Obj().str("device", name_));
    cur_mode_ = m; set_cfg_from_mode(m);
    in_->SetCallback(this);
    HRESULT hr = in_->EnableVideoInput(m, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection);
    if (hr != S_OK) {
      bool b = busy(); in_->SetCallback(nullptr);
      jl::fatal(b ? "device-busy" : "enable-video-input-failed", b ? "the DeckLink input is already in use by another process" : "EnableVideoInput failed", 4,
                jl::Obj().str("device", name_).i("hresult", (long long)(uint32_t)hr));
    }
    audio_on_ = in_->EnableAudioInput(bmdAudioSampleRate48kHz, opt.bits == 16 ? bmdAudioSampleType16bitInteger : bmdAudioSampleType32bitInteger, opt.channels) == S_OK;
    if (!audio_on_) jl::event("warning", jl::Obj().str("warning", "audio input could not be enabled; silence will be emitted"));
    hr = in_->StartStreams();
    if (hr != S_OK) { in_->DisableVideoInput(); in_->SetCallback(nullptr); jl::fatal("start-streams-failed", "StartStreams failed", 4, jl::Obj().i("hresult", (long long)(uint32_t)hr)); }
    jl::event("device", jl::Obj().str("name", name_).i("index", index_).str("pixel_format", "8bit-uyvy").b("audio_input", audio_on_));
  }
  StreamConfig config() { std::lock_guard<std::mutex> g(m_); return cfg_; }

  void poll(jl::Obj& o) {
    bool locked = false;
    HRESULT hr = st_ ? st_->GetFlag(bmdDeckLinkStatusVideoInputSignalLocked, &locked) : E_FAIL;
    o.b("device_ok", hr == S_OK).b("device_signal_locked", hr == S_OK && locked);
    int64_t dm = 0;
    if (st_ && st_->GetInt(bmdDeckLinkStatusDetectedVideoInputMode, &dm) == S_OK) o.str("detected_mode", name_of((BMDDisplayMode)dm));
    long long last = last_callback_ns.load();
    o.i("source_age_ms", last ? (mono_ns() - last) / 1000000 : -1);
  }
  void shutdown() {
    if (!in_) return;
    in_->StopStreams(); in_->DisableAudioInput(); in_->DisableVideoInput(); in_->SetCallback(nullptr);
    if (st_) st_->Release();
    in_->Release(); dl_->Release(); in_ = nullptr; st_ = nullptr; dl_ = nullptr;
  }

  HRESULT VideoInputFormatChanged(BMDVideoInputFormatChangedEvents, IDeckLinkDisplayMode* m, BMDDetectedVideoInputFormatFlags flags) override {
    BMDDisplayMode mode = m->GetDisplayMode();
    jl::event("format-detected", jl::Obj().str("mode", name_of(mode)).i("width", m->GetWidth()).i("height", m->GetHeight())
              .b("rgb444", (flags & bmdDetectedVideoInputRGB444) != 0).b("ten_bit", (flags & bmdDetectedVideoInput10BitDepth) != 0));
    if (mode == cur_mode_) return S_OK;  // only re-enable when the display mode really changes (re-enabling per callback loops)
    if (pl_->started()) { changed_to = name_of(mode); format_changed = true; return S_OK; }  // container header is fixed: session must restart
    cur_mode_ = mode; set_cfg_from_mode(mode);
    in_->PauseStreams(); in_->EnableVideoInput(mode, bmdFormat8BitYUV, bmdVideoInputEnableFormatDetection); in_->FlushStreams(); in_->StartStreams();
    return S_OK;
  }
  HRESULT VideoInputFrameArrived(IDeckLinkVideoInputFrame* v, IDeckLinkAudioInputPacket* a) override {
    callbacks++; last_callback_ns = mono_ns();
    if (!v) return S_OK;
    bool nosig = (v->GetFlags() & bmdFrameHasNoInputSource) != 0;
    if (!nosig) signal_seen = true;
    if (!pl_->started()) return S_OK;
    StreamConfig c = pl_->cfg();
    if (v->GetWidth() != c.width || v->GetHeight() != c.height) return S_OK;  // transitional frame from another mode
    BMDTimeValue t = 0, dur = 0; v->GetStreamTime(&t, &dur, 1000000000);
    void* bytes = nullptr; v->GetBytes(&bytes);
    void* abytes = nullptr; long acount = 0;
    if (a && audio_on_) { acount = a->GetSampleFrameCount(); if (acount > 0) a->GetBytes(&abytes); if (!abytes) acount = 0; }
    pl_->on_frame(int64_t(t), static_cast<const uint8_t*>(bytes), size_t(v->GetRowBytes()), nosig, abytes, size_t(acount));
    return S_OK;
  }
  HRESULT QueryInterface(REFIID, LPVOID*) override { return E_NOINTERFACE; }
  ULONG AddRef() override { return 1; }
  ULONG Release() override { return 1; }

 private:
  Options opt_; Pipeline* pl_ = nullptr; IDeckLink* dl_ = nullptr; IDeckLinkInput* in_ = nullptr; IDeckLinkStatus* st_ = nullptr;
  std::string name_; int index_ = 0; bool audio_on_ = false; BMDDisplayMode cur_mode_ = 0; std::mutex m_; StreamConfig cfg_;
  bool busy() { int64_t b = 0; return st_ && st_->GetInt(bmdDeckLinkStatusBusy, &b) == S_OK && (b & bmdDeviceCaptureBusy); }
  void set_cfg_from_mode(BMDDisplayMode mode) {
    IDeckLinkDisplayMode* dm = nullptr; StreamConfig c;
    if (in_->GetDisplayMode(mode, &dm) != S_OK) jl::fatal("bad-mode", "driver does not know this display mode", 4);
    BMDTimeValue fd = 0; BMDTimeScale ts = 0; dm->GetFrameRate(&fd, &ts);
    int64_t g = std::gcd<int64_t, int64_t>(ts, fd);
    c.width = int(dm->GetWidth()); c.height = int(dm->GetHeight()); c.fr_num = ts / g; c.fr_den = fd / g;
    BMDFieldDominance fdm = dm->GetFieldDominance();
    c.interlaced = fdm != bmdProgressiveFrame;
    c.field_order = fdm == bmdUpperFieldFirst ? 1 : fdm == bmdLowerFieldFirst ? 6 : 0;
    c.audio_channels = opt_.channels; c.audio_bits = opt_.bits; c.mode_name = name_of(mode); dm->Release();
    std::lock_guard<std::mutex> g2(m_); cfg_ = c;
  }
};
}  // namespace dl
#endif
