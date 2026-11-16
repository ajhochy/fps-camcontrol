// AVFoundation (QuickTime engine) playability probe for the #67 proof: prints {"playable","durationS","tracks"} for one file. Developer-only.
import AVFoundation
let a = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let playable = try await a.load(.isPlayable)
    let dur = try await a.load(.duration)
    let tracks = try await a.load(.tracks)
    var kinds: [String] = []
    for t in tracks { kinds.append(t.mediaType.rawValue) }
    print("{\"playable\":\(playable),\"durationS\":\(CMTimeGetSeconds(dur)),\"tracks\":\"\(kinds.joined(separator: ","))\"}")
  } catch { print("{\"playable\":false,\"error\":\"\(String(describing: error).replacingOccurrences(of: "\"", with: "'").replacingOccurrences(of: "\n", with: " "))\"}") }
  sem.signal()
}
sem.wait()
