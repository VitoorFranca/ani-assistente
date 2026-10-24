// voz: listens (microphone → end of speech → text) and speaks (text → voice).
//
//   voz --asr ultra|v3 --models-dir DIR
//
// Commands on stdin, one JSON object per line:
//   {"cmd":"listen"}                    microphone until the end of speech (or 30 s)
//   {"cmd":"listenFile","path":"…"}     same path from a WAV, at real-time pace (tests)
//   {"cmd":"cancel"}                    stop listening, nothing is transcribed
//   {"cmd":"speak","text":"…","voice":"…"?}   say it (pt-BR); {"cmd":"stopSpeaking"}
// Events on stdout, one JSON object per line:
//   ready{loadMs} · listening · level{rms} · speechStart · heard{text,speechMs,asrMs} · nothing · spoken · error{message}
// Audio never leaves this process: nothing is written to disk or sent anywhere.
@preconcurrency import AVFoundation
import FluidAudio
import Foundation

let sampleRate = 16_000.0
let chunk = VadManager.chunkSize  // 4096 samples = 256 ms
let preRollChunks = 2  // keep ~0.5 s before the detected start
let maxSeconds = 30.0
let noSpeechSeconds = 8.0

func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    FileHandle.standardOutput.write(data + Data([0x0A]))
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message, "fatal": true])
    exit(1)
}

// ---- Arguments and models ----

var asrName = "ultra", modelsDir = ""
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--asr", let v = args.next() { asrName = v }
    if a == "--models-dir", let v = args.next() { modelsDir = v }
}

/// Speech in, text out: VAD to find the utterance, Parakeet to transcribe it.
actor Ears {
    let vad: VadManager
    let asr: AsrManager
    private var cancelled = false
    private var busy = false

    init(vad: VadManager, asr: AsrManager) {
        self.vad = vad
        self.asr = asr
    }

    func cancel() { cancelled = true }

    /// Consumes 16 kHz mono chunks until the end of speech; returns the text (nil: no speech or cancelled).
    func listen(chunks: AsyncStream<[Float]>) async -> (text: String, speechMs: Int, asrMs: Int)? {
        guard !busy else { return nil }
        busy = true
        cancelled = false
        defer { busy = false }
        emit(["type": "listening"])
        var state = await vad.makeStreamState()
        let config = VadSegmentationConfig(minSilenceDuration: 0.6, maxSpeechDuration: maxSeconds)
        var preRoll: [[Float]] = []
        var utterance: [Float] = []
        var speaking = false
        var seen = 0
        for await samples in chunks {
            if cancelled { return nil }
            seen += samples.count
            let rms = sqrt(samples.reduce(0) { $0 + $1 * $1 } / Float(max(samples.count, 1)))
            emit(["type": "level", "rms": Double(rms)])
            guard let result = try? await vad.processStreamingChunk(samples, state: state, config: config) else { continue }
            state = result.state
            if speaking {
                utterance += samples
            } else {
                preRoll.append(samples)
                if preRoll.count > preRollChunks { preRoll.removeFirst() }
            }
            if let event = result.event {
                if event.isStart, !speaking {
                    speaking = true
                    utterance = preRoll.flatMap { $0 }
                    emit(["type": "speechStart"])
                } else if event.isEnd, speaking {
                    break
                }
            }
            if !speaking, Double(seen) / sampleRate > noSpeechSeconds { return nil }
            if Double(utterance.count) / sampleRate > maxSeconds { break }
        }
        if cancelled || utterance.isEmpty { return nil }
        let started = Date()
        do {
            var decoder = TdtDecoderState.make()
            let result = try await asr.transcribe(utterance, decoderState: &decoder, language: .portuguese)
            let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : (text, Int(Double(utterance.count) / sampleRate * 1000), Int(Date().timeIntervalSince(started) * 1000))
        } catch {
            emit(["type": "error", "message": "transcrição: \(error.localizedDescription)"])
            return nil
        }
    }
}

// ---- Audio sources: microphone or file, both as 16 kHz mono chunks ----

let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!

/// Re-chunks converted audio into VAD-sized blocks.
final class Chunker: @unchecked Sendable {
    private var pending: [Float] = []
    private let continuation: AsyncStream<[Float]>.Continuation
    init(_ continuation: AsyncStream<[Float]>.Continuation) { self.continuation = continuation }
    func push(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0] else { return }
        pending += UnsafeBufferPointer(start: data, count: Int(buffer.frameLength))
        while pending.count >= chunk {
            continuation.yield(Array(pending.prefix(chunk)))
            pending.removeFirst(chunk)
        }
    }
    func finish() { continuation.finish() }
}

func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter) -> AVAudioPCMBuffer? {
    let capacity = AVAudioFrameCount(Double(buffer.frameLength) * sampleRate / buffer.format.sampleRate + 64)
    guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
    var given = false
    var error: NSError?
    converter.convert(to: out, error: &error) { _, status in
        if given { status.pointee = .noDataNow; return nil }
        given = true
        status.pointee = .haveData
        return buffer
    }
    return error == nil ? out : nil
}

