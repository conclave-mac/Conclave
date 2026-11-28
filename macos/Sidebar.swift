// Barra laterale nativa (NSSplitViewController → Liquid Glass su macOS 26):
// in cima "Nuova discussione", poi la cronologia per data (filtrata dal campo di ricerca della toolbar),
// in fondo una barra fissa con il marchio e il pulsante Impostazioni.

import AppKit
import SwiftUI

struct DebateSummary: Decodable, Identifiable, Equatable {
    let id: Int
    let question: String
    var title: String?
    let status: String
    let created_at: String
    /// Ultima attività (una domanda di seguito la aggiorna); assente con motori vecchi.
    let updated_at: String?
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
    /// Discussione con il titolo in modifica (campo in linea nella riga, come nel Finder).
    @Published var renaming: Int?
    /// Errore dell'ultima rinomina (il titolo vecchio è già stato rimesso).
    @Published var renameError: String?
    /// true dopo il primo caricamento riuscito: prima non si mostra lo stato vuoto.
    @Published var loaded = false

    let port: () -> Int
    var onOpen: ((Int) -> Void)?
    var onDeleted: ((Int) -> Void)?
    var onExport: ((Int) -> Void)?
    /// Titolo salvato dal motore dopo una rinomina riuscita.
    var onRenamed: ((Int, String) -> Void)?
    var onNew: (() -> Void)?
    var onSettings: (() -> Void)?
    /// Lista appena caricata: l'app segue le discussioni in corso che non ha avviato lei (API, altra finestra).
    var onLoaded: (([DebateSummary]) -> Void)?
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
            let sorted = list.enumerated().sorted { a, b in
                a.element.activity != b.element.activity ? a.element.activity > b.element.activity : a.offset < b.offset
            }.map(\.element)
            // Stesse discussioni in un altro ordine (una sale in cima dopo una domanda di seguito): la riga
            // si sposta animata, come in Mail e Messaggi, salvo "Riduci movimento".
            let reordered = loaded && sorted.map(\.id) != items.map(\.id) && Set(sorted.map(\.id)) == Set(items.map(\.id))
            if reordered && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                withAnimation(.easeInOut(duration: 0.3)) { items = sorted }
            } else {
                items = sorted
            }
            if let r = renaming, !sorted.contains(where: { $0.id == r }) { renaming = nil }
            loaded = true
            onLoaded?(list)
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

    /// Apre il campo del titolo nella riga indicata (o in quella selezionata). Se la ricerca la nasconde,
    /// si torna alla lista intera: la riga compare con il campo già aperto.
    func beginRename(_ id: Int? = nil) {
        guard let id = id ?? selected else { return }
        if !items.contains(where: { $0.id == id }) { endSearch() }
        renaming = id
    }

    /// Fine della modifica in linea (Invio o fuoco perso). Titolo vuoto o uguale = nessun cambio, come
    /// nel Finder. Il titolo nuovo si vede subito; se il motore lo rifiuta torna quello vecchio con l'errore.
    func commitRename(_ id: Int, _ text: String) {
        guard renaming == id else { return }
        renaming = nil
        guard let i = items.firstIndex(where: { $0.id == id }) else { return }
        let title = RenameTitle.clean(text)
        guard !title.isEmpty, title != items[i].displayTitle else { return }
        guard title.utf16.count <= RenameTitle.maxLength else {
            renameError = String(format: L("Il titolo può avere al massimo %d caratteri."), RenameTitle.maxLength)
            return
        }
        let old = items[i].title
        items[i].title = title
        Task {
            do {
                let body = try JSONSerialization.data(withJSONObject: ["title": title])
                let data = try await Engine.call(port(), "PATCH", "/api/debates/\(id)", body: body)
                let saved = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["title"] as? String ?? title
                if let j = items.firstIndex(where: { $0.id == id }) { items[j].title = saved }
                onRenamed?(id, saved)
            } catch {
                if let j = items.firstIndex(where: { $0.id == id }), items[j].title == title { items[j].title = old }
                renameError = error.localizedDescription
            }
        }
    }

    func cancelRename() { renaming = nil }

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
}

