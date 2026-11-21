import Foundation

public struct HTTPResponse: Sendable {
    public let status: Int
    public let data: Data
    public init(status: Int, data: Data) { self.status = status; self.data = data }
}
public protocol HTTPClient: Sendable { func send(_ request: URLRequest) async throws -> HTTPResponse }
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}
public struct URLSessionHTTPClient: HTTPClient {
    private let session: URLSession
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil; configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 20
        session = URLSession(configuration: configuration, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }
    public func send(_ request: URLRequest) async throws -> HTTPResponse {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw CoreFailure(.transport, "The laptop returned no HTTP response.") }
        return HTTPResponse(status: response.statusCode, data: data)
    }
}
extension PairingInvitation {
    public static func normalizeCode(_ code: String) -> String { String(code.uppercased().unicodeScalars.filter { (65...90).contains($0.value) || (48...57).contains($0.value) }) }
    public static func address(_ address: String, scheme: String? = nil) throws -> URL {
        let cleaned = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty, !cleaned.contains("\\"), !cleaned.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) else { throw CoreFailure(.invalidInput, "Enter the laptop's address.") }
        let candidate = cleaned.contains("://") ? cleaned : "\(scheme ?? "https")://\(cleaned)"
        guard var c = URLComponents(string: candidate), let host = c.host, !host.isEmpty, c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              ["http", "https"].contains(c.scheme?.lowercased() ?? ""), c.port.map({ (1...65535).contains($0) }) ?? true else { throw CoreFailure(.invalidInput, "The laptop address is invalid.") }
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
        if !cleaned.contains("://"), scheme == nil, loopback { c.scheme = "http" }
        guard c.scheme == "https" || loopback else { throw CoreFailure(.invalidInput, "Use HTTPS for a remote laptop.") }
        c.path = ""; c.query = nil; c.fragment = nil
        guard let url = c.url else { throw CoreFailure(.invalidInput, "The laptop address is invalid.") }; return url
    }
    public static func parse(_ text: String) throws -> PairingInvitation {
        guard let c = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)), let fragment = c.percentEncodedFragment else { throw CoreFailure(.invalidInput, "The pairing link has no invitation.") }
        var parts = URLComponents(); parts.percentEncodedQuery = fragment
        var values: [String: String] = [:]
        for item in parts.queryItems ?? [] {
            guard values[item.name] == nil else { throw CoreFailure(.invalidInput, "The pairing link contains duplicate fields.") }
            values[item.name] = item.value ?? ""
        }
        let code = normalizeCode(values["c"] ?? "")
        guard code.count == 8, code.allSatisfy({ "23456789ABCDEFGHJKLMNPQRSTVWXYZ".contains($0) }) else { throw CoreFailure(.invalidInput, "Enter the eight-character pairing code.") }
        let base: URL
        if c.scheme?.lowercased() == "nikui" {
            guard c.host == "pair", let h = values["h"], !h.isEmpty else { throw CoreFailure(.invalidInput, "The pairing link has no laptop address.") }
            base = try address(h, scheme: values["s"])
        } else {
            guard c.path == "/pair" else { throw CoreFailure(.invalidInput, "This is not a pairing link.") }
            var clean = c; clean.fragment = nil
            guard let url = clean.url else { throw CoreFailure(.invalidInput, "The pairing link is invalid.") }
            base = try address(url.absoluteString)
        }
        let fingerprint = values["f"].flatMap { $0.isEmpty ? nil : $0 }
        if let fingerprint { guard (try? NikCrypto.decodeBase64URL(fingerprint).count) == 16 else { throw CoreFailure(.invalidInput, "The laptop fingerprint is invalid.") } }
        return PairingInvitation(baseURL: base, code: code, fingerprint: fingerprint, laptopName: values["n"])
    }
}

