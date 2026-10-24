// apple: transcribe WAV files with Apple's SpeechAnalyzer + SpeechTranscriber (macOS 26+).
//   apple --locale pt-BR [--install] file.wav…
// One JSON line per file: {"file","text","ms"}; status and errors on stderr.
import AVFoundation
import Foundation
import Speech

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

@available(macOS 26, *)
func run(localeId: String, install: Bool, files: [String]) async {
    guard SpeechTranscriber.isAvailable else { log("SpeechTranscriber indisponível"); exit(2) }
    guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: localeId)) else {
        log("locale não suportado: \(localeId)"); exit(2)
    }
    let probe = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    let status = await AssetInventory.status(forModules: [probe])
    log("locale \(locale.identifier): status \(status)")
    if status != .installed {
        guard install else { log("modelo não instalado (use --install)"); exit(3) }
        do {
            if let req = try await AssetInventory.assetInstallationRequest(supporting: [probe]) { try await req.downloadAndInstall() }
            log("modelo instalado")
        } catch { log("falha ao instalar: \(error)"); exit(3) }
    }
    for path in files {
        let started = Date()
        do {
            let module = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
            let analyzer = SpeechAnalyzer(modules: [module], options: .init(priority: .userInitiated, modelRetention: .processLifetime))
            let file = try AVAudioFile(forReading: URL(fileURLWithPath: path))
            let collector = Task { () -> String in
                var text = ""
                for try await r in module.results where r.isFinal { text += String(r.text.characters) }
                return text
            }
            if let last = try await analyzer.analyzeSequence(from: file) {
                try await analyzer.finalizeAndFinish(through: last)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            let text = try await collector.value
            emit(["file": path, "text": text.trimmingCharacters(in: .whitespacesAndNewlines), "ms": Int(Date().timeIntervalSince(started) * 1000)])
        } catch {
            emit(["file": path, "text": "", "ms": Int(Date().timeIntervalSince(started) * 1000), "error": "\(error)"])
        }
    }
}

@main struct Apple {
    static func main() async {
        var localeId = "pt-BR", install = false, files: [String] = []
        var it = CommandLine.arguments.dropFirst().makeIterator()
        while let a = it.next() {
            if a == "--locale", let v = it.next() { localeId = v } else if a == "--install" { install = true } else { files.append(a) }
        }
        if #available(macOS 26, *) { await run(localeId: localeId, install: install, files: files) } else { log("precisa do macOS 26"); exit(2) }
    }
}
