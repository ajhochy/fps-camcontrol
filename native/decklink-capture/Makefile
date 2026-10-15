# camcontrol-capture build (macOS arm64/x86_64, clang, C++17).
#   make                          synthetic-only binary (no SDK needed; used by CI)
#   make DECKLINK_SDK_DIR="$HOME/Developer/blackmagic-sdk/Blackmagic DeckLink SDK 14.2"
#                                 real DeckLink build. The SDK is referenced in place, never copied into this repository.
#   make test                     unit test + synthetic end-to-end (needs ffmpeg/ffprobe for the e2e part)
CXX      ?= clang++
BUILD    ?= build
CXXFLAGS ?= -O2 -std=c++17 -Wall -Wextra -Wno-unused-parameter
LDFLAGS  += -pthread
SRC      := src/main.cpp
ifdef DECKLINK_SDK_DIR
SDK_INC  := $(DECKLINK_SDK_DIR)/Mac/include
CXXFLAGS += -DHAVE_DECKLINK -I"$(SDK_INC)"
SRC      += "$(SDK_INC)/DeckLinkAPIDispatch.cpp"
LDFLAGS  += -framework CoreFoundation
endif

.PHONY: all test clean
all: $(BUILD)/camcontrol-capture
$(BUILD)/camcontrol-capture: $(wildcard src/*.hpp) src/main.cpp
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) $(SRC) -o $@ $(LDFLAGS)
$(BUILD)/mkv_test: tests/mkv_test.cpp src/mkv.hpp
	@mkdir -p $(BUILD)
	$(CXX) $(CXXFLAGS) tests/mkv_test.cpp -o $@
test: $(BUILD)/camcontrol-capture $(BUILD)/mkv_test
	$(BUILD)/mkv_test
	sh tests/synthetic_e2e.sh $(BUILD)/camcontrol-capture
clean:
	rm -rf $(BUILD)
