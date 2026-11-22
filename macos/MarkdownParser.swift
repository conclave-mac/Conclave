// MarkdownParser.swift — parser a blocchi del Markdown prodotto dai modelli (vedi MarkdownView.swift).
// Solo Foundation: lo compilano anche le prove in tests/swift/run.sh.

import Foundation

// MARK: - Modello dei blocchi

struct MarkdownListItem: Equatable {
    var level: Int        // 0 = primo livello, 1 = annidato
    var marker: String    // "•" oppure "1." / "1)"
    var ordered: Bool
    var text: String
}

enum MarkdownBlock: Equatable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case list([MarkdownListItem])
    case table(header: [String], rows: [[String]])
    case quote([MarkdownBlock])
    case code(language: String, text: String)
    case rule
}

// MARK: - Parser

/// Funzione pura: divide il testo Markdown in blocchi. Non va mai in crash.
func parseMarkdownBlocks(_ text: String) -> [MarkdownBlock] {
    if text.isEmpty { return [] }
    // "\r\n" in Swift è un solo Character: `text.contains("\r")` non lo trovava e il testo restava su una riga.
    let normalized = text.unicodeScalars.contains("\r")
        ? text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        : text
    let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map { String($0) }
    return MarkdownParser.parse(lines, depth: 0)
}

private enum MarkdownParser {
    static let maxQuoteDepth = 3
    static let maxTableColumns = 32