public struct PairingService: Sendable {
    public static let pairingKey = "nikui.pairing.v1"
    private let key: any SigningKeyProvider
    private let store: any KeyValueStore
    private let http: any HTTPClient
    private let clock: any Clock
    public init(key: any SigningKeyProvider, store: any KeyValueStore, http: any HTTPClient = URLSessionHTTPClient(), clock: any Clock = SystemClock()) {
        self.key = key; self.store = store; self.http = http; self.clock = clock
    }
    public func pair(_ invitation: PairingInvitation, deviceName: String = "iPhone") async throws -> PairedConnection {
        try Task.checkCancellation()
        let base = try PairingInvitation.address(invitation.baseURL.absoluteString)
        let code = PairingInvitation.normalizeCode(invitation.code)
        guard code.count == 8, code.allSatisfy({ "23456789ABCDEFGHJKLMNPQRSTVWXYZ".contains($0) }) else { throw CoreFailure(.invalidInput, "Enter the eight-character pairing code.") }
        if let expected = invitation.fingerprint, (try? NikCrypto.decodeBase64URL(expected).count) != 16 { throw CoreFailure(.invalidInput, "The invitation fingerprint is invalid.") }
        let publicKey = try await key.publicSPKI(); try NikCrypto.validateSPKI(publicKey)
        let signature = try await key.sign(message: Data("nikui-pair:\(code)".utf8))
        guard signature.count == 64 else { throw CoreFailure(.crypto, "The device signature must use P1363 encoding.") }
        let name = deviceName.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        let body: JSONValue = .object(["code": .string(code), "name": .string(String((name.isEmpty ? "iPhone" : name).prefix(32))), "publicKey": .string(NikCrypto.base64URL(publicKey)), "signature": .string(NikCrypto.base64URL(signature)), "protection": .string(key.protection.rawValue), "biometric": .bool(false)])
        let data = try body.encoded()
        guard data.count <= 8192 else { throw CoreFailure(.tooLarge, "The pairing request is too large.") }
        var request = URLRequest(url: base.appendingPathComponent("pair")); request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = data
        let response: HTTPResponse
        try Task.checkCancellation()
        do { response = try await http.send(request) }
        catch { throw CoreFailure(.transport, "Pairing did not return a response. The invitation may have been spent; request a new code on the laptop.") }
        let json = try JSONValue.decode(response.data)
        guard response.status == 200 else { throw CoreFailure(response.status == 403 ? .refused : .transport, json["error"].stringValue ?? "Pairing was refused (HTTP \(response.status)).") }
        guard let id = json["device"].stringValue, !id.isEmpty, let serverKey = json["serverKey"].stringValue, let offered = json["fingerprint"].stringValue else { throw CoreFailure(.protocolViolation, "The pairing response is incomplete.") }
        let spki = try NikCrypto.decodeBase64URL(serverKey); try NikCrypto.validateSPKI(spki)
        let computed = NikCrypto.fingerprint(spki)
        guard computed == offered, invitation.fingerprint.map({ $0 == computed }) ?? true else { throw CoreFailure(.wrongLaptop, "The laptop fingerprint did not match the invitation.") }
        let record = PairedConnection(deviceID: id, baseURL: base, laptopName: invitation.laptopName ?? base.host ?? "Laptop", serverSPKI: spki, fingerprint: computed, keyID: key.keyID, publicSPKI: publicKey, protection: key.protection, pairedAt: clock.now())
        try Task.checkCancellation()
        try await store.set(WireCoding.encode(record), forKey: Self.pairingKey)
        return record
    }
    public func health(baseURL: URL) async throws -> TimeInterval {
        try await Self.health(baseURL: baseURL, http: http, clock: clock)
    }
    public static func health(baseURL: URL, http: any HTTPClient = URLSessionHTTPClient(), clock: any Clock = SystemClock()) async throws -> TimeInterval {
        let base = try PairingInvitation.address(baseURL.absoluteString); let start = clock.now()
        let response = try await http.send(URLRequest(url: base.appendingPathComponent("health")))
        guard response.status == 200, (try? JSONValue.decode(response.data)["ok"].boolValue) == true else { throw CoreFailure(.transport, "The laptop health check failed.") }
        return clock.now().timeIntervalSince(start)
    }
}
