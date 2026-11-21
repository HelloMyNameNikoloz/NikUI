import AVFoundation
import Observation
import NikCore

/// Records a short voice note as 16 kHz mono WAV for the laptop to transcribe.
@MainActor @Observable final class VoiceRecorder {
    enum Trouble: Error { case denied, failed }

    private(set) var isRecording = false
    private(set) var startedAt: Date?
    /// Set when a call or another app takes the microphone mid-recording.
    private(set) var interrupted = false
    private var observer: (any NSObjectProtocol)?
    private var recorder: AVAudioRecorder?
    private var url: URL?
    private var generation = 0
    static let limit: TimeInterval = 300

    func start() async throws {
        generation += 1
        let attempt = generation
        guard await AVAudioApplication.requestRecordPermission() else { throw Trouble.denied }
        guard attempt == generation, !Task.isCancelled else { throw CancellationError() }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
        ]
        self.url = url
        do {
            let recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder.isMeteringEnabled = true
            try FileManager.default.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            guard recorder.record(forDuration: Self.limit) else { throw Trouble.failed }
            self.recorder = recorder
        } catch {
            cleanUp(); throw error
        }
        interrupted = false
        isRecording = true; startedAt = Date()
        observer = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began
            if began { MainActor.assumeIsolated { self?.interrupted = true } }
        }
    }

    /// Stops and returns the recording, base64 encoded, or nil if it was too short.
    func finish() -> String? {
        defer { cleanUp() }
        guard let recorder, let url else { return nil }
        let seconds = recorder.currentTime
        recorder.stop()
        guard seconds >= 0.3 || (startedAt.map { Date().timeIntervalSince($0) } ?? 0) >= 0.3,
              let data = try? Data(contentsOf: url), let wav = try? WAV.canonicalPCM16(data) else { return nil }
        return wav.base64EncodedString()
    }

    func level() -> Double {
        recorder?.updateMeters()
        return min(1, max(0, pow(10, Double(recorder?.averagePower(forChannel: 0) ?? -160) / 20)))
    }

    func cancel() { generation += 1; recorder?.stop(); cleanUp() }

    private func cleanUp() {
        if let url { try? FileManager.default.removeItem(at: url) }
        recorder = nil; url = nil; isRecording = false; startedAt = nil
        if let observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}

/// A clip and its request outlive SwiftUI's privacy cover and navigation rebuilds.
@MainActor @Observable final class VoiceComposition {
    let recorder = VoiceRecorder()
    var clip: String?
    var requestID: String?
    var transcription: Task<Void, Never>?
    var selection: Range<Int>?
    var selectionText: String?
    var insertedCaret: Int?
    var sendAfterTranscription = false

    func hold() {
        sendAfterTranscription = false
        if recorder.isRecording, let audio = recorder.finish() { clip = audio }
        recorder.cancel() // Also invalidates a pending microphone-permission request.
    }

    func cancel() {
        recorder.cancel()
        transcription?.cancel(); transcription = nil
        clip = nil; requestID = nil; sendAfterTranscription = false
    }
}