    static func parse(_ lines: [String], depth: Int) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var i = 0

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph.removeAll()
            }
        }

        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                flushParagraph()
                i += 1
                continue
            }

            // Blocco di codice recintato
            if let fence = fenceOpening(line) {
                flushParagraph()
                var body: [String] = []
                i += 1
                while i < lines.count {
                    if isFenceClosing(lines[i], char: fence.char, count: fence.count) { i += 1; break }
                    body.append(stripIndent(lines[i], upTo: fence.indent))
                    i += 1
                }
                blocks.append(.code(language: fence.language, text: body.joined(separator: "\n")))
                continue
            }

            // Titolo
            if let h = heading(line) {
                flushParagraph()
                blocks.append(.heading(level: h.level, text: h.text))
                i += 1
                continue
            }

            // Riga orizzontale (prima degli elenchi: "* * *" non è un punto elenco)
            if isRule(trimmed) {
                flushParagraph()
                blocks.append(.rule)
                i += 1
                continue
            }

            // Tabella (riga con | seguita da riga separatrice)
            if isTableStart(lines, i) {
                flushParagraph()
                let header = splitRow(lines[i])
                let cols = min(max(header.count, 1), maxTableColumns)
                var rows: [[String]] = []
                i += 2
                while i < lines.count {
                    let l = lines[i]
                    let t = l.trimmingCharacters(in: .whitespaces)
                    if t.isEmpty || !t.contains("|") || fenceOpening(l) != nil { break }
                    rows.append(normalizeRow(splitRow(l), cols))
                    i += 1
                }
                blocks.append(.table(header: normalizeRow(header, cols), rows: rows))
                continue
            }

            // Citazione
            if quoteContent(line) != nil {
                flushParagraph()
                var inner: [String] = []
                while i < lines.count, let c = quoteContent(lines[i]) {
                    inner.append(c)
                    i += 1
                }
                if depth >= maxQuoteDepth {
                    let joined = inner.map { $0.trimmingCharacters(in: .whitespaces) }
                        .filter { !$0.isEmpty }.joined(separator: "\n")
                    blocks.append(.quote(joined.isEmpty ? [] : [.paragraph(joined)]))
                } else {
                    blocks.append(.quote(parse(inner, depth: depth + 1)))
                }
                continue
            }

            // Elenco
            if listItem(line) != nil {
                flushParagraph()
                var items: [MarkdownListItem] = []
                while i < lines.count {
                    let l = lines[i]
                    let t = l.trimmingCharacters(in: .whitespaces)
                    if let item = listItem(l) {
                        items.append(item)
                        i += 1
                        continue
                    }
                    if t.isEmpty {
                        // Riga vuota: l'elenco continua solo se segue un altro punto.
                        var j = i + 1
                        while j < lines.count, lines[j].trimmingCharacters(in: .whitespaces).isEmpty { j += 1 }
                        if j < lines.count, listItem(lines[j]) != nil { i = j; continue }
                        break
                    }
                    if startsBlock(lines, i) { break }
                    // Riga di continuazione del punto precedente
                    if !items.isEmpty { items[items.count - 1].text += "\n" + t }
                    i += 1
                }
                blocks.append(.list(items))
                continue
            }

            // Paragrafo
            paragraph.append(trimTrailing(trimLeading(line)))
            i += 1
        }
        flushParagraph()
        return blocks
    }

    // MARK: Riconoscimento righe

    static func leadingSpaces(_ s: String) -> Int {
        var n = 0
        for ch in s {
            if ch == " " { n += 1 } else if ch == "\t" { n += 4 } else { break }
        }
        return n
    }

    static func trimLeading(_ s: String) -> String {
        guard let idx = s.firstIndex(where: { $0 != " " && $0 != "\t" }) else { return "" }
        return String(s[idx...])
    }

    static func trimTrailing(_ s: String) -> String {
        guard let idx = s.lastIndex(where: { $0 != " " && $0 != "\t" }) else { return "" }
        return String(s[...idx])
    }

    static func stripIndent(_ s: String, upTo n: Int) -> String {
        if n == 0 { return s }
        var removed = 0
        var idx = s.startIndex
        while idx < s.endIndex, removed < n, s[idx] == " " {
            removed += 1
            idx = s.index(after: idx)
        }
        return String(s[idx...])
    }

    struct Fence { var char: Character; var count: Int; var indent: Int; var language: String }

    static func fenceOpening(_ line: String) -> Fence? {
        let indent = leadingSpaces(line)
        if indent > 12 { return nil }
        let t = trimLeading(line)
        guard let first = t.first, first == "`" || first == "~" else { return nil }
        let count = t.prefix(while: { $0 == first }).count
        guard count >= 3 else { return nil }
        let rest = t.dropFirst(count).trimmingCharacters(in: .whitespaces)
        if first == "`" && rest.contains("`") { return nil }
        let lang = rest.split(separator: " ").first.map(String.init) ?? ""
        return Fence(char: first, count: count, indent: indent, language: String(lang.prefix(40)))
    }

    static func isFenceClosing(_ line: String, char: Character, count: Int) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.first == char else { return false }
        let n = t.prefix(while: { $0 == char }).count
        return n >= count && n == t.count
    }

    static func heading(_ line: String) -> (level: Int, text: String)? {
        guard leadingSpaces(line) <= 3 else { return nil }
        let t = trimLeading(line)
        guard t.first == "#" else { return nil }
        let hashes = t.prefix(while: { $0 == "#" }).count
        guard hashes <= 6 else { return nil }
        let rest = t.dropFirst(hashes)
        if let c = rest.first, c != " " && c != "\t" { return nil }
        var text = rest.trimmingCharacters(in: .whitespaces)
        // Toglie i # di chiusura facoltativi ("## Titolo ##")
        if text.hasSuffix("#") {
            let stripped = String(text.reversed().drop(while: { $0 == "#" }).reversed())
            if stripped.isEmpty || stripped.hasSuffix(" ") || stripped.hasSuffix("\t") {
                text = trimTrailing(stripped)
            }
        }
        return (min(hashes, 4), text)
    }

    static func isRule(_ trimmed: String) -> Bool {
        guard let first = trimmed.first, first == "-" || first == "*" || first == "_" else { return false }
        var count = 0
        for ch in trimmed {
            if ch == first { count += 1 } else if ch != " " && ch != "\t" { return false }
        }
        return count >= 3
    }

    static func quoteContent(_ line: String) -> String? {
        guard leadingSpaces(line) <= 3 else { return nil }
        let t = trimLeading(line)
        guard t.first == ">" else { return nil }
        var rest = t.dropFirst()
        if rest.first == " " { rest = rest.dropFirst() }
        return String(rest)
    }

    static func listItem(_ line: String) -> MarkdownListItem? {
        let indent = leadingSpaces(line)
        if indent > 16 { return nil }
        let t = trimLeading(line)
        guard let first = t.first else { return nil }
        let level = indent >= 2 ? 1 : 0

        if first == "-" || first == "*" || first == "+" || first == "•" {
            let rest = t.dropFirst()
            guard let c = rest.first, c == " " || c == "\t" else { return nil }
            let body = rest.trimmingCharacters(in: .whitespaces)
            return MarkdownListItem(level: level, marker: level == 0 ? "•" : "◦", ordered: false,
                                    text: trimTrailing(body))
        }
        if first.isASCII, first.isNumber {
            let digits = t.prefix(while: { $0.isASCII && $0.isNumber })
            guard digits.count <= 9 else { return nil }
            let afterDigits = t.dropFirst(digits.count)
            guard let delim = afterDigits.first, delim == "." || delim == ")" else { return nil }
            let rest = afterDigits.dropFirst()
            guard let c = rest.first, c == " " || c == "\t" else { return nil }
            let body = rest.trimmingCharacters(in: .whitespaces)
            return MarkdownListItem(level: level, marker: String(digits) + String(delim), ordered: true,
                                    text: trimTrailing(body))
        }
        return nil
    }

    static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("|"), t.contains("-") else { return false }
        for ch in t where ch != "|" && ch != "-" && ch != ":" && ch != " " && ch != "\t" { return false }
        return true
    }

    static func isTableStart(_ lines: [String], _ i: Int) -> Bool {
        guard i + 1 < lines.count, lines[i].contains("|") else { return false }
        return isTableSeparator(lines[i + 1])
    }

    static func startsBlock(_ lines: [String], _ i: Int) -> Bool {
        let line = lines[i]
        let t = line.trimmingCharacters(in: .whitespaces)
        return fenceOpening(line) != nil || heading(line) != nil || isRule(t)
            || quoteContent(line) != nil || isTableStart(lines, i)
    }

    /// Divide una riga di tabella sulle "|" non precedute da "\".
    static func splitRow(_ line: String) -> [String] {
        var t = line.trimmingCharacters(in: .whitespaces)
        if t.hasPrefix("|") { t.removeFirst() }
        if t.hasSuffix("|") && !t.hasSuffix("\\|") { t.removeLast() }
        var cells: [String] = []
        var current = ""
        var escaped = false
        for ch in t {
            if escaped {
                if ch != "|" { current.append("\\") }
                current.append(ch)
                escaped = false
            } else if ch == "\\" {
                escaped = true
            } else if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
                if cells.count >= maxTableColumns * 4 { break }
            } else {
                current.append(ch)
            }
        }
        if escaped { current.append("\\") }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func normalizeRow(_ row: [String], _ cols: Int) -> [String] {
        if row.count == cols { return row }
        if row.count > cols { return Array(row.prefix(cols)) }
        return row + Array(repeating: "", count: cols - row.count)
    }
}
