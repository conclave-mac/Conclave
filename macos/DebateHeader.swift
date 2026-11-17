// Intestazione della vista del dibattito: stato, titolo e domanda, allegati, dettagli e partecipanti.

import SwiftUI

struct DebateHeader: View {
    @ObservedObject var store: CouncilStore
    let debate: DebateState
    /// Domanda lunga mostrata per intero (stato della vista del dibattito: la riga pigra può essere ricreata).
    @Binding var questionExpanded: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusBadge

            VStack(alignment: .leading, spacing: 6) {
                // Senza il titolo del giudice (dibattito in corso, discussioni vecchie) il titolo sarebbe
                // solo l'inizio della domanda, ripetuta subito sotto: si mostra la domanda una volta, come titolo.
                if let title = debate.title?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
                    Text(title)
                        .font(Brand.Fonts.pageTitle)
                        .lineLimit(2)
                        .textSelection(.enabled)
                        .accessibilityAddTraits(.isHeader)
                    questionText(font: Brand.Fonts.body)
                } else {
                    questionText(font: Brand.Fonts.section, isHeader: true)
                }
            }

            if !debate.attachments.isEmpty {
                AttachmentTags(items: debate.attachments)
            }

            Group {
                if debate.isRunning {
                    TimelineView(.periodic(from: .now, by: 1)) { _ in metaRow }
                } else {
                    metaRow
                }
            }

            if !participants.isEmpty {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(participants, id: \.letter) { p in
                        ParticipantTag(letter: p.letter, label: p.label)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(L("Partecipanti") + ": " + participants.map(\.label).joined(separator: ", "))
            }

            if !debate.isRunning, !["done", "cancelled"].contains(debate.status),
               debate.statusText != CouncilStore.statusText(debate.status) {
                Text(debate.statusText)
                    .font(Brand.Fonts.body)
                    .foregroundStyle(Brand.secondaryText)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Domande lunghe: tre righe e "Mostra tutto"; il testo intero resta nel tooltip.
    private var questionIsLong: Bool {
        debate.question.count > 240 || debate.question.filter(\.isNewline).count > 2
    }

    private func questionText(font: Font, isHeader: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(debate.question)
                .font(font)
                // Solo il testo è l'intestazione, non il pulsante "Mostra tutta la domanda".
                .accessibilityAddTraits(isHeader ? .isHeader : [])
                .foregroundStyle(Brand.text)
                .lineSpacing(3)
                .lineLimit(questionExpanded || !questionIsLong ? nil : 3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
                .help(questionIsLong && !questionExpanded ? debate.question : "")
                .accessibilityLabel(L("Domanda") + ": " + debate.question)
            if questionIsLong {
                Button(questionExpanded ? L("Mostra meno") : L("Mostra tutta la domanda")) {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { questionExpanded.toggle() }
                }
                .buttonStyle(.link)
                .font(Brand.Fonts.body)
            }
        }
    }

    /// Data, round, giudice e durata: voci separate con il proprio simbolo, su più righe se serve.
    private var metaRow: some View {
        FlowLayout(spacing: 18, lineSpacing: 8) {
            ForEach(headerMeta, id: \.symbol) { m in
                Label(m.text, systemImage: m.symbol)
            }
        }
        .font(Brand.Fonts.small)
        .foregroundStyle(Brand.secondaryText)
        .monospacedDigit()
        .accessibilityElement(children: .combine)
    }

    private var participants: [(letter: String, label: String)] {
        debate.participants.values.map { (letter: $0.letter, label: $0.label) }.sorted { $0.letter < $1.letter }
    }

    private static let headerDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = AppLanguage.locale
        f.dateStyle = .medium
        f.timeStyle = .short
        return f
    }()

    /// Data, poi round, giudice e durata (es. "7 nov 2026, 10:24", "3 round", "giudice Claude Sonnet", "durata 1 min 34 s").
    private var headerMeta: [(symbol: String, text: String)] {
        let rest = store.metaItems(debate)
        guard let s = debate.startedAt else { return rest }
        return [(symbol: "calendar", text: Self.headerDate.string(from: s))] + rest
    }

    /// Esito del dibattito in una capsula: simbolo e testo, mai solo colore.
    @ViewBuilder private var statusBadge: some View {
        if debate.isRunning {
            StatusBadge(text: debate.judging ? L("Verdetto in scrittura") : L("In corso"),
                        symbol: "circle.dotted", tint: Brand.amberWarm, pulse: !reduceMotion)
        } else {
            switch debate.status {
            case "done": StatusBadge(text: L("Completato"), symbol: "checkmark.circle.fill", tint: Brand.olive)
            case "cancelled": StatusBadge(text: L("Interrotto"), symbol: "stop.circle.fill", tint: Brand.secondaryText)
            case "interrupted": StatusBadge(text: L("Interrotto: il motore è stato riavviato"), symbol: "exclamationmark.triangle.fill", tint: Brand.warning)
            default: StatusBadge(text: L("Non riuscito"), symbol: "xmark.octagon.fill", tint: Brand.danger)
            }
        }
    }
}
