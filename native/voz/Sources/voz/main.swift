// voz: listens (microphone → end of speech → text) and speaks (text → voice).
//
//   voz --asr ultra|v3 --models-dir DIR [--tts apple|supertonic|pocket] [--tts-voice NAME] [--mute]
//
// Voices (bench/tts compares them): "apple" is the best installed macOS pt-BR
// voice; "supertonic" is Supertonic 3 (Supertone, OpenRAIL-M) and "pocket" is
// PocketTTS (Kyutai, CC BY 4.0), both downloaded on first use.
//
// Commands on stdin, one JSON object per line:
//   {"cmd":"listen"}                    microphone until the end of speech (or 30 s)
//   {"cmd":"listenFile","path":"…"}     same path from a WAV, at real-time pace (tests)
//   {"cmd":"cancel"}                    stop listening, nothing is transcribed
//   {"cmd":"speak","text":"…","voice":"…"?}   say it (pt-BR); {"cmd":"stopSpeaking"}
//   {"cmd":"watch","on":true|false}     wake-word mode: transcribe short utterances and report them
//                                       (the app keeps only the ones that start with the wake word)
// Events on stdout, one JSON object per line:
//   ready{loadMs,asr,tts} · listening · level{rms} · speechStart · heard{text,speechMs,asrMs} · nothing · spoken · error{message}
//   overheard{text} (watch mode only)
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

var asrName = "ultra", modelsDir = "", ttsName = "apple", ttsVoice: String? = nil, mute = false
var args = CommandLine.arguments.dropFirst().makeIterator()
while let a = args.next() {
    if a == "--asr", let v = args.next() { asrName = v }
    if a == "--models-dir", let v = args.next() { modelsDir = v }
    if a == "--tts", let v = args.next() { ttsName = v }
    if a == "--tts-voice", let v = args.next() { ttsVoice = v }
    if a == "--mute" { mute = true }  // tests: the neural voice plays at volume zero
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

    /** A new listening waits (up to 2 s) for the previous one to wind down instead of being refused. */
    private func waitIdle() async -> Bool {
        for _ in 0..<100 where busy { try? await Task.sleep(nanoseconds: 20_000_000) }
        return !busy
    }

    /** Wake-word mode: every short utterance (up to 5 s) is transcribed and reported, until cancelled. */
    func watch(chunks: AsyncStream<[Float]>) async {
        guard await waitIdle() else { return }
        busy = true
        cancelled = false
        defer { busy = false }
        var state = await vad.makeStreamState()
        let config = VadSegmentationConfig(minSilenceDuration: 0.4, maxSpeechDuration: 5)
        var preRoll: [[Float]] = []
        var utterance: [Float] = []
        var speaking = false
        for await samples in chunks {
            if cancelled { return }
            guard let result = try? await vad.processStreamingChunk(samples, state: state, config: config) else { continue }
            state = result.state
            if speaking { utterance += samples } else {
                preRoll.append(samples)
                if preRoll.count > preRollChunks { preRoll.removeFirst() }
            }
            let ended = result.event?.isEnd == true || Double(utterance.count) / sampleRate > 5
            if result.event?.isStart == true, !speaking {
                speaking = true
                utterance = preRoll.flatMap { $0 }
            } else if ended, speaking {
                speaking = false
                let audio = utterance
                utterance = []
                preRoll = []
                var decoder = TdtDecoderState.make()
                if let text = try? await asr.transcribe(audio, decoderState: &decoder, language: .portuguese).text,
                    !text.isEmpty, !cancelled
                {
                    emit(["type": "overheard", "text": text])
                }
            }
        }
    }

    /// Consumes 16 kHz mono chunks until the end of speech; returns the text (nil: no speech or cancelled).
    func listen(chunks: AsyncStream<[Float]>) async -> (text: String, speechMs: Int, asrMs: Int)? {
        guard await waitIdle() else { return nil }
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

/// One capture at a time. Each start() gets a number; stop(n) only stops that capture, and stopping ends its stream.
final class Microphone: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var generation = 0
    private var continuation: AsyncStream<[Float]>.Continuation?

    func start() throws -> (stream: AsyncStream<[Float]>, id: Int) {
        stop()
        let (stream, continuation) = AsyncStream<[Float]>.makeStream()
        lock.lock()
        generation += 1
        let id = generation
        self.continuation = continuation
        lock.unlock()
        let chunker = Chunker(continuation)
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard let converter = AVAudioConverter(from: format, to: target) else { throw NSError(domain: "voz", code: 1) }
        input.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            if let out = convert(buffer, with: converter) { chunker.push(out) }
        }
        try engine.start()
        return (stream, id)
    }

    /// Stops the current capture (or only capture `id`, if given) and ends its stream.
    func stop(_ id: Int? = nil) {
        lock.lock()
        defer { lock.unlock() }
        if let id, id != generation { return }
        guard let continuation else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        continuation.finish()
        self.continuation = nil
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

// ---- Voice ----

/// Says sentences in order; reports "spoken" when each one has finished playing.
protocol Mouth: AnyObject, Sendable {
    func speak(_ text: String, voice: String?)
    func stop()
}

/// The macOS voices (no download, instant, robotic next to the neural ones).
final class AppleMouth: NSObject, Mouth, AVSpeechSynthesizerDelegate, @unchecked Sendable {
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
        DispatchQueue.main.async { [self] in
            let utterance = AVSpeechUtterance(string: text)
            utterance.voice = voice(named: name)
            synthesizer.speak(utterance)
        }
    }
    func stop() { DispatchQueue.main.async { [self] in synthesizer.stopSpeaking(at: .immediate) } }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        emit(["type": "spoken"])
    }
    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        emit(["type": "spoken", "cancelled": true])
    }
}

