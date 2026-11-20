import Foundation
import Observation
import NikCore

/// All grammar, authority, loopback, and code rules belong to NikCore.
enum PairingLink {
    static func parse(_ text: String) -> PairingInvitation? { try? PairingInvitation.parse(text) }
    static func manual(address: String, code: String, fingerprint: String? = nil) -> PairingInvitation? {
        guard let base = try? PairingInvitation.address(address),
              var link = URLComponents(url: base.appendingPathComponent("pair"), resolvingAgainstBaseURL: false) else { return nil }
        var fragment = URLComponents()
        fragment.queryItems = [URLQueryItem(name: "c", value: PairingInvitation.normalizeCode(code))]
        if let fingerprint, !fingerprint.isEmpty { fragment.queryItems?.append(URLQueryItem(name: "f", value: fingerprint)) }
        link.percentEncodedFragment = fragment.percentEncodedQuery
        guard let text = link.url?.absoluteString else { return nil }
        return try? PairingInvitation.parse(text)
    }
    static func normalizeCode(_ code: String) -> String { PairingInvitation.normalizeCode(code) }
}

/// Keeps one-shot attempt state when the lock/scene gate recreates PairingView.
struct PairingAttempt: Hashable {
    let endpoint: URL
    let code: String
    let fingerprint: String?
    init(_ invitation: PairingInvitation) {
        endpoint = invitation.baseURL; code = invitation.code; fingerprint = invitation.fingerprint
    }
}
@MainActor @Observable final class PairingAttempts {
    private(set) var attempted: Set<PairingAttempt> = []
    private(set) var errors: [PairingAttempt: String] = [:]
    func begin(_ key: PairingAttempt) { attempted.insert(key) }
    func failed(_ key: PairingAttempt, reason: String) { errors[key] = reason }
}
