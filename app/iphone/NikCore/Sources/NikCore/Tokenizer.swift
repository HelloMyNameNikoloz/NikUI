import Foundation

// Scanner port of media/highlight.js. HTML color classes map to the public native token kinds.
enum SyntaxReader {
    private struct Rules {
        var line: [String] = ["//"]
        var block: [(String, String)] = [("/*", "*/")]
        var quotes = ["\"", "'"]
        var multiline: Set<String> = []
        var keywords: Set<String> = []
        var types: Set<String> = []
        var definitions: [String: CodeTokenKind] = [:]
        var variables = true
        var capitalTypes = true
        var regex = false
        var caseInsensitive = false
        var jsonKeys = false
        var pythonPrefix = false
        var preprocessor = false
    }
    private static func words(_ text: String) -> Set<String> { Set(text.split(separator: " ").map(String.init)) }
    private static let jsStorage = "var let const function class extends new this super typeof instanceof void delete in of async get set static"
    private static let jsControl = "if else for while do return import export from default switch case break continue try catch finally throw await yield as with debugger"
    private static let javaStorage = "abstract boolean byte char class double enum extends final float implements int interface long native new package private protected public short static strictfp super synchronized this transient void volatile var record sealed permits"
    private static let javaControl = "if else for while do return import switch case default break continue try catch finally throw throws assert yield"
    private static var rules: [String: Rules] {
        var js = Rules(); js.quotes = ["`", "\"", "'"]; js.multiline = ["`"]
        js.keywords = words(jsStorage + " " + jsControl + " true false null undefined NaN Infinity"); js.definitions = ["function":.function, "class":.type]; js.regex = true
        var ts = js; ts.keywords.formUnion(words("interface type enum implements declare namespace module abstract public private protected readonly keyof infer is satisfies")); ts.types = words("string number boolean any unknown never object symbol bigint"); ts.definitions.merge(["interface":.type, "type":.type, "enum":.type]) { _, n in n }
        var python = Rules(); python.line = ["#"]; python.block = []; python.quotes = ["\"\"\"", "'''", "\"", "'"]; python.multiline = ["\"\"\"", "'''"]; python.pythonPrefix = true
        python.keywords = words("def class lambda and or not in is global nonlocal del async if elif else for while return import from as try except finally raise with yield break continue pass await assert match case True False None")
        python.types = words("int float str bool list dict set tuple bytes bytearray object type complex frozenset"); python.definitions = ["def":.function, "class":.type]
        var java = Rules(); java.quotes = ["\"\"\"", "\"", "'"]; java.multiline = ["\"\"\""]; java.keywords = words(javaStorage + " " + javaControl + " true false null"); java.definitions = ["class":.type, "interface":.type, "enum":.type, "record":.type]
        var clike = java; clike.quotes.append("`"); clike.multiline.insert("`"); clike.preprocessor = true
        clike.keywords.formUnion(words("auto const struct union typedef unsigned signed sizeof template typename namespace using virtual override inline extern register fn let mut impl trait pub use mod crate Self where type func chan map go defer interface val fun object companion data open internal lateinit init protocol extension def function echo readonly goto select match when guard elif foreach unless loop in true false null nil None nullptr NULL Some Ok Err"))
        clike.types = words("string bool int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 usize isize i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 str")
        clike.definitions.merge(["fn":.function, "func":.function, "fun":.function, "function":.function, "def":.function, "struct":.type, "trait":.type, "impl":.type, "type":.type, "protocol":.type]) { _, n in n }
        var json = Rules(); json.line = []; json.block = []; json.quotes = ["\""]; json.variables = false; json.capitalTypes = false; json.jsonKeys = true; json.keywords = words("true false null")
        var sql = Rules(); sql.line = ["--"]; sql.quotes = ["'", "\"", "`"]; sql.multiline = ["'"]; sql.caseInsensitive = true; sql.variables = false; sql.capitalTypes = false
        sql.keywords = words("select from where insert into values update set delete create table alter drop index join left right inner outer full cross on group by order having limit offset as and or not null is in exists like ilike between case when then else end distinct union all primary key foreign references default unique check constraint view begin commit rollback transaction returning with if replace asc desc grant revoke truncate cascade database schema add column rename to using natural over partition true false")
        sql.types = words("int integer smallint bigint serial bigserial varchar char text boolean bool date time timestamp timestamptz interval numeric decimal real float double precision json jsonb uuid bytea")
        return ["js":js, "ts":ts, "python":python, "java":java, "clike":clike, "json":json, "sql":sql]
    }
    private static let aliases: [String: String] = {
        let groups = ["js":"js javascript jsx mjs cjs node", "ts":"ts typescript tsx mts cts", "python":"py python python3 py3 ipython", "java":"java", "html":"html htm xhtml xml svg", "vue":"vue svelte astro", "css":"css scss sass less postcss", "json":"json jsonc json5 geojson", "shell":"bash sh shell zsh console shellsession terminal fish", "sql":"sql psql postgres postgresql mysql sqlite", "yaml":"yaml yml", "diff":"diff patch", "clike":"c h cpp c++ cc hpp cs csharp go golang rust rs kotlin kt kts swift php scala dart groovy gradle objc"]
        var map: [String: String] = [:]; for (kind, names) in groups { for name in names.split(separator: " ") { map[String(name)] = kind } }; return map
    }()
    static func tokenize(_ source: String, language: String?) -> [CodeToken] {
        let asked = (language ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard source.utf16.count <= 100_000, !words("text txt plain plaintext output log logs none nohighlight").contains(asked), let kind = aliases[asked] ?? detect(source) else { return [] }
        switch kind {
        case "diff": return lines(source, yaml: false)
        case "yaml": return lines(source, yaml: true)
        case "shell": return shell(source)
        case "html", "vue": return markup(source, vue: kind == "vue")
        case "css": return css(source)
        default: return code(source, rules: rules[kind] ?? Rules())
        }
    }
    private struct Scanner {
        let units: [UInt16]
        let text: NSString
        var count: Int { units.count }
        init(_ text: String) { units = Array(text.utf16); self.text = text as NSString }
        func char(_ i: Int) -> UInt16 { units.indices.contains(i) ? units[i] : 0 }
        func has(_ needle: String, _ i: Int) -> Bool { let u = Array(needle.utf16); return i + u.count <= units.count && units[i..<(i + u.count)].elementsEqual(u) }
        func string(_ start: Int, _ end: Int) -> String { text.substring(with: NSRange(location: start, length: max(0, end - start))) }
        func endLine(_ i: Int) -> Int { var j = i; while j < count, char(j) != 10 { j += 1 }; return j }
        func find(_ needle: String, from start: Int) -> Int? { let range = text.range(of: needle, range: NSRange(location: min(start, count), length: max(0, count - start))); return range.location == NSNotFound ? nil : range.location }
        func match(_ pattern: String, _ i: Int) -> String? {
            guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: text as String, options: .anchored, range: NSRange(location: i, length: count - i)) else { return nil }
            return text.substring(with: m.range)
        }
        func after(_ i: Int) -> UInt16 { var j = i; while j < count, char(j) == 32 || char(j) == 9 { j += 1 }; return char(j) }
        func stringEnd(_ i: Int, quote: String, multiline: Bool) -> Int {
            var j = i + quote.utf16.count
            while j < count { if char(j) == 92 { j = min(count, j + 2); continue }; if has(quote, j) { return j + quote.utf16.count }; if char(j) == 10, !multiline { return j }; j += 1 }; return count
        }
    }
    private static func code(_ source: String, rules r: Rules) -> [CodeToken] {
        let s = Scanner(source); var tokens: [CodeToken] = []; var i = 0; var previous = ""; var definition: CodeTokenKind?
        func emit(_ start: Int, _ end: Int, _ kind: CodeTokenKind) { if end > start { tokens.append(CodeToken(range: start..<end, kind: kind)) } }
        while i < s.count {
            let c = s.char(i)
            if [9, 10, 13, 32].contains(c) { i += 1; continue }
            if r.line.contains(where: { s.has($0, i) }) { let end = s.endLine(i); emit(i, end, .comment); i = end; continue }
            if let pair = r.block.first(where: { s.has($0.0, i) }) { let end = s.find(pair.1, from: i + pair.0.utf16.count).map { $0 + pair.1.utf16.count } ?? s.count; emit(i, end, .comment); i = end; continue }
            if r.preprocessor, c == 35, let directive = s.match("#[ \\t]*[a-z]+", i), source.utf16.prefix(i).reversed().prefix(while: { $0 != 10 }).allSatisfy({ $0 == 9 || $0 == 32 }) { let end = i + directive.utf16.count; emit(i, end, .keyword); i = end; previous = directive; continue }
            if let q = r.quotes.first(where: { s.has($0, i) }) { let end = s.stringEnd(i, quote: q, multiline: r.multiline.contains(q)); emit(i, end, r.jsonKeys && s.after(end) == 58 ? .property : .string); i = end; previous = "str"; definition = nil; continue }
            if (48...57).contains(c) || (c == 46 && (48...57).contains(s.char(i + 1))), let number = s.match(#"(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)[a-zA-Z]*"#, i) { let end = i + number.utf16.count; emit(i, end, .number); i = end; previous = "num"; definition = nil; continue }
            if c == 64, let name = s.match(#"@[\w.]+"#, i) { let end = i + name.utf16.count; emit(i, end, .function); i = end; previous = name; continue }
            if let word = s.match(#"[A-Za-z_$\u00c0-\uffff][\w$\u00c0-\uffff]*"#, i) {
                let end = i + word.utf16.count
                if r.pythonPrefix, RX.matches(#"^[rRbBuUfF]{1,2}$"#, word), let q = r.quotes.first(where: { s.has($0, end) }) { let stop = s.stringEnd(end, quote: q, multiline: r.multiline.contains(q)); emit(i, stop, .string); i = stop; previous = "str"; continue }
                let key = r.caseInsensitive ? word.lowercased() : word; var kind: CodeTokenKind?
                if let pending = definition { kind = pending; definition = nil }
                else if r.keywords.contains(key) { kind = .keyword }
                else if r.types.contains(key) { kind = .type }
                else if s.after(end) == 40 { kind = .function }
                else if r.capitalTypes, RX.matches(#"^[A-Z]"#, word), RX.matches("[a-z]", word) { kind = .type }
                else if r.capitalTypes, RX.matches(#"^[A-Z][A-Z0-9_]+$"#, word) { kind = .keyword }
                else if r.variables { kind = .property }
                if let kind { emit(i, end, kind) }
                if let next = r.definitions[key], kind != .property, kind != .function { definition = next }
                i = end; previous = key; continue
            }
            if r.regex, c == 47, RX.matches(#"^(|[(,=:\[!&|?{};+\-*%<>~^]|return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$"#, previous) {
                var j = i + 1; var inClass = false; var closed = false
                while j < s.count, s.char(j) != 10 { let v = s.char(j); if v == 92 { j += 2; continue }; if v == 91 { inClass = true }; if v == 93 { inClass = false }; if v == 47, !inClass { j += 1; closed = true; break }; j += 1 }
                if closed, j > i + 2 { while j < s.count, (97...122).contains(s.char(j)) { j += 1 }; emit(i, j, .string); i = j; previous = "rx"; continue }
            }
            previous = s.string(i, i + 1); definition = nil; i += 1
        }
        return tokens
    }
    private static func shell(_ source: String) -> [CodeToken] {
        let s = Scanner(source); var i = 0; var command = true; var tokens: [CodeToken] = []
        let keywords = words("if then else elif fi for while until do done case esac in function select return export local declare readonly unset source alias time")
        let restart = words("if then else elif do while until time")
        func emit(_ a: Int, _ b: Int, _ kind: CodeTokenKind) { if b > a { tokens.append(CodeToken(range: a..<b, kind: kind)) } }
        while i < s.count {
            let c = s.char(i)
            if c == 10 { i += 1; command = true; continue }; if [9, 13, 32].contains(c) { i += 1; continue }
            if (i == 0 || s.char(i - 1) == 10), [36, 62, 37].contains(c), s.char(i + 1) == 32 { emit(i, i + 1, .punctuation); i += 1; command = true; continue }
            if c == 35, i == 0 || [9, 10, 13, 32].contains(s.char(i - 1)) { let end = s.endLine(i); emit(i, end, .comment); i = end; continue }
            if c == 39 || c == 34 { let quote = c == 39 ? "'" : "\""; let end = c == 39 ? (s.find(quote, from: i + 1).map { $0 + 1 } ?? s.count) : s.stringEnd(i, quote: quote, multiline: true); emit(i, end, .string); i = end; command = false; continue }
            if c == 36 {
                if s.char(i + 1) == 40 { emit(i, i + 2, .punctuation); i += 2; command = true; continue }
                if let value = s.match(#"\$(?:\{[^}\n]*\}?|\w+|[@#?$!*0-9-])"#, i) { let end = i + value.utf16.count; emit(i, end, .property); i = end; command = false; continue }
            }
            if [124, 38, 59, 40, 41, 96].contains(c) { i += 1; command = true; continue }
            if let word = s.match(#"[^\s|&;()<>'"`$]+"#, i) {
                let end = i + word.utf16.count
                if keywords.contains(word) { emit(i, end, .keyword); command = restart.contains(word) }
                else if command, RX.matches(#"^[A-Za-z_]\w*="#, word) { let eq = (word as NSString).range(of: "=").location; emit(i, i + eq, .property) }
                else if command { emit(i, end, .function); command = false }
                else if RX.matches(#"^-?\d+(\.\d+)?$"#, word) { emit(i, end, .number) }
                i = end; continue
            }
            i += 1
        }
        return tokens
    }
    private static func lines(_ source: String, yaml: Bool) -> [CodeToken] {
        var offset = 0; var result: [CodeToken] = []
        for line in source.components(separatedBy: "\n") {
            let length = line.utf16.count
            func emit(_ start: Int, _ count: Int, _ kind: CodeTokenKind) { if count > 0 { result.append(CodeToken(range: (offset + start)..<(offset + start + count), kind: kind)) } }
            if !yaml {
                if RX.matches(#"^(diff |index |\+\+\+ |--- |@@)"#, line) { emit(0, length, .heading) }
                else if line.hasPrefix("+") { emit(0, length, .inserted) }
                else if line.hasPrefix("-") { emit(0, length, .deleted) }
            } else if RX.matches(#"^\s*#"#, line) { emit(0, length, .comment) }
            else if RX.matches(#"^(---|\.\.\.)\s*$"#, line) { emit(0, length, .punctuation) }
            else {
                var valueStart = 0
                if let m = RX.first(#"^(\s*(?:-\s+)?)([^\s#:'"][^:#]*?|"[^"]*"|'[^']*')(\s*:)(?=\s|$)(.*)$"#, line) { emit(m.range(at: 2).location, m.range(at: 2).length, .type); valueStart = m.range(at: 4).location }
                else if let m = RX.first(#"^(\s*-\s+)(.*)$"#, line) { valueStart = m.range(at: 2).location }
                let value = (line as NSString).substring(from: valueStart)
                if let m = RX.first(#"^(\s*)(.*?)(\s+#.*)?$"#, value) {
                    let word = RX.text(m, 2, value); let range = m.range(at: 2); let kind: CodeTokenKind = RX.matches(#"^(true|false|yes|no|on|off|null|~)$"#, word, options: .caseInsensitive) ? .keyword : (RX.matches(#"^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$"#, word, options: .caseInsensitive) ? .number : (RX.matches(#"^[&*][\w-]+$"#, word) ? .type : (RX.matches(#"^[|>][-+]?$"#, word) ? .punctuation : .string)))
                    emit(valueStart + range.location, range.length, kind)
                    if m.range(at: 3).location != NSNotFound { emit(valueStart + m.range(at: 3).location, m.range(at: 3).length, .comment) }
                }
            }
            offset += length + 1
        }
        return result
    }
    private static func markup(_ source: String, vue: Bool) -> [CodeToken] {
        let s = Scanner(source); var result: [CodeToken] = []; var i = 0
        func emit(_ a: Int, _ b: Int, _ kind: CodeTokenKind) { if b > a { result.append(CodeToken(range: a..<b, kind: kind)) } }
        func nested(_ tokens: [CodeToken], _ offset: Int) { result += tokens.map { CodeToken(range: ($0.range.lowerBound + offset)..<($0.range.upperBound + offset), kind: $0.kind) } }
        while i < s.count {
            if s.has("<!--", i) { let end = s.find("-->", from: i + 4).map { $0 + 3 } ?? s.count; emit(i, end, .comment); i = end; continue }
            if s.char(i) == 60, let tag = s.match(#"</?[!?]?[A-Za-z][\w:.-]*"#, i) {
                let closing = tag.hasPrefix("</"); let name = String(tag.dropFirst(closing ? 2 : 1)); let lower = name.lowercased()
                let prefix = closing ? 2 : 1; emit(i, i + prefix, .punctuation); emit(i + prefix, i + tag.utf16.count, .type); i += tag.utf16.count
                var attrs = ""; var selfClosed = false
                while i < s.count {
                    let c = s.char(i)
                    if [9, 10, 13, 32].contains(c) { i += 1; continue }
                    if s.has("/>", i) || s.has("?>", i) { emit(i, i + 2, .punctuation); i += 2; selfClosed = true; break }
                    if c == 62 { emit(i, i + 1, .punctuation); i += 1; break }
                    if c == 34 || c == 39 { let q = c == 34 ? "\"" : "'"; let end = s.find(q, from: i + 1).map { $0 + 1 } ?? s.count; attrs += s.string(i, end); emit(i, end, .string); i = end; continue }
                    if c == 61 { attrs += "="; i += 1; continue }
                    if let attr = s.match(#"[^\s=>/"']+"#, i) { let end = i + attr.utf16.count; attrs += " " + attr; emit(i, end, .property); i = end; continue }
                    i += 1
                }
                if !closing, !selfClosed, lower == "script" || lower == "style" {
                    let range = (source as NSString).range(of: "</" + lower, options: .caseInsensitive, range: NSRange(location: i, length: s.count - i)); let end = range.location == NSNotFound ? s.count : range.location
                    let body = s.string(i, end)
                    nested(lower == "style" ? css(body) : code(body, rules: rules[RX.matches(#"\blang=["']?(ts|tsx|typescript)\b"#, attrs, options: .caseInsensitive) ? "ts" : "js"]!), i); i = end
                }
                continue
            }
            if vue, s.has("{{", i) { let end = s.find("}}", from: i + 2) ?? s.count; emit(i, i + 2, .punctuation); nested(code(s.string(i + 2, end), rules: rules["js"]!), i + 2); if end < s.count { emit(end, end + 2, .punctuation) }; i = min(s.count, end + 2); continue }
            i += 1
        }
        return result
    }
    private static func css(_ source: String) -> [CodeToken] {
        let s = Scanner(source); var tokens: [CodeToken] = []; var i = 0; var depth = 0; var mode = "selector"
        func emit(_ a: Int, _ b: Int, _ kind: CodeTokenKind) { if b > a { tokens.append(CodeToken(range: a..<b, kind: kind)) } }
        func statement(_ start: Int) -> String { if depth == 0 { return "selector" }; var j = start; while j < s.count { if s.char(j) == 123 { return "selector" }; if [59, 125].contains(s.char(j)) { return "property" }; j += 1 }; return "property" }
        while i < s.count {
            let c = s.char(i)
            if [9, 10, 13, 32].contains(c) { i += 1; continue }
            if s.has("/*", i) { let end = s.find("*/", from: i + 2).map { $0 + 2 } ?? s.count; emit(i, end, .comment); i = end; continue }
            if mode != "value", s.has("//", i) { let end = s.endLine(i); emit(i, end, .comment); i = end; continue }
            if c == 34 || c == 39 { let end = s.stringEnd(i, quote: c == 34 ? "\"" : "'", multiline: false); emit(i, end, .string); i = end; continue }
            if c == 123 { depth += 1; i += 1; mode = statement(i); continue }
            if c == 125 { depth = max(0, depth - 1); i += 1; mode = statement(i); continue }
            if c == 59 { i += 1; mode = statement(i); continue }
            if c == 64, let at = s.match(#"@[\w-]+"#, i) { let end = i + at.utf16.count; emit(i, end, .keyword); i = end; mode = "at"; continue }
            if mode == "selector" { if let word = s.match(#"[^\s{},;/]+"#, i) { let end = i + word.utf16.count; emit(i, end, .type); i = end; continue }; i += 1; continue }
            if mode == "property" {
                if depth > 0, statement(i) == "selector" { mode = "selector"; continue }
                if let property = s.match(#"[-\w$]+"#, i) { let end = i + property.utf16.count; emit(i, end, .property); i = end; continue }
                if c == 58 { mode = "value" }; i += 1; continue
            }
            if s.has("!important", i) { emit(i, i + 10, .keyword); i += 10; continue }
            if c == 35, let hex = s.match(#"#[\da-fA-F]+"#, i) { let end = i + hex.utf16.count; emit(i, end, .string); i = end; continue }
            if let number = s.match(#"-?(?:\d*\.)?\d+(?:%|[a-zA-Z]+)?"#, i) { let end = i + number.utf16.count; emit(i, end, .number); i = end; continue }
            if let word = s.match(#"-?-?[A-Za-z_][\w-]*|\$[\w-]+"#, i) { let end = i + word.utf16.count; if word.hasPrefix("--") || word.hasPrefix("$") { emit(i, end, .property) } else if s.after(end) == 40 { emit(i, end, .function) } else if mode != "at" { emit(i, end, .string) }; i = end; continue }
            i += 1
        }
        return tokens
    }
    static func detect(_ source: String) -> String? {
        let s = String(decoding: source.utf16.prefix(6000), as: UTF16.self); let t = s.trimmingCharacters(in: .whitespacesAndNewlines); guard !t.isEmpty else { return nil }
        let lines = s.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        func matches(_ p: String) -> Bool { RX.matches(p, s, options: [.anchorsMatchLines]) }
        func count(_ p: String) -> Int { (try? NSRegularExpression(pattern: p, options: .anchorsMatchLines).numberOfMatches(in: s, range: NSRange(s.startIndex..., in: s))) ?? 0 }
        func share(_ lines: [String], _ p: String) -> Double { lines.isEmpty ? 0 : Double(lines.filter { RX.matches(p, $0) }.count) / Double(lines.count) }
        if ["[", "{"].contains(t.first.map(String.init) ?? ""), ["]", "}"].contains(t.last.map(String.init) ?? ""), let json = try? JSONValue.decode(Data(source.utf8)), case .object = json { return "json" }
        if t.hasPrefix("["), t.hasSuffix("]"), (try? JSONValue.decode(Data(source.utf8))) != nil, RX.matches(#"["\[\{]"#, String(t.dropFirst())) { return "json" }
        if matches(#"^(diff --git |--- a/|\+\+\+ b/|@@ -\d)"#), matches(#"^[+-][^+-]"#) { return "diff" }
        if matches(#"^\s*<template[\s>]"#), matches(#"^\s*</template>"#) { return "vue" }
        if t.hasPrefix("<"), RX.matches(#"</[A-Za-z][\w:-]*>|/>|<!DOCTYPE"#, s, options: .caseInsensitive), !matches(#"^\s*(import|export|const|function)\b"#) { return "html" }
        if share(lines, #"^\s*[-*]?\s*[A-Za-z][^;{}=<>]*\s\S+\s\S+.*[.!?:]["')]?\s*$"#) >= 0.5 { return nil }
        let order = ["python", "js", "ts", "java", "css", "shell", "sql", "yaml"]; var scores = Dictionary(uniqueKeysWithValues: order.map { ($0, 0) })
        func add(_ lang: String, _ n: Int, _ p: String) { if matches(p) { scores[lang, default: 0] += n } }
        add("python", 4, #"^\s*(async\s+)?def \w+\s*\(.*\)\s*(->.*)?:\s*$"#); add("python", 4, #"^\s*class \w+(\(.*\))?:\s*$"#); add("python", 3, #"^\s*(from [\w.]+ import \w|import [\w.]+(\s+as \w+)?\s*$)"#); add("python", 2, #"^\s*(if|elif|for|while|with|try|except|else|finally)\b[^;{]*:\s*(#.*)?$"#); scores["python", default: 0] += min(3, count(#"\b(elif|self\.|None\b|True\b|False\b|__\w+__|print\(|lambda )"#))
        add("js", 4, #"^\s*import\s.*\sfrom\s+['"]|^\s*import\s+['"]"#); add("js", 4, #"^\s*export\s+(default|const|function|class|async|let|interface|type)\b"#); add("js", 3, #"\b(const|let|var)\s+[\w${}\[\],\s]+="#); add("js", 2, #"=>"#); add("js", 3, #"\bfunction\s*\*?\s*\w*\s*\("#); add("js", 3, #"\bconsole\.\w+\(|\brequire\(['"]|\bdocument\.|\bwindow\."#); add("js", 1, #"===|!=="#); add("ts", 3, #"\b(interface|type)\s+\w+(<[^>]*>)?\s*[={]|:\s*(string|number|boolean|any|unknown|void)\b"#)
        add("java", 5, #"\b(public|private|protected)\s+(static\s+)?(final\s+)?(class|interface|enum|record|void|[\w<>\[\],\s]+\s+\w+\s*\()"#); add("java", 5, #"System\.(out|err)\.print"#); add("java", 4, #"^\s*package [\w.]+;\s*$|^\s*import (static )?[\w.]+(\.\*)?;\s*$"#); add("java", 2, #"@Override\b|\bString\[\]|\bnew [A-Z]\w*(<[^>]*>)?\("#)
        let declarations = count(#"^\s*-{0,2}[a-z][\w-]*\s*:\s*[^;{}\n]+;\s*$"#); let selectors = count(#"^\s*[^\s{}();=][^{}();=]*\{\s*$"#)
        if declarations > 0, selectors > 0 || matches(#"^\s*[}]"#) { scores["css", default: 0] += 2 + min(3, declarations) }; add("css", 3, #"^\s*@(media|import|keyframes|font-face|tailwind|apply|use|mixin|include)\b"#)
        if RX.matches(#"^#!.*\b(ba|z|fi)?sh\b"#, t) { scores["shell", default: 0] += 6 }
        let commands = share(lines, #"^\s*([$%>] )?(sudo |npm |npx |pnpm |yarn |bun |git |cd |ls |pip3? |python3? |node |brew |docker |docker-compose |kubectl |curl |wget |echo |export |mkdir |rm |cp |mv |cat |chmod |chown |source |make |go |cargo |gh |claude |ssh |scp |tar |grep |find |sed |awk |apt(-get)? |systemctl |code |open |touch |uv |poetry |conda |java |mvn |gradle |\./)"#)
        if commands >= 0.5 { scores["shell", default: 0] += 3 + Int((commands * 2).rounded()) }; add("shell", 3, #"^\s*(fi|done|esac)\s*$"#)
        if RX.matches(#"\bSELECT\b[\s\S]+?\bFROM\b"#, s, options: .caseInsensitive), RX.matches(#"\bSELECT\b"#, s) { scores["sql", default: 0] += 4 }
        if RX.matches(#"\b(INSERT INTO|UPDATE \w+ SET|DELETE FROM|CREATE (TABLE|INDEX|VIEW|UNIQUE INDEX)|ALTER TABLE|DROP TABLE)\b"#, s, options: .caseInsensitive) { scores["sql", default: 0] += 4 }
        let keyLines = share(lines.filter { !RX.matches(#"^\s*#"#, $0) }, #"^\s*(- )?[\w.-]+:(\s|$)|^\s*- \S"#)
        if lines.count >= 2, keyLines >= 0.7, !RX.matches(#"[;{}()]"#, s) { scores["yaml", default: 0] += 3 + Int((keyLines * 2).rounded()) }
        if scores["ts", default: 0] > 0, scores["js", default: 0] > 0 { scores["ts", default: 0] += scores["js", default: 0] }
        var best: String?; var top = 0
        for lang in order { if scores[lang, default: 0] > top { best = lang; top = scores[lang, default: 0] } }; return top >= 3 ? best : nil
    }
}
