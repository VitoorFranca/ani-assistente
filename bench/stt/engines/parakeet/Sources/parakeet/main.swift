// parakeet: transcribe WAV files with Parakeet TDT through FluidAudio.
//   parakeet --version v3|ultra --models-dir DIR [--no-language] file.wav…
// One JSON line per file: {"file","text","ms"}; the model loads once (load time on stderr).
import FluidAudio
import Foundation

func log(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func emit(_ obj: [String: Any]) {
    let data = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

var versionName = "v3", modelsDir = "", useLanguage = true, files: [String] = []
var it = CommandLine.arguments.dropFirst().makeIterator()
while let a = it.next() {
    switch a {
    case "--version": versionName = it.next() ?? "v3"
    case "--models-dir": modelsDir = it.next() ?? ""
    case "--no-language": useLanguage = false
    default: files.append(a)
    }
}
let version: AsrModelVersion = versionName == "ultra" ? .ultra : .v3
let t0 = Date()
let models = try await AsrModels.downloadAndLoad(
    to: modelsDir.isEmpty ? nil : URL(fileURLWithPath: modelsDir), version: version)
let asr = AsrManager()
try await asr.loadModels(models)
log("modelo \(versionName) pronto em \(Int(Date().timeIntervalSince(t0) * 1000)) ms")
for path in files {
    let started = Date()
    do {
        var state = TdtDecoderState.make()
        let result = try await asr.transcribe(
            URL(fileURLWithPath: path), decoderState: &state, language: useLanguage ? .portuguese : nil)
        emit(["file": path, "text": result.text, "ms": Int(Date().timeIntervalSince(started) * 1000)])
    } catch {
        emit(["file": path, "text": "", "ms": Int(Date().timeIntervalSince(started) * 1000), "error": "\(error)"])
    }
}
