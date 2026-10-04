// nikui-voice — turns one recording into text with the model VoiceInk uses.
//
//   nikui-voice check
//   nikui-voice transcribe <audio file>
//
// Answers with one line of JSON on stdout and exits. It is never left running:
// NikUI starts it when a recording arrives from the phone and it is gone the
// moment the words are back, which is how VoiceInk itself behaves.
//
// Nothing is downloaded and nothing leaves this Mac. The model is the one
// VoiceInk already fetched (Parakeet TDT 0.6B v3, run by FluidAudio on the
// Neural Engine); without it this says so rather than fetching its own.

import AVFoundation
import FluidAudio
import Foundation
import SQLite3

let home = FileManager.default.homeDirectoryForCurrentUser
let support = home.appendingPathComponent("Library/Application Support")

/// Where VoiceInk keeps the model, and where FluidAudio would on its own.
let candidates: [URL] = [
    support.appendingPathComponent("FluidAudio/Models/parakeet-tdt-0.6b-v3"),
    support.appendingPathComponent("FluidAudio/Models/parakeet-tdt-0.6b-v3-coreml"),
]

let required = ["Preprocessor.mlmodelc", "Encoder.mlmodelc", "Decoder.mlmodelc", "JointDecisionv3.mlmodelc"]

func modelDirectory() -> URL? {
    let files = FileManager.default
    return candidates.first { dir in
        required.allSatisfy { files.fileExists(atPath: dir.appendingPathComponent($0).path) }
            && (files.fileExists(atPath: dir.appendingPathComponent("parakeet_v3_vocab.json").path)
                || files.fileExists(atPath: dir.appendingPathComponent("parakeet_vocab.json").path))
    }
}

func say(_ value: [String: Any]) -> Never {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
    exit(value["ok"] as? Bool == false ? 1 : 0)
}

func fail(_ code: String, _ message: String) -> Never {
    say(["ok": false, "code": code, "error": message])
}

// ---- VoiceInk's own corrections --------------------------------------------

/// The word replacements set up in VoiceInk, read and never written. Each
/// original may list several spellings, separated by commas, as VoiceInk's
/// own editor allows.
func replacements() -> [(String, String)] {
    let base = support.appendingPathComponent("com.prakashjoshipax.VoiceInk")
    var found: [(String, String)] = []
    for name in ["dictionary.store", "default.store"] {
        let path = base.appendingPathComponent(name).path
        guard FileManager.default.fileExists(atPath: path) else { continue }
        var db: OpaquePointer?
        guard sqlite3_open_v2("file:\(path)?mode=ro", &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, nil) == SQLITE_OK
        else { sqlite3_close(db); continue }
        defer { sqlite3_close(db) }
        var row: OpaquePointer?
        let sql = "SELECT ZORIGINALTEXT, ZREPLACEMENTTEXT FROM ZWORDREPLACEMENT WHERE ZISENABLED IS NULL OR ZISENABLED != 0"
        guard sqlite3_prepare_v2(db, sql, -1, &row, nil) == SQLITE_OK else { continue }
        defer { sqlite3_finalize(row) }
        while sqlite3_step(row) == SQLITE_ROW {
            guard let a = sqlite3_column_text(row, 0), let b = sqlite3_column_text(row, 1) else { continue }
            let to = String(cString: b)
            for from in String(cString: a).split(separator: ",") {
                let word = from.trimmingCharacters(in: .whitespaces)
                if !word.isEmpty { found.append((word, to)) }
            }
        }
        if !found.isEmpty { break }
    }
    return found
}

func corrected(_ text: String) -> String {
    var out = text
    for (from, to) in replacements() {
        let pattern = "(?<![\\p{L}\\p{N}])" + NSRegularExpression.escapedPattern(for: from) + "(?![\\p{L}\\p{N}])"
        guard let rx = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { continue }
        out = rx.stringByReplacingMatches(
            in: out, range: NSRange(out.startIndex..., in: out),
            withTemplate: NSRegularExpression.escapedTemplate(for: to))
    }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
}

// ---- the two things it does ------------------------------------------------

let args = Array(CommandLine.arguments.dropFirst())

guard let command = args.first else {
    fail("USAGE", "nikui-voice check | nikui-voice transcribe <audio file>")
}

if command == "check" {
    let dir = modelDirectory()
    say([
        "ok": dir != nil,
        "model": "parakeet-tdt-0.6b-v3",
        "dir": dir?.path ?? "",
        "code": dir == nil ? "NO_MODEL" : "",
        "error": dir == nil ? "VoiceInk's Parakeet model is not on this Mac" : "",
    ])
}

guard command == "transcribe", args.count >= 2 else {
    fail("USAGE", "nikui-voice transcribe <audio file>")
}

let file = URL(fileURLWithPath: args[1])
guard FileManager.default.fileExists(atPath: file.path) else {
    fail("NO_AUDIO", "there is no recording at \(file.path)")
}
guard let dir = modelDirectory() else {
    fail("NO_MODEL", "VoiceInk's Parakeet model is not on this Mac — choose Parakeet in VoiceInk once to download it")
}

let started = Date()

do {
    let duration: Double = try {
        let audio = try AVAudioFile(forReading: file)
        return Double(audio.length) / audio.processingFormat.sampleRate
    }()
    if duration < 0.3 { say(["ok": true, "text": "", "seconds": duration, "ms": 0]) }

    let models = try AsrModels.loadLocal(from: dir, version: .v3)
    let manager = AsrManager(config: .default)
    try await manager.loadModels(models)
    var state = TdtDecoderState.make()
    let result = try await manager.transcribe(file, decoderState: &state)
    say([
        "ok": true,
        "text": corrected(result.text),
        "seconds": duration,
        "ms": Int(Date().timeIntervalSince(started) * 1000),
    ])
} catch {
    fail("FAILED", "could not transcribe: \(error.localizedDescription)")
}
