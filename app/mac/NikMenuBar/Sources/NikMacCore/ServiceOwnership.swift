import Foundation
import NikMacIdentity

public struct ServiceOwner: Equatable {
    public let pid: Int
    public let generation: String
    public init(pid: Int, generation: String) { self.pid = pid; self.generation = generation }
    public func matches(job: String) -> Bool {
        pid > 0 && job.range(of: "(?m)^\\s*pid = \(pid)$", options: .regularExpression) != nil
    }
    /// A KeepAlive process may serve c.sock before launchd publishes its PID.
    /// Require two stable, independently checked samples before signalling.
    public static func wait(sample: () throws -> ServiceOwner?, pause: () -> Void = { Thread.sleep(forTimeInterval: 0.1) },
                            now: () -> Date = Date.init, timeout: TimeInterval = 25) throws -> ServiceOwner {
        let deadline = now().addingTimeInterval(timeout)
        var previous: ServiceOwner?
        repeat {
            let current = try sample()
            if let current, current == previous { return current }
            previous = current
            pause()
        } while now() < deadline
        throw IdentityFailure("SERVICE_OWNER_MISMATCH")
    }
}