struct SidebarView: View {
    @ObservedObject var model: SidebarModel
    /// Riga sotto il puntatore: fondo grigio arrotondato come in Claude. Sta in un oggetto osservabile
    /// letto solo dai fondi delle righe: con uno `@State` qui ogni movimento del puntatore ricalcolava
    /// tutta la lista (e il `SystemHighlightRemover` di ogni riga), e l'hover arrivava in ritardo.
    @State private var hover = SidebarHover<Int>()
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        content
            // "Riduci trasparenza" acceso ad app aperta: SwiftUI non rilegge `Brand.sidebarTint` (messo
            // sotto questa vista da main.swift), quindi il fondo opaco lo mette la barra stessa.
            .background {
                if reduceTransparency || DisplayOptions.opaque {
                    Brand.sidebarTintOpaque.ignoresSafeArea()
                }
            }
    }

    private var content: some View {
        VStack(spacing: 0) {
            SidebarActionRow(title: L("Nuova discussione"), systemImage: "square.and.pencil",
                             help: L("Inizia una nuova discussione (⌘N)")) { model.onNew?() }
                .padding(.horizontal, 10).padding(.top, 6)
            SidebarSearchRow(model: model)
                .padding(.horizontal, 10).padding(.top, 2).padding(.bottom, 4)

            ScrollViewReader { proxy in
                List(selection: Binding(get: { model.selected }, set: { id in
                    // La lista riassegna la stessa selezione quando si aggiorna: va aperta solo
                    // una discussione diversa, altrimenti quella in corso verrebbe ricaricata.
                    guard id != model.selected else { return }
                    model.selected = id
                    if let id { model.onOpen?(id) }
                })) {
                    ForEach(model.items) { d in
                        DebateRow(debate: d, selected: model.selected == d.id, hover: hover,
                                  renaming: model.renaming == d.id,
                                  onRename: { model.commitRename(d.id, $0) }, onCancelRename: model.cancelRename) { model.requestDelete(d.id) }
                            .tag(d.id)
                            // Selezione nel colore del marchio al posto dell'accento di sistema.
                            .listRowBackground(SidebarRowBackground(id: d.id, selected: model.selected == d.id, hover: hover))
                            .background(SystemHighlightRemover(selected: model.selected == d.id))
                    }
                }
                // Solo le azioni più probabili, distruttive in fondo, niente scorciatoie. Doppio clic (e Invio
                // sulla riga selezionata, come nel Finder) apre il campo del titolo.
                .contextMenu(forSelectionType: Int.self) { ids in
                    if ids.count == 1, let id = ids.first, let d = model.items.first(where: { $0.id == id }) {
                        Button("Rinomina…") { model.beginRename(id) }
                        if d.status == "done" {
                            Button("Esporta come Markdown…") { model.onExport?(id) }
                        }
                        Divider()
                        Button("Elimina", role: .destructive) { model.requestDelete(id) }
                    }
                } primaryAction: { ids in
                    if ids.count == 1, let id = ids.first { model.beginRename(id) }
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
                // Una discussione che entra in cima (nuova o con una domanda di seguito) si deve vedere: la
                // tabella resta ancorata alla riga che era in cima e la nuova finirebbe sopra, fuori vista.
                .onChange(of: model.items.first?.id) { _, first in
                    if let first { proxy.scrollTo(first, anchor: .top) }
                }
                // Rinomina dal menu File: la riga deve essere visibile.
                .onChange(of: model.renaming) { _, id in
                    if let id { proxy.scrollTo(id) }
                }
            }

            // Barra fissa in fondo: solo l'ingranaggio delle Impostazioni, a sinistra (scelta dell'utente).
            // Nessuno sfondo opaco: resta sul vetro della barra laterale di sistema. Sta sotto la lista
            // nella pila, come in Note e Mail: con `safeAreaInset` le righe le scorrevano sotto e il
            // testo si sovrapponeva all'ingranaggio; `safeAreaBar` disegnava invece una fascia bianca.
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
        .alert(L("Impossibile rinominare la discussione"), isPresented: Binding(
            get: { model.renameError != nil }, set: { if !$0 { model.renameError = nil } }
        )) {
            Button("OK") {}
        } message: {
            Text(model.renameError ?? "")
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

/// Intestazione di gruppo delle barre laterali ("Preferenze", "Consiglio"): 12 pt, nero al 60%, come Claude.
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
/// lo stato in testo ("In corso", "Non riuscito").
/// Al passaggio del mouse compare il pulsante ✕ (scorciatoia, non l'unico modo).
struct DebateRow: View {
    let debate: DebateSummary
    var selected = false
    /// Riga sotto il puntatore, condivisa con il fondo della riga (`SidebarRowBackground`).
    let hover: SidebarHover<Int>
    /// Titolo in modifica: al posto della riga c'è il campo in linea.
    var renaming = false
    var onRename: (String) -> Void = { _ in }
    var onCancelRename: () -> Void = {}
    let onDelete: () -> Void
    @State private var hovering = false

    /// Seconda riga facoltativa: stato non ordinario.
    private var detail: String {
        var parts: [String] = []
        switch debate.status {
        case "running": parts.append(L("In corso"))
        case "failed": parts.append(L("Non riuscito"))
        case "cancelled": parts.append(L("Annullato"))
        case "interrupted": parts.append(L("Interrotto"))
        default: break
        }
        // Solo l'affidabilità bassa, l'unica che chiede attenzione: la cronologia resta pulita.
        if debate.status == "done", debate.confidence == "bassa" { parts.append(L("Affidabilità bassa")) }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        if renaming {
            RenameField(initial: debate.displayTitle, onCommit: onRename, onCancel: onCancelRename)
                .padding(.vertical, 1)
        } else {
            row
        }
    }

    private var row: some View {
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
        .onHover { inside in
            hovering = inside
            hover.set(debate.id, inside)
        }
        // Riga tolta mentre è sotto il puntatore (eliminata, filtrata dalla ricerca): l'uscita non arriva
        // e la riga ricomparirebbe grigia.
        .onDisappear { hover.set(debate.id, false) }
        // VoiceOver: un solo elemento "titolo, stato" con l'azione Elimina (il ✕ è visibile solo al mouse).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(detail.isEmpty ? debate.displayTitle : "\(debate.displayTitle), \(detail)")
        .accessibilityAction(named: Text("Elimina discussione"), onDelete)
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

/// Campo del titolo nella riga della cronologia, come nel Finder e in Note: testo già selezionato,
/// Invio conferma, Esc annulla, un clic altrove (fuoco perso) conferma.
struct RenameField: View {
    let initial: String
    let onCommit: (String) -> Void
    let onCancel: () -> Void
    @State private var text = ""
    @State private var finished = false
    @FocusState private var focused: Bool

    var body: some View {
        TextField(L("Titolo"), text: $text)
            .textFieldStyle(.roundedBorder)
            .font(Brand.Fonts.body)
            .focused($focused)
            .onSubmit { finish(commit: true) }
            .onExitCommand { finish(commit: false) }
            .onChange(of: focused) { _, now in if !now { finish(commit: true) } }
            .accessibilityLabel(L("Titolo della discussione"))
            // Il fuoco va dato quando il campo è già nella finestra: in onAppear andrebbe perso.
            .task {
                text = initial
                try? await Task.sleep(for: .milliseconds(50))
                focused = true
            }
    }

    private func finish(commit: Bool) {
        guard !finished else { return }
        finished = true
        if commit { onCommit(text) } else { onCancel() }
    }
}

/// Riga della cronologia sotto il puntatore. Osservabile (Observation): al suo cambio si ridisegnano
/// solo i fondi delle righe che la leggono, non la lista.
@Observable
final class SidebarHover<ID: Hashable> {
    var id: ID?

    func set(_ row: ID, _ inside: Bool) {
        if inside { if id != row { id = row } } else if id == row { id = nil }
    }
}

/// Fondo di una riga della cronologia: selezione nel colore del marchio, altrimenti grigio al passaggio
/// del mouse. Vista a sé, così solo lei legge `hover.id`.
struct SidebarRowBackground<ID: Hashable>: View {
    let id: ID
    let selected: Bool
    let hover: SidebarHover<ID>

    var body: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(selected ? Brand.selection : hover.id == id ? Brand.hover : .clear)
            .padding(.horizontal, 10)
            // L'hover segue subito il puntatore: nessuna animazione ereditata da un aggiornamento animato.
            .transaction { $0.animation = nil }
    }
}

/// Toglie l'evidenziazione di sistema (accento blu) dalla tabella che contiene la riga:
/// la selezione resta funzionante (frecce, ⌫) ma la disegna la riga nel colore del marchio.
/// `selected` fa ripetere il controllo a ogni cambio di selezione: senza gruppi nella lista la riga
/// può entrare nella finestra prima della tabella e il primo clic tornava blu.
struct SystemHighlightRemover: NSViewRepresentable {
    var selected = false

    func makeNSView(context: Context) -> NSView { Finder() }
    func updateNSView(_ v: NSView, context: Context) {
        guard let f = v as? Finder else { return }
        f.removeHighlight()
        DispatchQueue.main.async { [weak f] in f?.removeHighlight() }
    }

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

        func removeHighlight() {
            var v: NSView? = superview
            while let cur = v, !(cur is NSTableView) {
                // Ogni riga copia lo stile della tabella quando nasce: la prima della lista nasce
                // prima che lo si cambi sulla tabella e restava blu.
                if let row = cur as? NSTableRowView, row.selectionHighlightStyle != .none { row.selectionHighlightStyle = .none }
                v = cur.superview
            }
            if let t = v as? NSTableView {
                if t.selectionHighlightStyle != .none { t.selectionHighlightStyle = .none }
                t.enumerateAvailableRowViews { row, _ in
                    if row.selectionHighlightStyle != .none { row.selectionHighlightStyle = .none }
                }
            }
        }
    }
}
