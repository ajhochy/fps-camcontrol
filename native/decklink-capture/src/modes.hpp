// SDK-free display-mode table shared by the synthetic producer and the DeckLink path (names map to bmdMode* in decklink_source.hpp).
#pragma once
#include <cstdint>
#include <cstring>
#include <string>
#include "pipeline.hpp"

struct ModeDef { const char* name; int w, h; int64_t num, den; bool interlaced; };
static const ModeDef kModes[] = {
  {"720p50", 1280, 720, 50, 1, false}, {"720p5994", 1280, 720, 60000, 1001, false}, {"720p60", 1280, 720, 60, 1, false},
  {"1080p25", 1920, 1080, 25, 1, false}, {"1080p2997", 1920, 1080, 30000, 1001, false}, {"1080p30", 1920, 1080, 30, 1, false},
  {"1080p50", 1920, 1080, 50, 1, false}, {"1080p5994", 1920, 1080, 60000, 1001, false}, {"1080p60", 1920, 1080, 60, 1, false},
  {"1080i50", 1920, 1080, 25, 1, true}, {"1080i5994", 1920, 1080, 30000, 1001, true}, {"1080i60", 1920, 1080, 30, 1, true},
};
inline const ModeDef* find_mode(const std::string& name) { for (auto& m : kModes) if (name == m.name) return &m; return nullptr; }
inline StreamConfig config_for(const ModeDef& m, int channels, int bits) {
  StreamConfig c; c.width = m.w; c.height = m.h; c.fr_num = m.num; c.fr_den = m.den; c.interlaced = m.interlaced; c.field_order = m.interlaced ? 1 : 0;
  c.audio_channels = channels; c.audio_bits = bits; c.mode_name = m.name; return c;
}
