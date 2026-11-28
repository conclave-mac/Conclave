// Prove delle funzioni pure dell'app (compilate da tests/swift/run.sh con i file puri di macos/).
// Ogni prova descrive il comportamento attuale: se cambia, la prova va aggiornata di proposito.

import Foundation

var total = 0
var failures: [String] = []

func check<T: Equatable>(_ got: T, _ want: T, _ name: String, line: Int = #line) {
    total += 1
    if got != want { failures.append("riga \(line) – \(name)\n    atteso:  \(want)\n    ottenuto: \(got)") }
}

// MARK: parseMarkdownBlocks

check(parseMarkdownBlocks(""), [], "testo vuoto")
check(parseMarkdownBlocks("# Titolo"), [.heading(level: 1, text: "Titolo")], "titolo")
check(parseMarkdownBlocks("### Sotto ###"), [.heading(level: 3, text: "Sotto")], "titolo con # in chiusura")
check(parseMarkdownBlocks("a\nb\n\nc"), [.paragraph("a\nb"), .paragraph("c")], "paragrafi")
check(parseMarkdownBlocks("a\r\nb"), [.paragraph("a\nb")], "a capo di Windows")
check(parseMarkdownBlocks("- uno\n- due"),
      [.list([MarkdownListItem(level: 0, marker: "•", ordered: false, text: "uno"),
              MarkdownListItem(level: 0, marker: "•", ordered: false, text: "due")])], "elenco puntato")
check(parseMarkdownBlocks("1. a\n2. b"),
      [.list([MarkdownListItem(level: 0, marker: "1.", ordered: true, text: "a"),
              MarkdownListItem(level: 0, marker: "2.", ordered: true, text: "b")])], "elenco numerato")
check(parseMarkdownBlocks("- uno\n  segue"),
      [.list([MarkdownListItem(level: 0, marker: "•", ordered: false, text: "uno\nsegue")])], "continuazione di un punto")
check(parseMarkdownBlocks("| A | B |\n|---|---|\n| 1 | 2 |"), [.table(header: ["A", "B"], rows: [["1", "2"]])], "tabella")
check(parseMarkdownBlocks("| A |\n|---|\n| 1 | 2 |"), [.table(header: ["A"], rows: [["1"]])], "riga di tabella troppo lunga")
check(parseMarkdownBlocks("```swift\nlet x = 1\n```"), [.code(language: "swift", text: "let x = 1")], "codice")
check(parseMarkdownBlocks("```\naperto"), [.code(language: "", text: "aperto")], "codice non chiuso")
check(parseMarkdownBlocks("---"), [.rule], "riga orizzontale")
check(parseMarkdownBlocks("> citazione"), [.quote([.paragraph("citazione")])], "citazione")
check(parseMarkdownBlocks(String(repeating: ">", count: 50) + " x").count, 1, "citazioni annidate a fondo")
check(parseMarkdownBlocks("<b>html</b>"), [.paragraph("<b>html</b>")], "l'HTML resta testo")

// MARK: UpdateCheck.isNewer (ReleaseText)

check(ReleaseText.isNewer("0.10.0", than: "0.9.1"), true, "confronto numerico")
check(ReleaseText.isNewer("0.5.5", than: "0.5.5"), false, "stessa versione")
check(ReleaseText.isNewer("1.0", than: "1.0.0"), false, "componenti mancanti = 0")
check(ReleaseText.isNewer("0.5.6-beta", than: "0.5.5"), true, "suffisso ignorato")
check(ReleaseText.isNewer("0.5.4", than: "0.5.5"), false, "più vecchia")

// MARK: UpdateCheck.readableNotes (ReleaseText)

check(ReleaseText.readableNotes("## What's Changed\n* fix crash by @someone in https://github.com/a/b/pull/1\n\n**Full Changelog**: https://github.com/a/b/compare/v1...v2"),
      "• fix crash", "note generate da GitHub")
check(ReleaseText.readableNotes("## Novità\n- **Nuovo** [pagina](https://example.com) `codice`"),
      "Novità\n• Nuovo pagina codice", "segni Markdown tolti")
check(ReleaseText.readableNotes("## What's Changed\n\n**Full Changelog**: https://x"), "", "niente di utile")
check(parseMarkdownBlocks("a\rb"), [.paragraph("a\nb")], "a capo del vecchio Mac")

// MARK: debateTitle

check(debateTitle("  Titolo del giudice  ", question: "q"), "Titolo del giudice", "titolo del giudice")
check(debateTitle("", question: "come funziona il nucleare? e poi altro"), "Come funziona il nucleare?", "prima frase con ?")
check(debateTitle(nil, question: "uno due tre quattro cinque sei sette otto nove dieci"),
      "Uno due tre quattro cinque sei sette…", "prime 7 parole")
check(debateTitle(nil, question: "  spazi \n  e a capo  "), "Spazi e a capo", "spazi compressi")

// MARK: machineValue (MachineLine)

let changes = ["nessuno": "nessuno", "minori": "minori", "sostanziali": "sostanziali",
               "none": "nessuno", "minor": "minori", "substantial": "sostanziali"]
let trust = ["alta": "alta", "media": "media", "bassa": "bassa", "high": "alta", "medium": "media", "low": "bassa"]
check(MachineLine.value("testo\nCAMBIAMENTI: minori", keys: "CAMBIAMENTI|CHANGES", map: changes), "minori", "riga semplice")
check(MachineLine.value("**FIDUCIA:** alta", keys: "FIDUCIA|CONFIDENCE", map: trust), "alta", "con asterischi")
check(MachineLine.value("Confidence: High", keys: "FIDUCIA|CONFIDENCE", map: trust), "alta", "inglese, maiuscole")
check(MachineLine.value("FIDUCIA: bassa\n…\nFIDUCIA: media", keys: "FIDUCIA|CONFIDENCE", map: trust), "media", "vale l'ultima")
check(MachineLine.value("nessuna riga", keys: "FIDUCIA|CONFIDENCE", map: trust), nil, "assente")

// MARK: RenameTitle

check(RenameTitle.clean("  Titolo  "), "Titolo", "spazi ai lati tolti")
check(RenameTitle.clean("riga uno\nriga due"), "riga uno riga due", "a capo diventa spazio")
check(RenameTitle.clean("a\r\nb\n\nc"), "a b c", "a capo di Windows e righe vuote")
check(RenameTitle.clean(" \n "), "", "solo spazi e a capo: vuoto")
check(RenameTitle.clean("\tTab\t"), "Tab", "tabulazioni ai lati tolte")
check(RenameTitle.clean("Città è già"), "Città è già", "accenti invariati")
check(RenameTitle.maxLength, 120, "limite uguale al motore")

if failures.isEmpty {
    print("swift: \(total) prove, tutte passate")
} else {
    print("swift: \(failures.count) di \(total) prove fallite")
    for f in failures { print(f) }
    exit(1)
}
