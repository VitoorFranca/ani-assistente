// Synthesizes each line of a text file with one engine and voice, writes one
// WAV per line and prints a JSON report: load time, time to the first audio
// and synthesis time per sentence (the app speaks sentence by sentence).
//
//   tts --engine pocket|pocket24|supertonic|chatterbox|apple --voice <name>
//       --text frases.txt --out <dir> [--models-dir <dir>]
//   tts --list-apple        pt-BR voices installed on this Mac

@preconcurrency import AVFoundation
import FluidAudio
import Foundation

struct Sentence: Encodable {
    let text: String
    let file: String
    let firstAudioMs: Double
    let synthMs: Double
    let audioSec: Double
}

struct Report: Encodable {
    let engine: String
    let voice: String
    let loadMs: Double
    let sentences: [Sentence]
}

struct Audio {
    let samples: [Float]
    let sampleRate: Int
    /// Time until the first samples existed (streaming engines), else the whole synthesis.
    let firstAudioMs: Double?
}

func ms(since start: ContinuousClock.Instant) -> Double {
    let d = ContinuousClock.now - start
    return Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15
}

func writeWav(_ samples: [Float], sampleRate: Int, to url: URL) throws {
    var data = Data()
    func put<T: FixedWidthInteger>(_ v: T) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
    let bytes = samples.count * 2
    data.append(contentsOf: Array("RIFF".utf8)); put(UInt32(36 + bytes))
    data.append(contentsOf: Array("WAVEfmt ".utf8)); put(UInt32(16)); put(UInt16(1)); put(UInt16(1))
    put(UInt32(sampleRate)); put(UInt32(sampleRate * 2)); put(UInt16(2)); put(UInt16(16))
    data.append(contentsOf: Array("data".utf8)); put(UInt32(bytes))
    for s in samples { put(Int16(max(-1, min(1, s)) * 32767)) }
    try data.write(to: url)
}

protocol Engine {
    func synthesize(_ text: String) async throws -> Audio
}

struct Pocket: Engine {
    let manager: PocketTtsManager
    let voice: String
    func synthesize(_ text: String) async throws -> Audio {
        let start = ContinuousClock.now
        var first: Double?
        var samples: [Float] = []
        for try await frame in try await manager.synthesizeStreaming(text: text, voice: voice) {
            if first == nil, !frame.samples.isEmpty { first = ms(since: start) }
            samples += frame.samples
        }
        return Audio(samples: samples, sampleRate: PocketTtsConstants.audioSampleRate, firstAudioMs: first)
    }
}

struct Supertonic: Engine {
    let manager: Supertonic3Manager
    let style: Supertonic3VoiceStyle
    func synthesize(_ text: String) async throws -> Audio {
        let out = try await manager.synthesize(text: text, language: "pt", style: style)
        return Audio(samples: out.samples, sampleRate: Supertonic3Constants.sampleRate, firstAudioMs: nil)
    }
}

struct Chatterbox: Engine {
    let manager: ChatterboxManager
    func synthesize(_ text: String) async throws -> Audio {
        let out = try await manager.synthesize(text: text, language: "pt", seed: 2026)
        return Audio(samples: out.samples, sampleRate: out.sampleRate, firstAudioMs: nil)
    }
}

/// The macOS voices, rendered to memory instead of the speakers.
final class Apple: Engine, @unchecked Sendable {
    let voice: AVSpeechSynthesisVoice
    let synth = AVSpeechSynthesizer()
    init(voice: AVSpeechSynthesisVoice) { self.voice = voice }

