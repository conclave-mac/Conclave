// Barra laterale nativa (NSSplitViewController → Liquid Glass su macOS 26):
// in cima "Nuova discussione", poi la cronologia per data (filtrata dal campo di ricerca della toolbar),
// in fondo una barra fissa con il marchio e il pulsante Impostazioni.

import AppKit
import SwiftUI

struct DebateSummary: Decodable, Identifiable, Equatable {
    let id: Int
    let question: String
    let title: String?
    let status: String
    let created_at: String
    /// Ultima attività (una domanda di seguito la aggiorna); assente con motori vecchi.
    let updated_at: String?
    let parent_id: Int?
    /// Affidabilità del verdetto ("alta", "media", "bassa"); assente con motori vecchi.
    let confidence: String?
    var displayTitle: String { debateTitle(title, question: question) }
    /// Data che ordina e raggruppa la cronologia: ultima attività, altrimenti la creazione.
    var activity: String { updated_at ?? created_at }
}

@MainActor
final class SidebarModel: ObservableObject {
    @Published var items: [DebateSummary] = []
    @Published var query = ""
    @Published var selected: Int?
    /// Discussione per cui è aperta la conferma di eliminazione.
    @Published var pendingDelete: DebateSummary?
    /// true dopo il primo caricamento riuscito: prima non si mostra lo stato vuoto.
    @Published var loaded = false

    let port: () -> Int
    var onOpen: ((Int) -> Void)?
    var onDeleted: ((Int) -> Void)?
    var onExport: ((Int) -> Void)?
    var onNew: (() -> Void)?
    var onSettings: (() -> Void)?
    /// Ricerca aperta nella barra laterale (riga "Cerca" diventata campo).
    @Published var searching = false
    /// Cresce a ogni richiesta di fuoco (⌘F o clic su "Cerca").
    @Published var searchFocusRequest = 0
    private var searchTask: Task<Void, Never>?

    init(port: @escaping () -> Int) { self.port = port }

    func reload() {
        searchTask?.cancel()
        searchTask = Task {
            let q = query.trimmingCharacters(in: .whitespaces)
            var path = "/api/debates"
            if !q.isEmpty, let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "?q=\(enc)" }
            guard let data = try? await Engine.call(port(), "GET", path),
                  !Task.isCancelled,
                  let list = try? JSONDecoder().decode([DebateSummary].self, from: data) else { return }
            // Una discussione con una domanda di seguito nuova sale in cima. Le date del motore sono
            // "yyyy-MM-dd HH:mm:ss": l'ordine del testo è quello cronologico. Ordinamento stabile.
            items = list.enumerated().sorted { a, b in
                a.element.activity != b.element.activity ? a.element.activity > b.element.activity : a.offset < b.offset
            }.map(\.element)
            loaded = true
        }
    }

    /// Ricerca con breve attesa, per non interrogare il motore a ogni tasto.
    func queryChanged() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled else { return }
            reload()
        }
    }

    /// Chiede conferma per eliminare la discussione indicata (o quella selezionata).
    func requestDelete(_ id: Int? = nil) {
        guard let id = id ?? selected, let d = items.first(where: { $0.id == id }) else { return }
        pendingDelete = d
    }

    /// ⌘F o clic su "Cerca": apre il campo di ricerca della barra laterale e ci porta il fuoco.
    func focusSearch() {
        searching = true
        searchFocusRequest += 1
    }

    /// Chiude la ricerca: la lista non deve restare filtrata senza un campo per svuotarla.
    func endSearch() {
        searching = false
        guard !query.isEmpty else { return }
        query = ""
        reload()
    }

    func delete(_ id: Int) {
        Task {
            // Eliminazione non riuscita: la riga resta, l'elenco si riallinea al motore.
            guard (try? await Engine.call(port(), "DELETE", "/api/debates/\(id)")) != nil else { reload(); return }
            if selected == id { selected = nil }
            onDeleted?(id)
            reload()
        }
    }

    // Raggruppamento per data, come in Note e Mail.
    private static let parser: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return f
    }()

    private static let monthFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = AppLanguage.locale
        f.dateFormat = "LLLL yyyy"
        return f
    }()

    static func date(_ s: String) -> Date? { parser.date(from: s) }

    var groups: [(title: String, items: [DebateSummary])] {
        let cal = Calendar.current
        let today = cal.startOfDay(for: .now)
        var order: [String] = []
        var map: [String: [DebateSummary]] = [:]
        for d in items {
            let date = Self.date(d.activity) ?? .distantPast
            let days = cal.dateComponents([.day], from: cal.startOfDay(for: date), to: today).day ?? .max
            let title: String
            if days <= 0 { title = L("Oggi") }
            else if days == 1 { title = L("Ieri") }
            else if days < 7 { title = L("Ultimi 7 giorni") }
            else if days < 30 { title = L("Ultimi 30 giorni") }
            else if date == .distantPast { title = L("Precedenti") }
            else { title = Self.monthFormatter.string(from: date) }
            if map[title] == nil { order.append(title) }
            map[title, default: []].append(d)
        }
        return order.map { ($0, map[$0]!) }
    }
}

