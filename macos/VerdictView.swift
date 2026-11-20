// Risultato di un dibattito o di un turno del consiglio: verdetto del giudice con affidabilità, azioni
// (copia, esporta, condividi) e la sintesi del dibattito in fondo; segnaposto mentre il giudice scrive.

import AppKit
import SwiftUI

struct DebateResult: View {
    @ObservedObject var store: CouncilStore
    let debate: DebateState
    let text: String?
    /// Verdetto in arrivo (streaming): si mostra al posto del segnaposto finché non arriva `text`.
    var draft: String? = nil
    let verdictBy: String?
    let confidence: String?
    /// "verdict" o "turn-<n>": quale verdetto è stato appena copiato.
    let key: String
    /// Verdetto appena copiato, per la spunta sul pulsante (stato della vista del dibattito).
    @Binding var copiedKey: String?
    var saveFile: (_ filename: String, _ text: String) -> Void
    /// Zoom del testo (⌘+ ⌘-): le intestazioni della sintesi crescono con il testo del Markdown.
    @AppStorage(TextZoom.key) private var zoom = 1.0

    // MARK: Azioni sul verdetto

    /// Pulsanti-icona in alto a destra del verdetto, ciascuno con tooltip e nome per VoiceOver.
    private func actions(_ verdict: String, key: String) -> some View {
        let copied = copiedKey == key
        return HStack(spacing: 2) {
            IconButton(copied ? L("Copiato") : L("Copia verdetto")) {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(verdict, forType: .string)
                copiedKey = key
                AccessibilityNotification.Announcement(L("Verdetto copiato")).post()
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(2))
                    if copiedKey == key { copiedKey = nil }
                }
            } icon: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(copied ? AnyShapeStyle(Brand.success) : AnyShapeStyle(Brand.secondaryText))
                    .contentTransition(.symbolEffect(.replace))
            }
            IconButton(L("Esporta come Markdown…"), symbol: "arrow.down.doc") {
                if let e = store.exportMarkdown() { saveFile(e.filename, e.text) }
            }
            ShareLink(item: verdict, subject: Text(debate.displayTitle)) {
                Image(systemName: "square.and.arrow.up")
                    .font(.system(size: 14))
                    .frame(width: 30, height: 30)
                    .contentShape(Rectangle())
            }
            .buttonStyle(HoverIconStyle())
            .help(L("Condividi il verdetto"))
            .accessibilityLabel(L("Condividi il verdetto"))
        }
    }

    /// Segnaposto mentre il giudice scrive il verdetto.
    private var judgingPlaceholder: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(L("Il giudice sta scrivendo il verdetto…")).font(Brand.Fonts.body)
                .foregroundStyle(Brand.secondaryText)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceBox(radius: Brand.Radius.panel, stroke: Brand.hairline)
        .accessibilityElement(children: .combine)
    }

    // MARK: Risultato: sintesi del dibattito e verdetto

    /// Verdetto con la sintesi del dibattito in fondo (se il giudice l'ha scritta), oppure il segnaposto
    /// mentre il giudice scrive.
    var body: some View {
        if let text {
            let parts = CouncilStore.verdictParts(text)
            verdictBox(parts.verdict, summary: parts.debate, by: verdictBy, confidence: confidence, key: key,
                       copyText: CouncilStore.plainVerdict(text))
        } else if let draft, !draft.isEmpty {
            draftBox(draft)
        } else {
            judgingPlaceholder
        }
    }

    /// Bozza del verdetto mentre il giudice scrive: solo testo, senza azioni (copia ed esportazione valgono per
    /// il verdetto definitivo, che la sostituisce per intero).
    private func draftBox(_ draft: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(L("Il giudice sta scrivendo il verdetto…")).font(Brand.Fonts.small)
                    .foregroundStyle(Brand.secondaryText)
            }
            .accessibilityHidden(true)
            MarkdownView(draft)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceBox(radius: Brand.Radius.panel, stroke: Brand.hairline)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(L("Il giudice sta scrivendo il verdetto…"))
    }

    /// Su cosa concordano, errori emersi, disaccordi irrisolti: area interna in fondo al verdetto,
    /// su fondo grigio tenue per distinguerla dalla risposta.
    private func debateSummary(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Brand.secondaryText)
                    .accessibilityHidden(true)
                Text(L("Il dibattito in breve"))
                    .font(Brand.Fonts.section)
                    .accessibilityAddTraits(.isHeader)
            }
            .help(L("Cosa è emerso confrontando le risposte: accordi, errori trovati e disaccordi rimasti."))
            .padding(.horizontal, 18)
            .padding(.top, 14)

            // I titoli interni del giudice ("## Su cosa concordano"…) diventano intestazioni di gruppo
            // piccole e grigie, come quelle delle barre laterali: con i titoli Markdown (16 pt) erano
            // più grandi del titolo del riquadro (15 pt) e la gerarchia era piatta.
            VStack(alignment: .leading, spacing: 14) {
                ForEach(Array(Self.summarySections(text).enumerated()), id: \.offset) { _, s in
                    VStack(alignment: .leading, spacing: 4) {
                        if let title = s.title {
                            Text(title)
                                .font(zoom == 1 ? Brand.Fonts.smallSemibold : .system(size: 12 * zoom, weight: .semibold))
                                .foregroundStyle(Brand.secondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityAddTraits(.isHeader)
                        }
                        if !s.body.isEmpty { MarkdownView(s.body) }
                    }
                }
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Brand.Radius.card, style: .continuous).fill(Brand.hover))
        .accessibilityElement(children: .contain)
    }

    /// Affidabilità secondo il giudice: testo e simbolo, il colore è solo una seconda codifica.
    @ViewBuilder private func confidenceBadge(_ confidence: String?) -> some View {
        if let c = CouncilStore.confidenceText(confidence) {
            StatusBadge(text: c,
                        symbol: confidence == "alta" ? "checkmark.shield.fill"
                            : confidence == "media" ? "exclamationmark.shield.fill" : "xmark.shield.fill",
                        tint: confidence == "alta" ? Brand.olive : confidence == "media" ? Brand.amberWarm : Brand.rose)
                .fixedSize()
                .help(L("Quanto il giudice ritiene affidabile la risposta: accordo tra i modelli, solidità degli argomenti e punti da verificare."))
        }
    }

    /// Sintesi divisa nelle sue sezioni: titolo Markdown ("## …", senza #) e testo sotto.
    /// Le righe dentro i blocchi di codice non contano come titoli.
    static func summarySections(_ text: String) -> [(title: String?, body: String)] {
        var out: [(title: String?, body: String)] = []
        var title: String?
        var lines: [String] = []
        var fence = false
        func flush() {
            let body = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if title != nil || !body.isEmpty { out.append((title, body)) }
            lines = []
        }
        for line in text.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("```") || t.hasPrefix("~~~") { fence.toggle() }
            if !fence, t.hasPrefix("#") {
                let hashes = t.prefix { $0 == "#" }.count
                let rest = t.dropFirst(hashes)
                if hashes <= 6, rest.first == " " {
                    flush()
                    let h = rest.trimmingCharacters(in: .whitespaces)
                    title = h.trimmingCharacters(in: CharacterSet(charactersIn: "#* ").union(.whitespaces))
                    continue
                }
            }
            lines.append(line)
        }
        flush()
        return out
    }

    // MARK: Verdetto: scheda protagonista

    private func verdictBox(_ text: String, summary: String?, by verdictBy: String?, confidence: String?, key: String, copyText: String) -> some View {
        let seal = Image(systemName: "checkmark.seal.fill")
            .font(.system(size: 17))
            .foregroundStyle(Brand.clay)
            .frame(width: 36, height: 36)
            .background(Circle().fill(Brand.clay.opacity(0.12)))
            .accessibilityHidden(true)
        let heading = VStack(alignment: .leading, spacing: 1) {
            Text(L("Verdetto del consiglio"))
                .font(Brand.Fonts.section)
                .foregroundStyle(Brand.text)
            if let by = verdictBy, !by.isEmpty {
                Text(String(format: L("Giudice: %@"), by))
                    .font(Brand.Fonts.small)
                    .foregroundStyle(Brand.secondaryText)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        return VStack(alignment: .leading, spacing: 0) {
            // A finestra stretta l'affidabilità va su una seconda riga invece di spezzare il titolo.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    seal
                    heading.fixedSize()
                    confidenceBadge(confidence)
                    Spacer(minLength: 8)
                    actions(copyText, key: key)
                }
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .center, spacing: 12) {
                        seal
                        heading.fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                        actions(copyText, key: key)
                    }
                    confidenceBadge(confidence).padding(.leading, 48)
                }
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 14)

            Rectangle().fill(Brand.hairline).frame(height: 1).accessibilityHidden(true)

            MarkdownView(text)
                .frame(maxWidth: 720, alignment: .leading)
                .padding(.horizontal, 22)
                .padding(.top, 18)
                .padding(.bottom, summary == nil ? 24 : 0)

            if let summary {
                debateSummary(summary)
                    .padding(.horizontal, 16)
                    .padding(.top, 22)
                    .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Brand.Radius.panel, style: .continuous).fill(Brand.verdictSurface))
        .clipShape(RoundedRectangle(cornerRadius: Brand.Radius.panel, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Brand.Radius.panel, style: .continuous).strokeBorder(Brand.hairline, lineWidth: 1))
        .shadow(color: .black.opacity(0.07), radius: 18, y: 6)
    }
}