/// Samples for one sentence, in pieces as they are generated (or all at once).
typealias Generate = @Sendable (String) async throws -> AsyncThrowingStream<[Float], Error>

/// A neural voice played through AVAudioEngine. Pieces are scheduled on the
/// player as soon as they exist (PocketTTS yields 80 ms frames, so a sentence
/// starts about 50 ms after it arrives). One sentence is generated at a time,
/// in order; the next one is generated while this one plays.
final class NeuralMouth: Mouth, @unchecked Sendable {
    private let generate: Generate
    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format: AVAudioFormat
    private let lock = NSLock()
    private var queue: [String] = []
    private var worker: Task<Void, Never>?
    /// Bumped by stop(): buffers and reports from an older generation are dropped.
    private var generation = 0
    /// Sentences generated but not yet heard to the end.
    private var playing = 0

    init(sampleRate: Int, mute: Bool, generate: @escaping Generate) throws {
        self.generate = generate
        format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1)!
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        if mute { engine.mainMixerNode.outputVolume = 0 }
        try engine.start()
    }

    func speak(_ text: String, voice _: String?) {
        lock.lock()
        queue.append(text)
        let idle = worker == nil
        if idle { worker = Task { await self.drain() } }
        lock.unlock()
    }

    private func next() -> (String, Int)? {
        lock.lock()
        defer { lock.unlock() }
        guard !queue.isEmpty else {
            worker = nil
            return nil
        }
        return (queue.removeFirst(), generation)
    }

    private func current(_ gen: Int) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return gen == generation
    }

    private func drain() async {
        while let (text, gen) = next() {
            if !engine.isRunning { try? engine.start() }
            player.play()
            var last: AVAudioPCMBuffer?
            do {
                for try await samples in try await generate(text) {
                    guard current(gen) else { break }
                    guard let buffer = pcm(samples) else { continue }
                    if let last { player.scheduleBuffer(last, completionHandler: nil) }
                    last = buffer
                }
            } catch {
                emit(["type": "error", "message": "voz: \(error.localizedDescription)"])
            }
            guard current(gen) else { continue }
            if let last {
                // The last frame tells when the whole sentence has been heard.
                lock.withLock { playing += 1 }
                player.scheduleBuffer(last, completionCallbackType: .dataPlayedBack) { [self] _ in
                    guard current(gen) else { return }
                    lock.withLock { playing -= 1 }
                    emit(["type": "spoken"])
                }
            } else {
                emit(["type": "spoken"])
            }
        }
    }

    private func pcm(_ samples: [Float]) -> AVAudioPCMBuffer? {
        guard !samples.isEmpty,
            let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))
        else { return nil }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        return buffer
    }

    func stop() {
        lock.lock()
        let busy = worker != nil || !queue.isEmpty || playing > 0
        generation += 1
        queue.removeAll()
        playing = 0
        lock.unlock()
        player.stop()
        if busy { emit(["type": "spoken", "cancelled": true]) }
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
/// The requested voice, or the macOS one when it cannot load (the app still talks).
func loadMouth(_ name: String, voice requested: String?, directory: URL?, mute: Bool) async -> (Mouth, String) {
    let models = directory?.appendingPathComponent("tts")
    do {
        switch name {
        case "pocket":
            let voice = requested ?? "alba"
            let manager = PocketTtsManager(defaultVoice: voice, language: .portuguese, directory: models)
            try await manager.initialize()
            _ = try await manager.synthesize(text: "Olá.")  // warm-up: the first call pays the compile
            let mouth = try NeuralMouth(sampleRate: PocketTtsConstants.audioSampleRate, mute: mute) { text in
                let frames = try await manager.synthesizeStreaming(text: text, voice: voice)
                return AsyncThrowingStream { continuation in
                    let task = Task {
                        do {
                            for try await frame in frames { continuation.yield(frame.samples) }
                            continuation.finish()
                        } catch { continuation.finish(throwing: error) }
                    }
                    continuation.onTermination = { _ in task.cancel() }
                }
            }
            return (mouth, "pocket")
        case "supertonic":
            guard let voice = Supertonic3Voice(rawValue: requested ?? "M1") else { throw CocoaError(.featureUnsupported) }
            let manager = try await Supertonic3Manager.downloadAndCreate(cacheDirectory: models)
            let style = try await Supertonic3ResourceDownloader.loadVoiceStyle(voice, directory: models)
            _ = try await manager.synthesize(text: "Olá.", language: "pt", style: style)
            let mouth = try NeuralMouth(sampleRate: Supertonic3Constants.sampleRate, mute: mute) { text in
                // About 90 ms for a whole sentence: no need to stream it.
                let samples = try await manager.synthesize(text: text, language: "pt", style: style).samples
                return AsyncThrowingStream { $0.yield(samples); $0.finish() }
            }
            return (mouth, "supertonic")
        default:
            return (AppleMouth(), "apple")
        }
    } catch {
        emit(["type": "error", "message": "voz neural indisponível, usando a do macOS: \(error.localizedDescription)"])
        return (AppleMouth(), "apple")
    }
}
let (mouth, ttsLoaded) = await loadMouth(ttsName, voice: ttsVoice, directory: directory, mute: mute)
let microphone = Microphone()
emit(["type": "ready", "loadMs": Int(Date().timeIntervalSince(started) * 1000), "asr": asrName, "tts": ttsLoaded])

func hear(_ chunks: AsyncStream<[Float]>, capture: Int? = nil) {
    Task {
        if let heard = await ears.listen(chunks: chunks) {
            emit(["type": "heard", "text": heard.text, "speechMs": heard.speechMs, "asrMs": heard.asrMs])
        } else {
            emit(["type": "nothing"])
        }
        if let capture { microphone.stop(capture) }
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
        let command = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cmd = command["cmd"] as? String
    else { return }
    switch cmd {
    case "listen":
        do {
            let capture = try microphone.start()
            hear(capture.stream, capture: capture.id)
        } catch { emit(["type": "error", "message": "microfone: \(error.localizedDescription)"]) }
    case "listenFile":
        do { hear(try fileChunks(command["path"] as? String ?? "")) } catch { emit(["type": "error", "message": "arquivo: \(error.localizedDescription)"]) }
    case "watch":
        if command["on"] as? Bool == true {
            do {
                let capture = try microphone.start()
                Task {
                    await ears.watch(chunks: capture.stream)
                    microphone.stop(capture.id)
                }
            } catch { emit(["type": "error", "message": "microfone: \(error.localizedDescription)"]) }
        } else {
            Task { await ears.cancel() }
            microphone.stop()
        }
    case "watchFile":
        do {
            let chunks = try fileChunks(command["path"] as? String ?? "")
            Task { await ears.watch(chunks: chunks) }
        } catch { emit(["type": "error", "message": "arquivo: \(error.localizedDescription)"]) }
    case "cancel":
        Task { await ears.cancel() }
        microphone.stop()
    case "speak":
        mouth.speak(command["text"] as? String ?? "", voice: command["voice"] as? String)
    case "stopSpeaking":
        mouth.stop()
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