struct SidebarView: View {
    @ObservedObject var model: SidebarModel
    /// Riga sotto il puntatore: fondo grigio arrotondato come in Claude.
    @State private var hovered: Int?

    var body: some View {
        VStack(spacing: 0) {
            SidebarActionRow(title: L("Nuova discussione"), systemImage: "square.and.pencil",
                             help: L("Inizia una nuova discussione (⌘N)")) { model.onNew?() }
                .padding(.horizontal, 10).padding(.top, 6)
            SidebarSearchRow(model: model)
                .padding(.horizontal, 10).padding(.top, 2).padding(.bottom, 4)

            List(selection: Binding(get: { model.selected }, set: { id in
                // La lista riassegna la stessa selezione quando si aggiorna: va aperta solo
                // una discussione diversa, altrimenti quella in corso verrebbe ricaricata.
                guard id != model.selected else { return }
                model.selected = id
                if let id { model.onOpen?(id) }
            })) {
                ForEach(model.groups, id: \.title) { group in
                    Section {
                        ForEach(group.items) { d in
                            DebateRow(debate: d, selected: model.selected == d.id) { model.requestDelete(d.id) }
                                .tag(d.id)
                                // Selezione nel colore del marchio al posto dell'accento di sistema.
                                .listRowBackground(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .fill(model.selected == d.id ? Brand.selection
                                              : hovered == d.id ? Brand.hover : .clear)
                                        .padding(.horizontal, 10)
                                )
                                .background(SystemHighlightRemover())
                                .onHover { inside in
                                    if inside { hovered = d.id } else if hovered == d.id { hovered = nil }
                                }
                                // Solo le azioni più probabili, distruttive in fondo, niente scorciatoie.
                                .contextMenu {
                                    if d.status == "done" {
                                        Button("Esporta come Markdown…") { model.onExport?(d.id) }
                                        Divider()
                                    }
                                    Button("Elimina", role: .destructive) { model.requestDelete(d.id) }
                                }
                        }
                    } header: {
                        SidebarSectionHeader(title: group.title)
                    }
                }
            }
            .listStyle(.sidebar)
            .tint(Brand.accent)
            .overlay {
                if model.loaded && model.items.isEmpty {
                    if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
                        SidebarEmptyState(title: L("Nessuna discussione"), systemImage: "bubble.left.and.bubble.right",
                                          description: L("Le discussioni avviate compaiono qui."))
                    } else {
                        SidebarEmptyState(title: L("Nessun risultato"), systemImage: "magnifyingglass",
                                          description: String(format: L("Nessuna discussione contiene «%@»."),
                                                              model.query.trimmingCharacters(in: .whitespaces)))
                    }
                }
            }
            // Convenzione Mac: ⌫ sulla discussione selezionata la elimina (con conferma).
            .onDeleteCommand { model.requestDelete() }
        }
        // Barra fissa in fondo: solo l'ingranaggio delle Impostazioni, a sinistra (scelta dell'utente).
        // Nessuno sfondo opaco: resta sul vetro della barra laterale di sistema.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                Divider()
                HStack(spacing: 8) {
                    Button { model.onSettings?() } label: {
                        Image(systemName: "gearshape")
                            .font(Brand.Fonts.body)
                            .frame(width: 26, height: 26)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .help("Impostazioni (⌘,)")
                    .accessibilityLabel("Impostazioni")
                    Spacer(minLength: 0)
                }
                .foregroundStyle(Brand.text)
                .padding(.horizontal, 14).padding(.vertical, 8)
            }
        }
        .confirmationDialog(deleteTitle, isPresented: Binding(
            get: { model.pendingDelete != nil }, set: { if !$0 { model.pendingDelete = nil } }
        ), titleVisibility: .visible, presenting: model.pendingDelete) { d in
            Button("Elimina", role: .destructive) { model.delete(d.id) }
            Button("Annulla", role: .cancel) {}
        } message: { _ in
            Text("Non si può annullare.")
        }
    }

    private var deleteTitle: String {
        guard let q = model.pendingDelete?.displayTitle else { return L("Eliminare la discussione?") }
        let short = q.count > 60 ? String(q.prefix(60)) + "…" : q
        return String(format: L("Eliminare la discussione «%@»?"), short)
    }
}

