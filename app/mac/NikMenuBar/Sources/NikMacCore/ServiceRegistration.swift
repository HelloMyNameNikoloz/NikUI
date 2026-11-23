import Foundation
import NikMenuCore
import NikMacIdentity

public enum ServiceRegistration {
    public enum Action: Equatable { case register, reuse, replaceStale }
    /// Call only for an attended Start/Move (or a DEV controller command).
    /// `job` must come from a successful inventory or an exact absent reply.
    public static func action(status: LoginRegistration, job: String?) throws -> Action {
        switch status {
        case .enabled: return job == nil ? .replaceStale : .reuse
        case .requiresApproval: throw IdentityFailure("SERVICE_REQUIRES_APPROVAL")
        case .notRegistered, .notFound:
            guard job == nil else { throw IdentityFailure("SERVICE_BUNDLE_MISMATCH") }
            return .register
        case .unknown: throw IdentityFailure("SERVICE_UNAVAILABLE")
        }
    }
}
