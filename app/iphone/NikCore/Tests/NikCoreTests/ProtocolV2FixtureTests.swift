import Foundation
import CryptoKit
import Testing
@testable import NikCore

// Test-only reader: fixture consistency, not runtime conformance. No v2 client
// or dispatcher is exercised here, and the corpus is never copied into SwiftPM.
private struct FixtureFailure: Error, CustomStringConvertible {
    let code: String
    let description: String
}
private func requireFixture(_ condition: Bool, _ code: String, _ message: String) throws {
    if !condition { throw FixtureFailure(code: code, description: message) }
}
private func fixtureSHA(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

private func fixtureCanonical(_ value: JSONValue) throws -> String {
    switch value {
    case .object(let fields):
        let keys = fields.keys.sorted { $0.utf16.lexicographicallyPrecedes($1.utf16) }
        return "{" + (try keys.map { key in
            try fixtureCanonical(.string(key)) + ":" + fixtureCanonical(fields[key]!)
        }).joined(separator: ",") + "}"
    case .array(let items): return "[" + (try items.map(fixtureCanonical)).joined(separator: ",") + "]"
    default:
        // The pinned corpus uses safe integers and exactly representable fractions.
        // This is deliberately not a production JSON-number canonicalizer.
        return String(decoding: try WireCoding.encode(value), as: UTF8.self)
    }
}

// Swift String equality treats composed/decomposed Unicode as equivalent.
// The wire preserves their bytes, including in reclaimed drafts and receipts.
private func fixtureBytes(_ value: JSONValue) throws -> Data {
    Data(try fixtureCanonical(value).utf8)
}

private let fixtureKeywords: Set<String> = [
    "$schema", "$defs", "$ref", "title", "description", "type", "const", "enum", "anyOf",
    "required", "properties", "additionalProperties", "items", "minItems", "maxItems",
    "uniqueItems", "minLength", "maxLength", "pattern", "minimum", "maximum",
]

// Independently implements only the JSON Schema keywords used by the shared file.
// Unsupported keywords are errors, so a new constraint cannot pass unnoticed.
private func fixtureSchemaDefinition(_ schema: JSONValue) throws {
    try requireFixture(Set(schema.objectValue.keys).isSubset(of: fixtureKeywords), "schema", "Unsupported schema keyword")
    for field in ["$defs", "properties"] {
        for child in schema[field].objectValue.values { try fixtureSchemaDefinition(child) }
    }
    for child in schema["anyOf"].arrayValue { try fixtureSchemaDefinition(child) }
    if let items = schema.objectValue["items"] { try fixtureSchemaDefinition(items) }
    if case .object = schema["additionalProperties"] { try fixtureSchemaDefinition(schema["additionalProperties"]) }
}

private func fixtureSchema(_ value: JSONValue, _ schema: JSONValue, root: JSONValue, at: String = "$") throws {
    try requireFixture(Set(schema.objectValue.keys).isSubset(of: fixtureKeywords), "schema", at + ": unsupported schema keyword")
    if let ref = schema["$ref"].stringValue {
        try requireFixture(ref.hasPrefix("#/$defs/"), "schema", at + ": nonlocal reference")
        let name = String(ref.dropFirst(8))
        guard let definition = root["$defs"].objectValue[name] else { throw FixtureFailure(code: "schema", description: "Unknown reference " + ref) }
        try fixtureSchema(value, definition, root: root, at: at)
    }
    if let options = schema.objectValue["anyOf"] {
        var matches = false
        for option in options.arrayValue {
            do { try fixtureSchema(value, option, root: root, at: at); matches = true }
            catch is FixtureFailure { }
        }
        try requireFixture(matches, "schema", at + ": no anyOf branch")
    }
    if let constant = schema.objectValue["const"] { try requireFixture(try fixtureBytes(value) == fixtureBytes(constant), "schema", at + ": const") }
    if let choices = schema.objectValue["enum"] { try requireFixture(try choices.arrayValue.contains { try fixtureBytes($0) == fixtureBytes(value) }, "schema", at + ": enum") }
    if let type = schema.objectValue["type"] {
        let types = type.stringValue.map { [$0] } ?? type.arrayValue.compactMap(\.stringValue)
        let matches = types.contains { name in
            switch (name, value) {
            case ("null", .null), ("object", .object), ("array", .array), ("string", .string), ("boolean", .bool): return true
            case ("number", .number(let n)): return n.isFinite
            case ("integer", .number(let n)): return n.isFinite && n.rounded() == n && abs(n) <= 9_007_199_254_740_991
            default: return false
            }
        }
        try requireFixture(matches, "schema", at + ": type")
    }
    switch value {
    case .object(let fields):
        for required in schema["required"].arrayValue.compactMap(\.stringValue) {
            try requireFixture(fields[required] != nil, "schema", at + ": missing " + required)
        }
        for (key, child) in fields {
            if let rule = schema["properties"].objectValue[key] { try fixtureSchema(child, rule, root: root, at: at + "." + key) }
            else {
                try requireFixture(schema["additionalProperties"].boolValue != false, "schema", at + ": extra " + key)
                if case .object = schema["additionalProperties"] { try fixtureSchema(child, schema["additionalProperties"], root: root, at: at + "." + key) }
            }
        }
    case .array(let items):
        try requireFixture(items.count >= (schema["minItems"].intValue ?? 0) && items.count <= (schema["maxItems"].intValue ?? Int.max), "schema", at + ": item count")
        if schema["uniqueItems"].boolValue == true { try requireFixture(Set(try items.map(fixtureBytes)).count == items.count, "schema", at + ": duplicate item") }
        if let rule = schema.objectValue["items"] {
            for (index, child) in items.enumerated() { try fixtureSchema(child, rule, root: root, at: at + "[\(index)]") }
        }
    case .string(let text):
        try requireFixture(text.unicodeScalars.count >= (schema["minLength"].intValue ?? 0) && text.unicodeScalars.count <= (schema["maxLength"].intValue ?? Int.max), "schema", at + ": string length")
        if let pattern = schema["pattern"].stringValue { try requireFixture(text.range(of: pattern, options: .regularExpression) != nil, "schema", at + ": pattern") }
        if schema == root["$defs"]["error"]["properties"]["message"] { try requireFixture(text.utf8.count <= 2048, "schema", at + ": error byte limit") }
        if schema == root["$defs"]["run"]["properties"]["turn"] { try requireFixture(text.utf8.count <= 256, "schema", at + ": turn byte limit") }
    case .number(let n):
        try requireFixture(n >= (schema["minimum"].doubleValue ?? -.infinity) && n <= (schema["maximum"].doubleValue ?? .infinity), "schema", at + ": range")
    default: break
    }
}

private func validateFixtureDraft(_ draft: JSONValue, schema: JSONValue) throws {
    if let attachments = draft.objectValue["attachments"] {
        try fixtureSchema(attachments, .object(["type": .string("array"), "items": .object(["$ref": .string("#/$defs/attachment")])]), root: schema)
    }
}

private func validateFixtureVector(_ vector: JSONValue, schema: JSONValue) throws {
    try fixtureSchema(vector, schema["$defs"]["vector"], root: schema)
    let id = vector["id"].stringValue!, context = vector["context"], expected = vector["expected"]
    try requireFixture((context["role"].stringValue == "fleet") == (context["target"].stringValue == "fleet"), "identity", id + ": role/target")
    try requireFixture(context["seat"]["editor"].boolValue != true || context["seat"]["local"].boolValue == true, "identity", id + ": editor must be enrolled locally")
    try validateFixtureDraft(vector["initial"]["record"]["payload"], schema: schema)
    for step in vector["input"].arrayValue {
        let message = step["message"], type = message["type"].stringValue!
        if step["direction"].stringValue == "server", let rule = schema["$defs"].objectValue["wire-" + type] ?? schema["$defs"].objectValue[type] {
            try fixtureSchema(message, rule, root: schema)
        }
        if step["direction"].stringValue == "harness" && type == "persist" { try validateFixtureDraft(message["record"]["payload"], schema: schema) }
    }
    var previous: [String: JSONValue] = [:]
    var uncertain = false
    for reply in expected["replies"].arrayValue {
        if let rule = schema["$defs"].objectValue["wire-" + reply["type"].stringValue!] { try fixtureSchema(reply, rule, root: schema) }
        switch reply["type"].stringValue {
        case "ack":
            try fixtureSchema(reply, schema["$defs"]["ack"], root: schema)
            let outcome = reply["outcome"].stringValue!, status = reply["status"].stringValue!, admitted = reply["admitted"].boolValue!
            let result = reply["result"], error = reply["error"]
            try requireFixture(status == "duplicate" ? admitted : status == outcome, "ack", id + ": disposition")
            try requireFixture(admitted ? !reply["mid"].isNull && (reply["expiresAt"].intValue ?? 0) >= reply["at"].intValue! + 86_400_000 : reply["expiresAt"].isNull && outcome == "rejected", "ack", id + ": retention/admission")
            try requireFixture((outcome == "applied") == !result.isNull, "ack", id + ": result/outcome")
            try requireFixture(["rejected", "unknown"].contains(outcome) == !error.isNull, "ack", id + ": error/outcome")
            try requireFixture(error.isNull || error["retryable"].boolValue == false || (!admitted && outcome == "rejected"), "ack", id + ": unsafe retry")
            if !result.isNull {
                guard let rule = schema["$defs"].objectValue["data-" + reply["what"].stringValue!] else { throw FixtureFailure(code: "ack", description: id + ": unknown result family") }
                try fixtureSchema(result["data"], rule, root: schema)
                try requireFixture(result["replies"].arrayValue.allSatisfy { !["ack", "operation", "@auth", "@box", "@challenge", "@welcome"].contains($0["type"].stringValue!) }, "ack", id + ": unretainable reply")
                let request = vector["input"].arrayValue.first { $0["direction"].stringValue == "client" && $0["message"]["mid"] == reply["mid"] && $0["message"]["type"] == reply["what"] }?["message"] ?? .null
                if request["type"].stringValue == "send" { try validateFixtureDraft(request, schema: schema) }
                if request["type"].stringValue == "@apple" {
                    let token = (request["token"].stringValue ?? "").filter { "0123456789abcdefABCDEF".contains($0) }
                    try requireFixture((32...200).contains(token.count), "ack", id + ": invalid successful APNs token")
                }
                if request["type"].stringValue == "clearQueue", let queue = vector["initial"].objectValue["queue"] {
                    try requireFixture(result["data"]["removed"].intValue == queue.arrayValue.count, "ack", id + ": wrong cleared count")
                }
                for event in result["replies"].arrayValue where event["type"].stringValue == "editPrompt" {
                    try validateFixtureDraft(event, schema: schema)
                    let queued = vector["initial"]["queue"].arrayValue.first { $0["id"] == request["id"] }
                    var matches = false
                    if let queued {
                        matches = try ["text", "sent", "snippets", "attachments"].allSatisfy { key in
                            guard let stored = queued.objectValue[key], let returned = event.objectValue[key] else { return false }
                            return try fixtureBytes(stored) == fixtureBytes(returned)
                        }
                    }
                    try requireFixture(matches, "ack", id + ": reclaimed draft differs from queue")
                }
                if request["type"].stringValue == "slack:signIn" {
                    let retained = try fixtureCanonical(result)
                    try requireFixture([request["token"].stringValue, request["cookie"].stringValue].compactMap { $0 }.filter { !$0.isEmpty }.allSatisfy { !retained.contains($0) }, "ack", id + ": retained credential")
                }
            }
            let key = reply["scope"].stringValue! + ":" + (reply["mid"].stringValue ?? "null")
            if let prior = previous[key], status == "duplicate" {
                let stable = ["scope", "mid", "what", "target", "admitted", "at", "expiresAt"]
                try requireFixture(try stable.allSatisfy { try fixtureBytes(prior[$0]) == fixtureBytes(reply[$0]) }, "ack", id + ": duplicate changed identity/retention")
                var before = prior.objectValue, after = reply.objectValue
                before.removeValue(forKey: "status"); after.removeValue(forKey: "status")
                if ["applied", "rejected"].contains(prior["outcome"].stringValue!) { try requireFixture(try fixtureBytes(.object(before)) == fixtureBytes(.object(after)), "ack", id + ": duplicate changed terminal result") }
                if prior["outcome"].stringValue == "unknown" { try requireFixture(outcome != "pending", "ack", id + ": unknown cannot become runnable pending") }
            }
            previous[key] = reply
            uncertain = uncertain || outcome == "unknown"
        case "operation":
            try fixtureSchema(reply, schema["$defs"]["operation"], root: schema)
            try requireFixture(["rejected", "unknown"].contains(reply["state"].stringValue!) == !reply["error"].isNull, "operation", id + ": operation error")
            try requireFixture(reply["error"].isNull || reply["error"]["retryable"].boolValue == false, "operation", id + ": unsafe operation retry")
            uncertain = uncertain || reply["state"].stringValue == "unknown"
        case "welcome":
            try fixtureSchema(reply["seat"], schema["$defs"]["seat"], root: schema)
            let proto = reply["proto"].intValue
            try requireFixture(proto == 1 || proto == 2, "schema", id + ": welcome version")
            let core = ["mid-ack-v1", "receipts-v1", "run-precondition-v1", "operation-state-v1"]
            let valid = proto == 2 ? core.allSatisfy { reply["caps"].arrayValue.contains(.string($0)) } && reply["receipts"]["scope"].stringValue?.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil : reply["caps"].arrayValue.isEmpty && reply["receipts"].isNull
            try requireFixture(valid, "schema", id + ": welcome core/receipts")
        case "protocol:error":
            try requireFixture(["BAD_HELLO", "NO_COMMON_PROTOCOL", "REQUIRED_CAPABILITY", "NEGOTIATION_TIMEOUT"].contains(reply["code"].stringValue ?? "") && expected["close"].intValue == 1002, "schema", id + ": negotiation error/close")
        default: break
        }
        if reply["type"].stringValue == "send" { try validateFixtureDraft(reply, schema: schema) }
    }
    if uncertain { try requireFixture(expected["state"]["autoResend"].boolValue == false && expected["state"]["retained"].boolValue == true, "unknown", id + ": unknown must retain payload without replay") }
    if !vector["hash"].isNull {
        var message = vector["input"].arrayValue[0]["message"].objectValue
        message.removeValue(forKey: "mid"); message.removeValue(forKey: "scope")
        let text = try fixtureCanonical(.object(["message": .object(message), "target": context["target"]]))
        let bytes = Data(text.utf8)
        try requireFixture(bytes == Data(vector["hash"]["canonical"].stringValue!.utf8) && fixtureSHA(bytes) == vector["hash"]["sha256"].stringValue, "hash", id + ": canonical bytes/hash")
    }
}

private func fixtureMutationInventory(_ document: String) throws -> [String] {
    let marker = "## 8. Full inventory of today's messages and mid requirements"
    try requireFixture(document.components(separatedBy: marker).count == 2, "schema", "Missing protocol inventory")
    let section = document.components(separatedBy: marker)[1].components(separatedBy: "## 9.")[0]
    var role: String?, found: [String] = []
    for line in section.components(separatedBy: "\n") {
        if line.hasPrefix("### Authentication and transport") { role = "either" }
        else if ["### Fleet requests", "### Terminal,", "### Slack,"].contains(where: line.hasPrefix) { role = "fleet" }
        else if line.hasPrefix("### Conversation requests") { role = "conversation" }
        else if line.hasPrefix("### ") { role = nil }
        guard let role, line.hasPrefix("| ") else { continue }
        let cells = line.components(separatedBy: "|").dropFirst().dropLast().map { $0.trimmingCharacters(in: .whitespaces) }
        guard cells.count >= 3, cells[1].hasPrefix("M"), cells[2].hasPrefix("Yes") else { continue }
        let type = cells[0].hasPrefix("C→S ") ? String(cells[0].dropFirst(4)) : cells[0]
        found.append(role + "/" + type + "/" + (cells[1].contains("M local") ? "local" : "default"))
    }
    return found.sorted()
}

private struct ProtocolFixtureCorpus: Sendable {
    let manifest: JSONValue
    let schema: JSONValue
    let vectors: [String: JSONValue]
    let invalid: [JSONValue]

    static func load() throws -> Self {
        // NikCoreTests -> Tests -> NikCore -> iphone -> app -> repository.
        var repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let directory = repository.appendingPathComponent("test/fixtures/protocol-v2", isDirectory: true)
        func read(_ name: String) throws -> (Data, JSONValue) {
            try requireFixture(name.range(of: "^[a-z0-9-]+[.]json$", options: .regularExpression) != nil, "schema", "Unsafe fixture path")
            let bytes = try Data(contentsOf: directory.appendingPathComponent(name))
            return (bytes, try JSONValue.decode(bytes))
        }
        let (_, schema) = try read("schema.json"), (_, manifest) = try read("manifest.json")
        try fixtureSchemaDefinition(schema)
        try fixtureSchema(manifest, schema["$defs"]["manifest"], root: schema)
        var vectors: [String: JSONValue] = [:], files: Set<String> = [], categories: Set<String> = []
        for entry in manifest["files"].arrayValue {
            let name = entry["file"].stringValue!, category = entry["category"].stringValue!
            try requireFixture(files.insert(name).inserted && categories.insert(category).inserted, "schema", "Duplicate file/category")
            let (bytes, file) = try read(name)
            try requireFixture(fixtureSHA(bytes) == entry["sha256"].stringValue, "hash", name + ": file checksum")
            try fixtureSchema(file, schema, root: schema)
            let rows = file["vectors"].arrayValue
            try requireFixture(file["category"].stringValue == category && rows.count == entry["count"].intValue, "schema", name + ": category/count")
            try requireFixture(rows.map { $0["id"] } == entry["ids"].arrayValue, "schema", name + ": IDs")
            let positive = rows.filter { $0["polarity"].stringValue == "positive" }.count, negative = rows.count - positive
            try requireFixture(positive == entry["positive"].intValue && negative == entry["negative"].intValue && positive > 0 && negative > 0, "schema", name + ": polarity counts")
            for vector in rows {
                let id = vector["id"].stringValue!
                try requireFixture(vectors[id] == nil, "schema", "Duplicate vector ID " + id)
                try validateFixtureVector(vector, schema: schema); vectors[id] = vector
            }
        }
        try requireFixture(vectors.count == manifest["totalVectors"].intValue, "schema", "Total vector count")
        for vector in vectors.values {
            for (field, same) in [("sameAs", true), ("differentFrom", false)] {
                for id in vector["hash"][field].arrayValue.compactMap(\.stringValue) {
                    guard let peer = vectors[id], !peer["hash"].isNull else { throw FixtureFailure(code: "hash", description: "Unknown hash relation " + id) }
                    try requireFixture((peer["hash"]["sha256"] == vector["hash"]["sha256"]) == same, "hash", "Hash relation " + id)
                }
            }
        }
        let inventory = manifest["inventory"].arrayValue, ids = inventory.compactMap { $0["id"].stringValue }
        try requireFixture(Set(ids).count == ids.count, "schema", "Duplicate inventory branch")
        for item in inventory {
            guard let vector = vectors[item["vector"].stringValue!] else { throw FixtureFailure(code: "schema", description: "Missing inventory vector") }
            try requireFixture(vector["inventory"].arrayValue.contains(item["id"]) && vector["input"].arrayValue[0]["message"]["type"] == item["type"] && (item["role"].stringValue == "either" || vector["context"]["role"] == item["role"]), "schema", "Uncovered inventory " + item["id"].stringValue!)
        }
        let indexed = vectors.values.flatMap { $0["inventory"].arrayValue.compactMap(\.stringValue) }.sorted()
        try requireFixture(indexed == ids.sorted(), "schema", "Inventory coverage is not bidirectional")
        let document = try String(contentsOf: repository.appendingPathComponent("docs/engine/protocol-v2.md"), encoding: .utf8)
        let documented = try fixtureMutationInventory(document)
        let covered = inventory.filter { ["default", "local"].contains($0["branch"].stringValue!) }.compactMap { $0["id"].stringValue }.sorted()
        try requireFixture(documented == covered, "schema", "Protocol mutation inventory drift")
        let invalidName = manifest["invalidFile"]["file"].stringValue!, (invalidBytes, invalidFile) = try read(invalidName)
        try requireFixture(fixtureSHA(invalidBytes) == manifest["invalidFile"]["sha256"].stringValue, "hash", "Invalid corpus checksum")
        try fixtureSchema(invalidFile, schema["$defs"]["invalidCorpus"], root: schema)
        let invalid = invalidFile["cases"].arrayValue
        try requireFixture(invalid.count == manifest["totalInvalid"].intValue && Set(invalid.map { $0["id"] }).count == invalid.count, "schema", "Invalid vector count/IDs")
        let actual = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        try requireFixture(actual == (["schema.json", "manifest.json", invalidName] + files).sorted(), "schema", "Unlisted corpus file")
        return Self(manifest: manifest, schema: schema, vectors: vectors, invalid: invalid)
    }
}

private func fixturePatch(_ value: JSONValue, path: ArraySlice<String>, replacement: JSONValue?, remove: Bool) throws -> JSONValue {
    guard let key = path.first else { throw FixtureFailure(code: "schema", description: "Empty patch path") }
    switch value {
    case .object(var fields):
        if path.count == 1 {
            if remove { try requireFixture(fields.removeValue(forKey: key) != nil, "schema", "Missing removal key") }
            else { guard let replacement else { throw FixtureFailure(code: "schema", description: "Missing replacement") }; fields[key] = replacement }
        } else {
            guard let child = fields[key] else { throw FixtureFailure(code: "schema", description: "Missing patch key") }
            fields[key] = try fixturePatch(child, path: path.dropFirst(), replacement: replacement, remove: remove)
        }
        return .object(fields)
    case .array(var items):
        guard let index = Int(key), items.indices.contains(index) else { throw FixtureFailure(code: "schema", description: "Invalid patch index") }
        if path.count == 1 {
            if remove { items.remove(at: index) }
            else { guard let replacement else { throw FixtureFailure(code: "schema", description: "Missing replacement") }; items[index] = replacement }
        } else { items[index] = try fixturePatch(items[index], path: path.dropFirst(), replacement: replacement, remove: remove) }
        return .array(items)
    default: throw FixtureFailure(code: "schema", description: "Patch path is not a container")
    }
}

private let sharedProtocolFixtures = Result { try ProtocolFixtureCorpus.load() }

@Suite("Protocol v2 fixture consistency (not runtime conformance)") struct ProtocolV2FixtureTests {
    @Test func sameRepositoryCorpusAndCanonicalHashes() throws {
        let corpus = try sharedProtocolFixtures.get()
        #expect(corpus.vectors.count == 179)
        #expect(corpus.manifest["files"].arrayValue.count == 8)
        #expect(corpus.manifest["inventory"].arrayValue.count == 54)
        #expect(corpus.vectors.values.filter { !$0["hash"].isNull }.count == 14)
        for vector in corpus.vectors.values { try validateFixtureVector(vector, schema: corpus.schema) }
    }
    @Test func rejectsSharedMalformedVectors() throws {
        let corpus = try sharedProtocolFixtures.get()
        #expect(corpus.invalid.count == 30)
        for test in corpus.invalid {
            let id = test["id"].stringValue!
            var vector = try #require(corpus.vectors[test["base"].stringValue!])
            for patch in test["patches"].arrayValue {
                vector = try fixturePatch(vector, path: patch["path"].arrayValue.compactMap(\.stringValue)[...], replacement: patch.objectValue["value"], remove: patch["op"].stringValue == "remove")
            }
            var code: String?
            do { try validateFixtureVector(vector, schema: corpus.schema) }
            catch let error as FixtureFailure { code = error.code }
            #expect(code == test["error"].stringValue, "Malformed vector: \(id)")
        }
    }
    @Test func refusesUnsupportedSchemaKeywords() throws {
        _ = try sharedProtocolFixtures.get()
        var refused = false
        do { try fixtureSchemaDefinition(.object(["anyOf": .array([.object([:]), .object(["inventedConstraint": .bool(true)])])])) }
        catch let error as FixtureFailure { refused = error.code == "schema" }
        #expect(refused)
    }
    @Test func validatesSchemaValuedAdditionalProperties() throws {
        let corpus = try sharedProtocolFixtures.get()
        let rule: JSONValue = .object(["type": .string("object"), "additionalProperties": .object(["type": .string("string")])])
        try fixtureSchema(.object(["extra": .string("valid")]), rule, root: corpus.schema)
        var refused = false
        do { try fixtureSchema(.object(["extra": .number(42)]), rule, root: corpus.schema) }
        catch let error as FixtureFailure { refused = error.code == "schema" }
        #expect(refused)
    }
}