/// Stato vuoto della barra laterale: compatto, nella scala del marchio. `ContentUnavailableView` usa un
/// titolo da 22 pt in grassetto che in una colonna di 220 pt va a capo e pesa più della finestra.
struct SidebarEmptyState: View {
    let title: String
    let systemImage: String
    let description: String

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 22))
                .foregroundStyle(Brand.tertiaryText)
                .padding(.bottom, 2)
                .accessibilityHidden(true)
            Text(title)
                .font(Brand.Fonts.bodyMedium)
                .foregroundStyle(Brand.secondaryText)
            Text(description)
                .font(Brand.Fonts.small)
                .foregroundStyle(Brand.secondaryText)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 20)
        .accessibilityElement(children: .combine)
    }
}

/// Intestazione di gruppo delle barre laterali ("Oggi", "Preferenze"): 12 pt, nero al 60%, come Claude.
struct SidebarSectionHeader: View {
    let title: String

    var body: some View {
        Text(title)
            .font(Brand.Fonts.smallMedium)
            .foregroundStyle(Brand.secondaryText)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Riga "Cerca": al clic (o con ⌘F) diventa il campo di ricerca, che filtra mentre si scrive.
/// Esc svuota il campo e, se è già vuoto, chiude la ricerca; si chiude anche perdendo il fuoco a campo vuoto.
struct SidebarSearchRow: View {
    @ObservedObject var model: SidebarModel
    @FocusState private var focused: Bool

    var body: some View {
        if model.searching {
            BrandSearchField(text: $model.query, prompt: L("Cerca"), focus: $focused, onEscapeEmpty: model.endSearch)
                .onChange(of: model.query) { model.queryChanged() }
                // Il fuoco va dato quando il campo è già nella finestra: in onAppear andrebbe perso.
                .task(id: model.searchFocusRequest) {
                    try? await Task.sleep(for: .milliseconds(50))
                    focused = true
                }
                .onChange(of: focused) { if !focused && model.query.isEmpty { model.endSearch() } }
        } else {
            SidebarActionRow(title: L("Cerca"), systemImage: "magnifyingglass",
                             help: L("Cerca nelle discussioni (⌘F)")) { model.focusSearch() }
        }
    }
}

/// Riga d'azione in cima alla barra laterale (icona + testo), evidenziata al passaggio del mouse.
struct SidebarActionRow: View {
    let title: String
    let systemImage: String
    let help: String
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemImage)
                    .frame(width: 18)
                    .accessibilityHidden(true)
                Text(title)
                Spacer(minLength: 0)
            }
            // Testo e icona come le righe della cronologia: 14 pt, stesso colore.
            .font(Brand.Fonts.body)
            .foregroundStyle(Brand.text)
            .padding(.horizontal, 8).padding(.vertical, 7)
            .contentShape(Rectangle())
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(hovering ? Brand.hover : .clear))
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(help)
    }
}