    func synthesize(_ text: String) async throws -> Audio {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice
        let start = ContinuousClock.now
        var first: Double?
        var samples: [Float] = []
        var rate = 22_050
        var finished = false
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            synth.write(utterance) { buffer in
                guard !finished else { return }
                guard let pcm = buffer as? AVAudioPCMBuffer, pcm.frameLength > 0 else {
                    finished = true  // an empty buffer marks the end, sometimes more than once
                    done.resume()
                    return
                }
                if first == nil { first = ms(since: start) }
                rate = Int(pcm.format.sampleRate)
                if let f = pcm.floatChannelData {
                    samples += UnsafeBufferPointer(start: f[0], count: Int(pcm.frameLength))
                } else if let i = pcm.int16ChannelData {
                    samples += UnsafeBufferPointer(start: i[0], count: Int(pcm.frameLength)).map { Float($0) / 32768 }
                }
            }
        }
        return Audio(samples: samples, sampleRate: rate, firstAudioMs: first)
    }
}

func appleVoices() -> [AVSpeechSynthesisVoice] {
    AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "pt-BR" }
}

func quality(_ v: AVSpeechSynthesisVoice) -> String {
    switch v.quality {
    case .premium: "premium"
    case .enhanced: "enhanced"
    default: "default"
    }
}

@main
struct Main {
    static func main() async throws {
        var args: [String: String] = [:]
        var it = CommandLine.arguments.dropFirst().makeIterator()
        while let key = it.next() {
            if key == "--list-apple" {
                for v in appleVoices() { print("\(v.name)\t\(quality(v))\t\(v.identifier)") }
                return
            }
            args[String(key.dropFirst(2))] = it.next()
        }
        guard let engineName = args["engine"], let voice = args["voice"], let textPath = args["text"],
            let outPath = args["out"]
        else {
            FileHandle.standardError.write("uso: tts --engine <e> --voice <v> --text <arquivo> --out <pasta>\n".data(using: .utf8)!)
            exit(2)
        }
        let modelsDir = args["models-dir"].map { URL(fileURLWithPath: $0) }
        let lines = try String(contentsOfFile: textPath, encoding: .utf8)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let out = URL(fileURLWithPath: outPath)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)

        let loadStart = ContinuousClock.now
        let engine: Engine
        switch engineName {
        case "pocket", "pocket24":
            let manager = PocketTtsManager(
                defaultVoice: voice, language: engineName == "pocket" ? .portuguese : .portuguese24L,
                directory: modelsDir)
            try await manager.initialize()
            engine = Pocket(manager: manager, voice: voice)
        case "supertonic":
            let manager = try await Supertonic3Manager.downloadAndCreate(cacheDirectory: modelsDir)
            guard let v = Supertonic3Voice(rawValue: voice) else { throw CocoaError(.featureUnsupported) }
            let style = try await Supertonic3ResourceDownloader.loadVoiceStyle(v, directory: modelsDir)
            engine = Supertonic(manager: manager, style: style)
        case "chatterbox":
            let manager = ChatterboxManager()
            try await manager.initialize()
            engine = Chatterbox(manager: manager)
        case "apple":
            guard let v = appleVoices().first(where: { $0.name == voice || $0.identifier == voice }) else {
                throw CocoaError(.featureUnsupported)
            }
            engine = Apple(voice: v)
        default:
            throw CocoaError(.featureUnsupported)
        }
        let loadMs = ms(since: loadStart)

        // Warm-up: the first call compiles or caches; the app pays it once at start.
        _ = try await engine.synthesize("Olá.")

        var sentences: [Sentence] = []
        for (i, line) in lines.enumerated() {
            let start = ContinuousClock.now
            let audio = try await engine.synthesize(line)
            let synthMs = ms(since: start)
            let file = "\(i + 1).wav"
            try writeWav(audio.samples, sampleRate: audio.sampleRate, to: out.appendingPathComponent(file))
            sentences.append(
                Sentence(
                    text: line, file: file, firstAudioMs: audio.firstAudioMs ?? synthMs, synthMs: synthMs,
                    audioSec: Double(audio.samples.count) / Double(audio.sampleRate)))
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let json = try encoder.encode(Report(engine: engineName, voice: voice, loadMs: loadMs, sentences: sentences))
        print(String(decoding: json, as: UTF8.self))
    }
}
