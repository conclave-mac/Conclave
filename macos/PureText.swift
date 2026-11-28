// PureText.swift — funzioni pure sui testi (titoli, righe macchina, note delle release).
// Solo Foundation: le compilano anche le prove in tests/swift/run.sh.

import Foundation

/// Titolo da mostrare per una discussione: quello scritto dal giudice o, finché manca
/// (dibattito in corso, discussioni vecchie), l'inizio della domanda in poche parole.
func debateTitle(_ title: String?, question: String) -> String {
    if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty { return t }
    let q = question.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    // Prima frase, se basta; altrimenti le prime parole.
    let first = q.split(omittingEmptySubsequences: true, whereSeparator: { ".?!;:".contains($0) }).first.map(String.init) ?? q
    let words = first.split(separator: " ")
    let t = words.count <= 8 ? first + (first.count < q.count && q[q.index(q.startIndex, offsetBy: first.count)] == "?" ? "?" : "")
        : words.prefix(7).joined(separator: " ") + "…"
    return t.prefix(1).uppercased() + t.dropFirst()
}

/// Righe macchina che i modelli scrivono in fondo alle risposte ("CAMBIAMENTI: minori", "FIDUCIA: alta").
enum MachineLine {
    /// Ultimo valore di una riga macchina nel testo, anche con ** intorno o nella forma inglese;
    /// restituito in italiano (valori di `map`).
    static func value(_ text: String, keys: String, map: [String: String]) -> String? {
        let words = map.keys.joined(separator: "|")
        guard let re = try? NSRegularExpression(pattern: "(?:\(keys))[ \\t]*\\**[ \\t]*:[ \\t]*\\**[ \\t]*(\(words))\\b",
                                                options: [.caseInsensitive]) else { return nil }
        let ns = text as NSString
        guard let m = re.matches(in: text, range: NSRange(location: 0, length: ns.length)).last else { return nil }
        return map[ns.substring(with: m.range(at: 1)).lowercased()]
    }
}

/// Versioni e note delle release di GitHub (usate da `UpdateCheck`).
enum ReleaseText {
    /// Confronto numerico per componenti ("0.10.0" > "0.9.1"); i suffissi come "-beta" si ignorano.
    static func isNewer(_ a: String, than b: String) -> Bool {
        let parts = { (s: String) in
            s.split(separator: "-")[0].split(separator: ".").map { Int($0.filter(\.isNumber)) ?? 0 }
        }
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let l = i < x.count ? x[i] : 0, r = i < y.count ? y[i] : 0
            if l != r { return l > r }
        }
        return false
    }

    /// Note della release in testo semplice per l'avviso. Toglie le parti che GitHub genera da sé
    /// (`--generate-notes`: "Full Changelog", "What's Changed", "by @utente in <link>") e i segni
    /// Markdown, che `NSAlert` mostrerebbe così come sono. Vuoto se non resta niente di utile.
    static func readableNotes(_ raw: String) -> String {
        var out: [String] = []
        for var line in raw.components(separatedBy: .newlines) {
            line = line.trimmingCharacters(in: .whitespaces)
            let lower = line.lowercased()
            if line.isEmpty || lower.contains("full changelog") || lower.hasPrefix("## what's changed")
                || lower.hasPrefix("## new contributors") || lower.contains("made their first contribution") { continue }
            // "* fix qualcosa by @utente in https://github.com/…/pull/12" → "fix qualcosa"
            if let r = line.range(of: #" by @[\w-]+ in https?://\S+$"#, options: .regularExpression) {
                line.removeSubrange(r)
            }
            line = line.replacingOccurrences(of: #"\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
            line = line.replacingOccurrences(of: #"https?://\S+"#, with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: #"\*\*|__|`"#, with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: #"^#+\s*"#, with: "", options: .regularExpression)
            line = line.replacingOccurrences(of: #"^[*-]\s+"#, with: "• ", options: .regularExpression)
            line = line.trimmingCharacters(in: .whitespaces)
            if !line.isEmpty, line != "•" { out.append(line) }
        }
        return out.joined(separator: "\n")
    }
}

/// Regole del titolo scelto dall'utente, le stesse del motore (`PATCH /api/debates/:id`): spazi tolti ai
/// lati, niente a capo (diventano spazi), al massimo 120 caratteri UTF-16.
enum RenameTitle {
    static let maxLength = 120

    static func clean(_ text: String) -> String {
        text.split(whereSeparator: \.isNewline).joined(separator: " ").trimmingCharacters(in: .whitespaces)
    }
}

/// Giudice che ha davvero scritto il verdetto (`judge_used` sul messaggio del verdetto e sull'evento
/// `done`): anche una riserva della catena. Assente nelle discussioni vecchie: allora vale il giudice scelto.
struct JudgeUsed: Equatable {
    let id: String
    let label: String
    /// È anche uno dei partecipanti del dibattito.
    let participated: Bool

    /// `{id, label, participated}`; nil se manca o se id ed etichetta sono vuoti.
    init?(_ value: Any?) {
        guard let o = value as? [String: Any] else { return nil }
        let id = (o["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = (o["label"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !id.isEmpty || !label.isEmpty else { return nil }
        self.id = id
        self.label = label.isEmpty ? id : label
        participated = o["participated"] as? Bool ?? false
    }
}