/// Riga della cronologia: titolo su una riga, senza orario (scelta dell'utente); sotto, solo se serve,
/// lo stato in testo ("In corso", "Non riuscito", "Approfondimento").
/// Al passaggio del mouse compare il pulsante ✕ (scorciatoia, non l'unico modo).
struct DebateRow: View {
    let debate: DebateSummary
    var selected = false
    let onDelete: () -> Void
    @State private var hovering = false

    /// Seconda riga facoltativa: stato non ordinario ed eventuale "Approfondimento".
    private var detail: String {
        var parts: [String] = []
        switch debate.status {
        case "running": parts.append(L("In corso"))
        case "failed": parts.append(L("Non riuscito"))
        case "cancelled": parts.append(L("Annullato"))
        case "interrupted": parts.append(L("Interrotto"))
        default: break
        }
        if debate.parent_id != nil { parts.append(L("Approfondimento")) }
        // Solo l'affidabilità bassa, l'unica che chiede attenzione: la cronologia resta pulita.
        if debate.status == "done", debate.confidence == "bassa" { parts.append(L("Affidabilità bassa")) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(debate.displayTitle)
                    .font(Brand.Fonts.body)  // mai in grassetto, nemmeno selezionata (come Claude)
                    .foregroundStyle(Brand.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .layoutPriority(0)
                ZStack(alignment: .trailing) {
                    if debate.status == "running" {
                        ProgressView().controlSize(.mini)
                            .accessibilityLabel("In corso")
                            .opacity(hovering ? 0 : 1)
                    }
                    Button(action: onDelete) {
                        Image(systemName: "xmark.circle.fill")
                            .symbolRenderingMode(.hierarchical)
                            .foregroundStyle(Brand.secondaryText)
                    }
                    .buttonStyle(.plain)
                    .help("Elimina")
                    .accessibilityLabel("Elimina discussione")
                    // Sempre presente per l'accessibilità, visibile solo al passaggio del mouse.
                    .opacity(hovering ? 1 : 0)
                }
                .fixedSize()
                .layoutPriority(1)
            }
            if !detail.isEmpty {
                Text(detail)
                    .font(Brand.Fonts.small)
                    .foregroundStyle(Brand.secondaryText)
                    .lineLimit(1)
            }
        }
        // Con il margine della lista dà righe a passo 34 pt, come Claude.
        .padding(.vertical, 1)
        .contentShape(Rectangle())
        .help(debate.question)
        .onHover { hovering = $0 }
        // VoiceOver: un solo elemento "titolo, stato" con l'azione Elimina (il ✕ è visibile solo al mouse).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(detail.isEmpty ? debate.displayTitle : "\(debate.displayTitle), \(detail)")
        .accessibilityAction(named: Text("Elimina discussione"), onDelete)
    }
}

/// Toglie l'evidenziazione di sistema (accento blu) dalla tabella che contiene la riga:
/// la selezione resta funzionante (frecce, ⌫) ma la disegna la riga nel colore del marchio.
struct SystemHighlightRemover: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Finder() }
    func updateNSView(_ v: NSView, context: Context) {}

    final class Finder: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            removeHighlight()
            // Alla prima apertura la riga entra nella finestra prima che la tabella la adotti:
            // senza questo secondo tentativo il primo clic mostrava la selezione blu di sistema.
            DispatchQueue.main.async { [weak self] in self?.removeHighlight() }
        }

        override func viewDidMoveToSuperview() {
            super.viewDidMoveToSuperview()
            removeHighlight()
        }

        private func removeHighlight() {
            var v: NSView? = superview
            while let cur = v, !(cur is NSTableView) { v = cur.superview }
            if let t = v as? NSTableView, t.selectionHighlightStyle != .none { t.selectionHighlightStyle = .none }
        }
    }
}
