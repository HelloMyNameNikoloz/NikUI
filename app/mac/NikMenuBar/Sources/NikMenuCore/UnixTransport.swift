import Foundation
import Darwin

public protocol ControlTransport: Sendable {
    func request(_ data: Data) async throws -> Data
    func observe(_ data: Data) -> AsyncThrowingStream<Data, any Error>
}

// All blocking socket work runs on utility tasks. The UI never blocks on I/O.
// Each connection verifies the directory/socket and the peer's UID, bounds
// frames, handles partial writes, and shuts down when its consumer cancels.
public struct UnixControlTransport: ControlTransport, Sendable {
    public let root: String
    public init(root: String) { self.root = root }
    public func request(_ data: Data) async throws -> Data {
        let holder = ConnectionHolder()
        return try await withTaskCancellationHandler {
            try await Task.detached(priority: .utility) {
                let connection = try UnixConnection(root: root, timeout: 5)
                holder.install(connection)
                defer { holder.cancel() }
                try connection.send(data)
                return try connection.line()
            }.value
        } onCancel: { holder.cancel() }
    }
    public func observe(_ data: Data) -> AsyncThrowingStream<Data, any Error> {
        AsyncThrowingStream(bufferingPolicy: .bufferingNewest(2)) { continuation in
            let holder = ConnectionHolder()
            let task = Task.detached(priority: .utility) {
                do {
                    let connection = try UnixConnection(root: root, timeout: 35)
                    holder.install(connection)
                    defer { holder.cancel() }
                    try connection.send(data)
                    while !Task.isCancelled { continuation.yield(try connection.line()) }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in holder.cancel(); task.cancel() }
        }
    }
}
private final class ConnectionHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var connection: UnixConnection?
    private var cancelled = false
    func install(_ value: UnixConnection) {
        lock.lock(); defer { lock.unlock() }
        if cancelled { value.cancel() } else { connection = value }
    }
    func cancel() {
        lock.lock(); cancelled = true; let value = connection; connection = nil; lock.unlock()
        value?.cancel()
    }
}
private final class UnixConnection: @unchecked Sendable {
    private var fd: Int32
    private var buffer = Data() // accessed by its one reader only
    init(root: String, timeout: Int) throws {
        try PrivateFiles.directory(root)
        let file = root + "/c.sock"
        let before = try PrivateFiles.entry(file, kind: S_IFSOCK, mode: 0o600)
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw MenuFailure.unavailable }
        fd = descriptor
        do {
            var interval = timeval(tv_sec: timeout, tv_usec: 0), noSignal: Int32 = 1
            guard setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size)) == 0,
                  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &interval, socklen_t(MemoryLayout<timeval>.size)) == 0,
                  setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size)) == 0 else {
                throw MenuFailure.unavailable
            }
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            let bytes = Array(file.utf8) + [UInt8(0)]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw MenuFailure.unsafe }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            let result = withUnsafePointer(to: &address) { p in
                p.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
            }
            guard result == 0 else { throw MenuFailure.unavailable }
            var uid = uid_t(0), gid = gid_t(0)
            guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { throw MenuFailure.unsafe }
            let after = try PrivateFiles.entry(file, kind: S_IFSOCK, mode: 0o600)
            guard before.st_dev == after.st_dev, before.st_ino == after.st_ino else { throw MenuFailure.unsafe }
        } catch { close(descriptor); fd = -1; throw error }
    }
    deinit { if fd >= 0 { close(fd) } }
    func cancel() { _ = shutdown(fd, SHUT_RDWR) }
    func send(_ data: Data) throws {
        guard data.count < 8192, !data.contains(10) else { throw MenuFailure.invalid }
        let frame = data + Data([10])
        try frame.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let count = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if count < 0 && errno == EINTR { continue }
                guard count > 0 else { throw MenuFailure.unavailable }; offset += count
            }
        }
    }
    func line() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: 8192)
        while true {
            if let at = buffer.firstIndex(of: 10) {
                guard at <= 262144 else { throw MenuFailure.invalid }
                let frame = Data(buffer[..<at]); buffer.removeSubrange(...at); return frame
            }
            guard buffer.count <= 262144 else { throw MenuFailure.invalid }
            let count = Darwin.read(fd, &bytes, bytes.count)
            if count < 0 && errno == EINTR { continue }
            guard count > 0 else { throw (errno == EAGAIN || errno == EWOULDBLOCK) && count < 0 ? MenuFailure.timeout : MenuFailure.unavailable }
            buffer.append(contentsOf: bytes.prefix(count))
        }
    }
}
public enum PrivateFiles {
    public static func directory(_ root: String) throws {
        guard root.hasPrefix("/"), URL(fileURLWithPath: root).standardized.path == root else { throw MenuFailure.unsafe }
        var at = ""
        for part in root.split(separator: "/") {
            at += "/" + part
            var st = stat()
            guard lstat(at, &st) == 0, st.st_mode & S_IFMT == S_IFDIR else { throw MenuFailure.unsafe }
        }
        _ = try entry(root, kind: S_IFDIR, mode: 0o700)
    }
    @discardableResult public static func entry(_ file: String, kind: mode_t, mode: mode_t) throws -> stat {
        var st = stat()
        guard lstat(file, &st) == 0 else {
            if errno == ENOENT { throw MenuFailure.unavailable }; throw MenuFailure.unsafe
        }
        guard st.st_uid == getuid(), st.st_mode & S_IFMT == kind, st.st_mode & 0o777 == mode,
              kind != S_IFREG || st.st_nlink == 1 else { throw MenuFailure.unsafe }
        return st
    }
    public static func read(_ file: String) throws -> Data {
        let before = try entry(file, kind: S_IFREG, mode: 0o600)
        let fd = open(file, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw MenuFailure.unsafe }
        defer { close(fd) }
        var opened = stat()
        guard fstat(fd, &opened) == 0, opened.st_dev == before.st_dev, opened.st_ino == before.st_ino,
              opened.st_size <= 262144 else { throw MenuFailure.unsafe }
        var data = Data(), bytes = [UInt8](repeating: 0, count: 8192)
        while true {
            let n = Darwin.read(fd, &bytes, bytes.count)
            if n < 0 && errno == EINTR { continue }
            guard n >= 0, data.count + n <= 262144 else { throw MenuFailure.unsafe }
            if n == 0 { return data }; data.append(contentsOf: bytes.prefix(n))
        }
    }
    public static func create(_ file: String, data: Data) throws {
        let fd = open(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw MenuFailure.unsafe }
        defer { close(fd) }
        try data.withUnsafeBytes { raw in
            var offset = 0
            while offset < raw.count {
                let n = Darwin.write(fd, raw.baseAddress!.advanced(by: offset), raw.count - offset)
                if n < 0 && errno == EINTR { continue }
                guard n > 0 else { throw MenuFailure.unsafe }; offset += n
            }
        }
        guard fsync(fd) == 0 else { throw MenuFailure.unsafe }
    }
}
public protocol EnrollmentStore: Sendable {
    func load() throws -> Enrollment?
    func save(_ enrollment: Enrollment) throws
}
public struct FileEnrollmentStore: EnrollmentStore, Sendable {
    public let root: String
    public init(root: String) { self.root = root }
    public func load() throws -> Enrollment? {
        try PrivateFiles.directory(root)
        do { return try JSONDecoder().decode(Enrollment.self, from: PrivateFiles.read(root + "/menu-client.json")) }
        catch MenuFailure.unavailable { return nil }
        catch { throw MenuFailure.refused("ENROLLMENT_INVALID") }
    }
    public func save(_ enrollment: Enrollment) throws {
        try PrivateFiles.directory(root)
        let file = root + "/menu-client.json"
        if let existing = try load() { guard existing == enrollment else { throw MenuFailure.refused("ENROLLMENT_INVALID") }; return }
        let temp = root + "/menu-enrollment-" + UUID().uuidString + ".json"
        defer { _ = unlink(temp) }
        try PrivateFiles.create(temp, data: JSONEncoder().encode(enrollment))
        // Publish only a complete, fsynced credential. link() refuses an
        // existing destination, including a concurrent client or symlink.
        guard link(temp, file) == 0 else { throw MenuFailure.unsafe }
        _ = unlink(temp)
        let directory = open(root, O_RDONLY | O_DIRECTORY | O_CLOEXEC)
        guard directory >= 0 else { throw MenuFailure.unsafe }
        defer { close(directory) }
        guard fsync(directory) == 0 else { throw MenuFailure.unsafe }
        guard try load() == enrollment else { throw MenuFailure.unsafe }
    }
}
