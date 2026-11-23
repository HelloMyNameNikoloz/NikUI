import Foundation
import Darwin
import NikMacIdentity

/// Owns only children started by this app. Nonblocking reads also bound a pipe
/// inherited by a grandchild after the immediate child exits.
public final class BoundedProcess: @unchecked Sendable {
    private final class Registry: @unchecked Sendable {
        let lock = NSLock()
        var children: [UUID: BoundedProcess] = [:]
        func set(_ id: UUID, _ child: BoundedProcess?) { lock.lock(); defer { lock.unlock() }; children[id] = child }
        func cancelAll() {
            lock.lock(); let values = Array(children.values); lock.unlock()
            for child in values { child.cancel() }
        }
    }
    private static let registry = Registry()
    private let id = UUID(), lock = NSLock(), process = Process()
    private var cancelled = false
    public static func cancelAll() { registry.cancelAll() }
    public init() {}
    public func cancel() {
        lock.lock(); defer { lock.unlock() }; cancelled = true
        if process.isRunning { _ = Darwin.kill(process.processIdentifier, SIGKILL) }
    }
    public func run(executable: URL, arguments: [String], environment: [String: String], input: Data = Data(), timeout: TimeInterval, progress: Bool = false) async throws -> Data {
        try await withTaskCancellationHandler {
            try await Task.detached(priority: .userInitiated) { [self] in
                try execute(executable: executable, arguments: arguments, environment: environment, input: input, timeout: timeout, requireSuccess: false, progress: progress)
            }.value
        } onCancel: { self.cancel() }
    }
    public func runSynchronous(executable: URL, arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> Data {
        try execute(executable: executable, arguments: arguments, environment: environment, input: Data(), timeout: timeout, requireSuccess: true, progress: false)
    }
    public func runSynchronousResult(executable: URL, arguments: [String], environment: [String: String], timeout: TimeInterval) throws -> (data: Data, status: Int32) {
        let data = try execute(executable: executable, arguments: arguments, environment: environment, input: Data(), timeout: timeout,
                               requireSuccess: false, progress: false, captureErrors: true)
        return (data, process.terminationStatus)
    }
    /// Capture bounded combined stdout/stderr and the actual exit status even
    /// when the command fails. The idle preflight emits no selected secrets.
    public func runResult(executable: URL, arguments: [String], environment: [String: String], timeout: TimeInterval) async throws -> (data: Data, status: Int32) {
        try await withTaskCancellationHandler {
            try await Task.detached(priority: .userInitiated) { [self] in
                let data = try execute(executable: executable, arguments: arguments, environment: environment, input: Data(), timeout: timeout,
                                       requireSuccess: false, progress: false, captureErrors: true)
                return (data, process.terminationStatus)
            }.value
        } onCancel: { self.cancel() }
    }
    private func execute(executable: URL, arguments: [String], environment: [String: String], input: Data, timeout: TimeInterval, requireSuccess: Bool, progress: Bool, captureErrors: Bool = false) throws -> Data {
        let output = Pipe(), stdin = Pipe()
        process.executableURL = executable; process.arguments = arguments; process.environment = environment
        process.standardInput = stdin; process.standardOutput = output
        if captureErrors { process.standardError = output } else { process.standardError = FileHandle.nullDevice }
        lock.lock()
        do {
            guard !cancelled else { throw IdentityFailure("CUTOVER_CANCELLED") }
            Self.registry.set(id, self); try process.run(); lock.unlock()
        } catch { lock.unlock(); Self.registry.set(id, nil); throw error }
        defer {
            cancel(); Self.registry.set(id, nil)
            try? output.fileHandleForReading.close(); try? output.fileHandleForWriting.close()
            try? stdin.fileHandleForWriting.close(); try? stdin.fileHandleForReading.close()
        }
        guard input.count <= 65536 else { throw IdentityFailure("CUTOVER_REQUEST_INVALID") }
        // Requests are a few hundred bytes; nonblocking stdin prevents a child
        // that never reads from retaining the operation thread indefinitely.
        let inputFD = stdin.fileHandleForWriting.fileDescriptor
        _ = fcntl(inputFD, F_SETNOSIGPIPE, 1)
        _ = fcntl(inputFD, F_SETFL, O_NONBLOCK)
        let written = input.withUnsafeBytes { Darwin.write(inputFD, $0.baseAddress, $0.count) }
        guard written == input.count else { throw IdentityFailure("CUTOVER_INPUT_UNAVAILABLE") }
        try stdin.fileHandleForWriting.close()
        let descriptor = output.fileHandleForReading.fileDescriptor
        _ = fcntl(descriptor, F_SETFL, O_NONBLOCK)
        var deadline = ProcessInfo.processInfo.systemUptime + timeout
        var data = Data(), frames = Data(), sequence = 0, buffer = [UInt8](repeating: 0, count: 8192)
        do {
            while true {
                lock.lock(); let wasCancelled = cancelled; lock.unlock()
                guard !wasCancelled else { throw IdentityFailure("CUTOVER_CANCELLED") }
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw IdentityFailure("CUTOVER_TIMEOUT") }
                let count = Darwin.read(descriptor, &buffer, buffer.count)
                if count > 0 {
                    if progress {
                        frames.append(contentsOf: buffer.prefix(count))
                        while let newline = frames.firstIndex(of: 10) {
                            let line = Data(frames[..<newline]); frames.removeSubrange(...newline)
                            if let value = try? JSONSerialization.jsonObject(with: line) as? [String: Int],
                               value.count == 1, let next = value["cutoverProgress"], next > sequence {
                                sequence = next; deadline = ProcessInfo.processInfo.systemUptime + timeout
                            } else { data.append(line); data.append(10) }
                        }
                    } else { data.append(contentsOf: buffer.prefix(count)) }
                    guard data.count + frames.count <= 1024 * 1024 else { throw IdentityFailure("CUTOVER_REPLY_TOO_LARGE") }
                } else if !process.isRunning {
                    if requireSuccess && process.terminationStatus != 0 { throw IdentityFailure("CUTOVER_PROCESS_FAILED") }
                    data.append(frames); return data
                }
                else if count < 0 && errno != EAGAIN && errno != EINTR { throw IdentityFailure("CUTOVER_OUTPUT_UNAVAILABLE") }
                Thread.sleep(forTimeInterval: 0.01)
            }
        } catch let error as IdentityFailure {
            guard captureErrors else { throw error }
            throw IdentityFailure(error.code, diagnostics: [
                "output": String(decoding: data.prefix(16384), as: UTF8.self),
                "exitStatus": process.isRunning ? "running" : String(process.terminationStatus)])
        }
    }
}