final class Microphone: @unchecked Sendable {
    private let engine = AVAudioEngine()
    func start() throws -> AsyncStream<[Float]> {
        let (stream, continuation) = AsyncStream<[Float]>.makeStream()
        let chunker = Chunker(continuation)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: format, to: target) else { throw NSError(domain: "voz", code: 1) }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            if let out = convert(buffer, with: converter) { chunker.push(out) }
        }
        try engine.start()
        continuation.onTermination = { [weak self] _ in self?.stop() }
        return stream
    }
    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }
}

/// A WAV file fed at real-time pace, so the timing matches the microphone path.
func fileChunks(_ path: String) throws -> AsyncStream<[Float]> {
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    guard let converter = AVAudioConverter(from: file.processingFormat, to: target),
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))
    else { throw NSError(domain: "voz", code: 2) }
    try file.read(into: buffer)
    guard let all = convert(buffer, with: converter), let data = all.floatChannelData?[0] else { throw NSError(domain: "voz", code: 3) }
    // Two seconds of silence after the file, like a person stopping to talk.
    let samples = Array(UnsafeBufferPointer(start: data, count: Int(all.frameLength))) + [Float](repeating: 0, count: Int(sampleRate * 2))
    return AsyncStream { continuation in
        Task {
            var offset = 0
            while offset < samples.count {
                let end = min(offset + chunk, samples.count)
                var block = Array(samples[offset..<end])
                if block.count < chunk { block += [Float](repeating: 0, count: chunk - block.count) }
                continuation.yield(block)
                offset = end
                try? await Task.sleep(nanoseconds: UInt64(Double(chunk) / sampleRate * 1_000_000_000))
            }
            continuation.finish()
        }
    }
}

// ---- Voice (macOS speech synthesis) ----

final class Mouth: NSObject, AVSpeechSynthesizerDelegate, @unchecked Sendable {
    private let synthesizer = AVSpeechSynthesizer()
    override init() {
        super.init()
        synthesizer.delegate = self
    }
    /// The best installed pt-BR voice (premium, then enhanced), unless one is named.
    func voice(named name: String?) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "pt-BR" }
        if let name, let match = voices.first(where: { $0.name == name || $0.identifier == name }) { return match }
        return voices.max { $0.quality.rawValue < $1.quality.rawValue } ?? AVSpeechSynthesisVoice(language: "pt-BR")
    }
    func speak(_ text: String, voice name: String?) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = voice(named: name)
        synthesizer.speak(utterance)
    }
    func stop() { synthesizer.stopSpeaking(at: .immediate) }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit(["type": "spoken"])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        emit(["type": "spoken", "cancelled": true])
    }
}

// ---- Main loop ----

let started = Date()
let version: AsrModelVersion = asrName == "v3" ? .v3 : .ultra
let directory = modelsDir.isEmpty ? nil : URL(fileURLWithPath: modelsDir)
let ears: Ears
do {
    let vad = try await VadManager()
    let models = try await AsrModels.downloadAndLoad(to: directory, version: version)
    let asr = AsrManager()
    try await asr.loadModels(models)
    ears = Ears(vad: vad, asr: asr)
} catch {
    fail("não consegui carregar os modelos de voz: \(error.localizedDescription)")
}
let mouth = Mouth()
let microphone = Microphone()
emit(["type": "ready", "loadMs": Int(Date().timeIntervalSince(started) * 1000), "asr": asrName])

func hear(_ chunks: AsyncStream<[Float]>) {
    Task {
        if let heard = await ears.listen(chunks: chunks) {
            emit(["type": "heard", "text": heard.text, "speechMs": heard.speechMs, "asrMs": heard.asrMs])
        } else {
            emit(["type": "nothing"])
        }
        microphone.stop()
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = command["cmd"] as? String
    else { return }
    switch cmd {
    case "listen":
        do { hear(try microphone.start()) } catch { emit(["type": "error", "message": "microfone: \(error.localizedDescription)"]) }
    case "listenFile":
        do { hear(try fileChunks(command["path"] as? String ?? "")) } catch { emit(["type": "error", "message": "arquivo: \(error.localizedDescription)"]) }
    case "cancel":
        Task { await ears.cancel() }
        microphone.stop()
    case "speak":
        DispatchQueue.main.async { mouth.speak(command["text"] as? String ?? "", voice: command["voice"] as? String) }
    case "stopSpeaking":
        DispatchQueue.main.async { mouth.stop() }
    default:
        emit(["type": "error", "message": "comando desconhecido: \(cmd)"])
    }
}

// stdin is read on its own thread; the main actor stays suspended below, so the
// main queue is free for speech synthesis, which reports there.
Thread {
    while let line = readLine() { handle(line) }
    exit(0)  // the app closed our stdin
}.start()
while true { try? await Task.sleep(for: .seconds(3600)) }
