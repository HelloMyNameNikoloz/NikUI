import Foundation
import Observation
import NikCore
import NikMacIdentity

public protocol CutoverBackend: Sendable {
    func command(_ action: String, arguments: JSONValue) async throws -> JSONValue
    func cancel() async
}
public extension CutoverBackend { func cancel() async {} }
@MainActor public protocol CutoverService: AnyObject {
    func registerForCutover() async throws
    func preflightForCutover() async throws
    func start() async throws
    func stop() async throws
    func unregisterAfterHandback() async throws
    func cancelCutoverRegistration() async throws
}
public extension CutoverService {
    func cancelCutoverRegistration() async throws {}
}

/// A button-driven native orchestration layer. Constructing it has no effects.
/// Durable ownership and recovery live in the bundled coordinator, not a sheet.
@MainActor @Observable public final class MacCutoverCoordinator {
    public private(set) var review: JSONValue = .null
    public private(set) var working = false
    public private(set) var stage = "review"
    public private(set) var problem: String?
    public private(set) var problemDiagnostics: [String: String] = [:]
    public private(set) var recoveryProblem: String?
    public let installed: Bool
    @ObservationIgnored private let backend: any CutoverBackend
    @ObservationIgnored private let service: any CutoverService
    @ObservationIgnored private let disconnect: @MainActor () async -> Void
    public init(backend: any CutoverBackend, service: any CutoverService, installed: Bool,
                disconnect: @escaping @MainActor () async -> Void = {}) {
        self.backend = backend; self.service = service; self.installed = installed
        self.disconnect = disconnect
    }
    public var blockers: [String] {
        (installed ? [] : ["INSTALL_IN_APPLICATIONS_REQUIRED"]) + review["blockers"].arrayValue.compactMap(\.stringValue)
    }
    public var mayMove: Bool { !working && installed && review["ready"].boolValue == true && blockers.isEmpty }
    public func cancelOperation() async { await backend.cancel() }
    public func retryCustody() async {
        guard !working, let profile = review["profile"].stringValue else { return }
        working = true; defer { working = false }
        do {
            try requireSuccess(try await backend.command("repair-custody", arguments: .object(["profile": .string(profile)])))
            review = try await backend.command("review", arguments: .object(["profile": .string(profile)]))
            try requireSuccess(review); problem = nil
        } catch { problem = Self.code(error) }
    }
    public func recordPhoneRoute(sourceID: String) async {
        guard !working, let profile = review["profile"].stringValue else { return }
        working = true; defer { working = false }
        do {
            try requireSuccess(try await backend.command("record-phone-route", arguments: .object([
                "profile": .string(profile), "sourceID": .string(sourceID)])))
            review = try await backend.command("review", arguments: .object(["profile": .string(profile)]))
            try requireSuccess(review); problem = nil
        } catch { problem = Self.code(error) }
    }
    public func forgetReturn(_ saved: JSONValue) async {
        guard !working, let profile = review["profile"].stringValue else { return }
        working = true; defer { working = false }
        do {
            var arguments = saved.objectValue
            arguments["profile"] = .string(profile); arguments["confirmed"] = .bool(true)
            try requireSuccess(try await backend.command("forget-return", arguments: .object(arguments)))
            review = try await backend.command("review", arguments: .object(["profile": .string(profile)]))
            try requireSuccess(review); problem = nil; recoveryProblem = nil
        } catch { problem = Self.code(error) }
    }
    public func refresh(profile: String? = nil, rollback: Bool = false) async {
        guard !working else { return }; working = true; defer { working = false }
        do {
            review = try await backend.command(rollback ? "handback-review" : "review", arguments: .object(profile.map { ["profile": .string($0)] } ?? [:]))
            try requireSuccess(review); problem = nil; recoveryProblem = nil
        } catch { problem = Self.code(error) }
    }
    public func move(enroll: () async throws -> Void) async {
        guard mayMove, let profile = review["profile"].stringValue, let token = review["token"].stringValue else { return }
        working = true; defer { working = false }
        recoveryProblem = nil; problemDiagnostics = [:]
        var committed = false
        do {
            stage = "registering"; try await service.registerForCutover()
            stage = "checking engine"; try await service.preflightForCutover()
            stage = "transferring"
            try requireSuccess(try await backend.command("move", arguments: .object(["profile": .string(profile), "token": .string(token)])))
            committed = true; stage = "starting"; try await service.start()
            stage = "enrolling"; try await enroll()
            stage = "connecting editors"; try requireSuccess(try await backend.command("finish", arguments: .object([:])))
            stage = "ready"; problem = nil; recoveryProblem = nil
        } catch {
            let failure = Self.code(error)
            problemDiagnostics = (error as? IdentityFailure)?.diagnostics ?? [:]
            if committed {
                stage = "recovery required"; problem = failure
            } else if failure == "SERVICE_REQUIRES_APPROVAL" { stage = "review"; problem = failure }
            else {
                do {
                    let cancellation = try await backend.command("cancel", arguments: .object([:]))
                    guard cancellation["legacy"].boolValue == true else { throw IdentityFailure("CUTOVER_RECOVERY_REQUIRED") }
                    try await service.cancelCutoverRegistration(); stage = "review"; problem = failure
                } catch { stage = "recovery required"; problem = failure; recoveryProblem = recoveryProblem ?? Self.code(error) }
            }
        }
    }
    public func handBack() async {
        guard !working else { return }; working = true; defer { working = false }
        do { try await handbackEffects(); stage = "legacy restored"; problem = nil; recoveryProblem = nil }
        catch { stage = "recovery required"; problem = Self.code(error) }
    }
    public func restoreVSCode() async {
        guard !working else { return }; working = true; defer { working = false }
        do { try await handbackEffects(action: "restore"); stage = "legacy restored"; problem = nil; recoveryProblem = nil }
        catch { stage = "recovery required"; problem = Self.code(error) }
    }
    private func handbackEffects(action: String = "handback") async throws {
        stage = "returning current state"
        try requireSuccess(try await backend.command(action, arguments: .object([:])))
        await disconnect()
        stage = "stopping"; try await service.stop()
        stage = "unregistering"; try await service.unregisterAfterHandback()
    }
    private func requireSuccess(_ value: JSONValue) throws {
        guard value["ok"].boolValue == true else {
            recoveryProblem = value["diagnostics"]["recovery"]["code"].stringValue
            throw IdentityFailure(value["code"].stringValue ?? "CUTOVER_UNAVAILABLE")
        }
    }
    private static func code(_ error: any Error) -> String { (error as? IdentityFailure)?.code ?? MacAppSession.code(error) }
}
