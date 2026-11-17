// Contenuto della finestra principale in SwiftUI nativo: composer (nuova domanda) e dibattito.
// Sfondo e riquadri con i token di Brand.swift; nessun effetto vetro nel contenuto (linee guida macOS 26).

import AppKit
import SwiftUI

// MARK: - Radice

struct ContentRoot: View {
    @ObservedObject var store: CouncilStore
    var openSettings: () -> Void
    var openModels: () -> Void
    var saveFile: (_ filename: String, _ text: String) -> Void

    var body: some View {
        Group {
            if let d = store.current {
                DebateView(store: store, debate: d, saveFile: saveFile)
                    .id(d.id)
            } else {
                ComposerView(store: store, openSettings: openSettings, openModels: openModels)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // Corpo e colore del testo uguali in chat, barra laterale e Impostazioni; i testi piccoli
        // (didascalie, note) dichiarano il loro font e colore e restano come sono.
        .font(Brand.Fonts.body)
        .foregroundStyle(Brand.text)
        // Lo sfondo di marchio sta sotto tutta la finestra (main.swift): qui niente sfondo opaco.
        .tint(Brand.accent)
    }
}

// MARK: - Elementi comuni

/// Riquadro del contenuto: superficie del marchio, bordo sottile, angoli continui.
struct SurfaceBox: ViewModifier {
    var radius: CGFloat = 12
    var stroke: Color = Brand.hairline
    var shadow = false

    func body(content: Content) -> some View {
        content
            .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(Brand.surface))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(stroke, lineWidth: 1))
            .shadow(color: .black.opacity(shadow ? 0.08 : 0), radius: 14, y: 4)
    }
}

extension View {
    func surfaceBox(radius: CGFloat = 12, stroke: Color = Brand.hairline, shadow: Bool = false) -> some View {
        modifier(SurfaceBox(radius: radius, stroke: stroke, shadow: shadow))
    }
}

/// Pulsante-icona secondario: area di clic 30 pt, sfondo leggero al passaggio del mouse,
/// tooltip e nome per VoiceOver sempre presenti.
struct IconButton<Icon: View>: View {
    let label: String
    let help: String
    let action: () -> Void
    @ViewBuilder var icon: () -> Icon

    init(_ label: String, help: String? = nil, action: @escaping () -> Void, @ViewBuilder icon: @escaping () -> Icon) {
        self.label = label
        self.help = help ?? label
        self.action = action
        self.icon = icon
    }

    var body: some View {
        Button(action: action) {
            icon()
                .font(.system(size: 14))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(HoverIconStyle())
        .help(help)
        .accessibilityLabel(label)
    }
}

extension IconButton where Icon == Image {
    init(_ label: String, symbol: String, help: String? = nil, action: @escaping () -> Void) {
        self.init(label, help: help, action: action) { Image(systemName: symbol) }
    }
}

struct HoverIconStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { HoverBody(configuration: configuration) }

    struct HoverBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .foregroundStyle(enabled ? AnyShapeStyle(Brand.secondaryText) : AnyShapeStyle(Brand.tertiaryText))
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color.primary.opacity(configuration.isPressed ? 0.12 : hover && enabled ? 0.06 : 0))
                )
                .onHover { hover = $0 }
        }
    }
}

// MARK: - Pezzi comuni ai due riquadri di scrittura (composer e domanda di seguito)

/// "15.234 / 20.000": compare vicino al limite; colore di avviso, di pericolo oltre il limite.
private struct QuestionCounter: View {
    let length: Int
    /// Spiegazione oltre il limite (dice cosa non si può fare finché la domanda è troppo lunga).
    let overHelp: String

    var body: some View {
        let n = length, max = AttachmentLimits.maxQuestion
        if n > AttachmentLimits.questionWarning {
            HStack {
                Spacer()
                Text(verbatim: "\(formatCount(n)) / \(formatCount(max))")
                    .font(Brand.Fonts.smallMedium)
                    .monospacedDigit()
                    .foregroundStyle(n > max ? Brand.danger : Brand.warning)
                    .help(n > max ? overHelp : String(format: L("La domanda può avere al massimo %@ caratteri."), formatCount(max)))
                    .accessibilityLabel(String(format: L("%@ caratteri su %@"), formatCount(n), formatCount(max)))
            }
        }
    }
}

/// Pulsante rotondo d'invio con la freccia (↩ nel campo, ⌘↩ ovunque); rotella mentre si invia.
private struct SendButton: View {
    let enabled: Bool
    let busy: Bool
    let label: String
    let help: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle().fill(enabled ? AnyShapeStyle(Brand.accent) : AnyShapeStyle(Color.primary.opacity(0.12)))
                if busy {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(enabled ? AnyShapeStyle(.white) : AnyShapeStyle(Brand.tertiaryText))
                }
            }
            .frame(width: 32, height: 32)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .keyboardShortcut(.return, modifiers: .command)
        .help(help)
        .accessibilityLabel(label)
    }
}

/// Invio come nella chat di Claude: ↩ invia, ⇧↩ o ⌥↩ vanno a capo. ⌘↩ resta al pulsante d'invio.
private struct SubmitOnReturn: ViewModifier {
    let action: () -> Void

    func body(content: Content) -> some View {
        content.onKeyPress(.return, phases: .down) { press in
            if press.modifiers.contains(.command) { return .ignored }
            if !press.modifiers.isDisjoint(with: [.shift, .option]) {
                // Nel campo AppKit ⇧↩ chiude la modifica e seleziona tutto: l'a capo va inserito qui,
                // nel punto del cursore, come fa ⌥↩.
                NSApp.sendAction(#selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)), to: nil, from: nil)
                return .handled
            }
            action()
            return .handled
        }
    }
}

/// Graffetta: sceglie i file da allegare (al massimo `AttachmentLimits.maxFiles`).
private struct AttachButton: View {
    let count: Int
    let add: ([URL]) -> Void

    var body: some View {
        IconButton(L("Allega file…"), symbol: "paperclip",
                   help: String(format: L("Allega PDF, file di testo o immagini (al massimo %d). Puoi anche trascinarli qui o incollarli."),
                                AttachmentLimits.maxFiles)) {
            chooseAttachments(add)
        }
        .disabled(count >= AttachmentLimits.maxFiles)
    }
}

/// Avvisi sugli allegati: limite raggiunto o file non supportato, e cosa impedisce l'invio.
private struct AttachmentWarnings: View {
    let notice: String?
    let items: [AttachmentItem]

    var body: some View {
        if let n = notice {
            Label(n, systemImage: "exclamationmark.triangle")
                .foregroundStyle(Brand.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
        if let p = CouncilStore.problem(of: items), !items.contains(where: \.loading) {
            Label(p, systemImage: "exclamationmark.circle")
                .foregroundStyle(Brand.danger)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Riquadro di scrittura: superficie con ombra, bordo d'accento con il fuoco o con file trascinati
/// sopra, e rilascio dei file come allegati.
private struct ComposerSurface: ViewModifier {
    let focused: Bool
    @Binding var dropTargeted: Bool
    let add: ([URL]) -> Void

    func body(content: Content) -> some View {
        content
            .surfaceBox(radius: Brand.Radius.composer,
                        stroke: dropTargeted ? Brand.accent : focused ? Brand.accent.opacity(0.45) : Brand.hairline, shadow: true)
            .overlay {
                if dropTargeted {
                    RoundedRectangle(cornerRadius: Brand.Radius.composer, style: .continuous)
                        .fill(Brand.accent.opacity(0.06))
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .dropDestination(for: URL.self) { urls, _ in
                let files = urls.filter(\.isFileURL)
                guard !files.isEmpty else { return false }
                add(files)
                return true
            } isTargeted: { dropTargeted = $0 }
    }
}

private extension View {
    func composerSurface(focused: Bool, dropTargeted: Binding<Bool>, add: @escaping ([URL]) -> Void) -> some View {
        modifier(ComposerSurface(focused: focused, dropTargeted: dropTargeted, add: add))
    }
}

// MARK: - Composer

struct ComposerView: View {
    @ObservedObject var store: CouncilStore
    var openSettings: () -> Void
    var openModels: () -> Void
    @FocusState private var focused: Bool
    /// File trascinati sopra il riquadro della domanda.
    @State private var dropTargeted = false
    @State private var pasteMonitor = AttachmentPasteMonitor()

    private var hasOtherVoices: Bool { store.voices.contains { !$0.isClaude } }
    private var troubled: [VoiceInfo] { store.voices.filter { $0.problem != nil } }

    /// Invito secondo l'ora del giorno, sul tema del consiglio (non i saluti di Claude).
    private var greeting: String {
        switch Calendar.current.component(.hour, from: .now) {
        case 5..<13: return L("Cosa mettiamo ai voti stamattina?")
        case 13..<18: return L("Su cosa ci confrontiamo oggi?")
        case 18..<24: return L("Una questione per stasera?")
        default: return L("Il consiglio non dorme mai")
        }
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) {
                    Spacer(minLength: 32)
                    welcome.padding(.bottom, 28)

                    VStack(alignment: .leading, spacing: 10) {
                        composerBox
                        optionsRow.padding(.horizontal, 6)
                        messages.padding(.horizontal, 6)
                    }
                    .frame(maxWidth: 720)

                    Spacer(minLength: 48)
                }
                .padding(.horizontal, 28)
                .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
        }
        .onAppear {
            focused = true
            pasteMonitor.start { [store] urls, image in
                if let image { store.addPastedImage(image) } else { store.addAttachments(urls) }
            }
        }
        .onDisappear { pasteMonitor.stop() }
    }

    // MARK: Benvenuto

    private var welcome: some View {
        VStack(spacing: 12) {
            CouncilLogo(size: 48)
            Text(greeting)
                .font(.system(size: 34, weight: .semibold))
                .accessibilityAddTraits(.isHeader)
            Text("Fai una domanda: più AI ne discutono e un giudice decide.")
                .font(.system(size: 15))
                .foregroundStyle(Brand.secondaryText)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: Riquadro della domanda

    private var composerBox: some View {
        VStack(alignment: .leading, spacing: 14) {
            TextField("Domanda", text: $store.question, prompt: Text("Cosa vuoi chiedere al consiglio?"), axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .lineLimit(3...12)
                .lineSpacing(2)
                .focused($focused)
                .modifier(SubmitOnReturn { Task { await store.start() } })
                .accessibilityLabel(L("Domanda"))

            if !store.attachments.isEmpty {
                AttachmentChips(items: store.attachments) { store.removeAttachment($0) }
            }

            QuestionCounter(length: store.questionLength,
                            overHelp: String(format: L("La domanda supera il limite di %@ caratteri: accorciala per avviare il dibattito."),
                                             formatCount(AttachmentLimits.maxQuestion)))

            Rectangle().fill(Brand.hairline).frame(height: 1).accessibilityHidden(true)

            Text(L("Partecipano"))
                .font(Brand.Fonts.smallSemibold)
                .foregroundStyle(Brand.secondaryText)
                .padding(.bottom, -6)
                .accessibilityHidden(true)

            HStack(alignment: .bottom, spacing: 12) {
                FlowLayout(spacing: 6, lineSpacing: 6) {
                    IconButton(L("Aggiungi modelli…"), symbol: "plus",
                               help: store.lockedCount > 0
                                   ? (store.lockedCount == 1 ? L("Aggiungi modelli: 1 voce richiede una chiave API")
                                      : String(format: L("Aggiungi modelli: %d voci richiedono una chiave API"), store.lockedCount))
                                   : L("Aggiungi modelli (scheda Modelli delle Impostazioni)"),
                               action: openModels)
                    ForEach(store.voices) { v in
                        Toggle(store.displayName(v), isOn: Binding(get: { store.selected.contains(v.id) },
                                                                    set: { _ in store.toggle(v.id) }))
                            .toggleStyle(VoiceChipStyle(problem: v.problem, provider: v.provider,
                                                        role: store.selected.contains(v.id) && store.rounds >= 1 ? store.roles[v.id] : nil))
                            .contextMenu {
                                Picker(L("Ruolo nel round di critica"), selection: Binding(
                                    get: { store.roles[v.id] ?? "" }, set: { store.setRole($0.isEmpty ? nil : $0, for: v.id) })) {
                                    Text(L("Nessun ruolo")).tag("")
                                    Text(L("Avvocato del diavolo")).tag("devil")
                                    Text(L("Verificatore di fatti")).tag("checker")
                                }
                                .pickerStyle(.inline)
                            }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .contain)
                .accessibilityLabel(L("Partecipano"))

                AttachButton(count: store.attachments.count) { store.addAttachments($0) }

                SendButton(enabled: store.canStart, busy: store.starting, label: L("Avvia il dibattito"),
                           help: store.questionTooLong
                               ? String(format: L("La domanda supera il limite di %@ caratteri: accorciala per avviare il dibattito."), formatCount(AttachmentLimits.maxQuestion))
                               : store.attachmentProblem ?? L("Avvia il dibattito (↩)")) {
                    Task { await store.start() }
                }
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .composerSurface(focused: focused, dropTargeted: $dropTargeted) { store.addAttachments($0) }
    }

    // MARK: Opzioni sotto il riquadro: menu leggeri e stima

    /// Finestra larga: tutto su una riga. Più stretta: la stima va sotto, poi anche l'interruttore.
    /// I controlli tengono sempre la loro larghezza: le etichette non si troncano né si spezzano.
    private var optionsRow: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                roundsMenu; judgeMenu; webToggle
                Spacer(minLength: 8)
                estimate
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) { roundsMenu; judgeMenu; webToggle }
                estimate
            }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 14) { roundsMenu; judgeMenu }
                webToggle
                estimate
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .menuStyle(.button)
        .buttonStyle(.borderless)
        .menuIndicator(.visible)
        .font(Brand.Fonts.body)
        .foregroundStyle(Brand.secondaryText)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var roundsMenu: some View {
        Menu {
            Picker("Round", selection: $store.rounds) {
                ForEach([0, 1, 2, 3], id: \.self) { r in
                    Text(verbatim: CouncilStore.roundsTitles[r] ?? "\(r)").tag(r)
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Label(CouncilStore.roundsLabel(store.rounds), systemImage: "arrow.triangle.2.circlepath")
        }
        .tint(Brand.text)  // menu neutri come in Claude, non nell'accento
        .fixedSize()
        .help(L("Velocità: quanti round di critica tra i modelli prima del verdetto"))
        .accessibilityLabel(L("Round"))
    }

    private var judgeMenu: some View {
        Menu {
            Picker("Giudice", selection: judgeBinding) {
                Section("Abbonamento Claude") {
                    ForEach(store.claudeModels, id: \.self) { m in
                        Text(verbatim: "Claude \(m.capitalized)").tag("claude:\(m)")
                    }
                }
                let others = store.voices.filter { !$0.isClaude }
                if !others.isEmpty {
                    Section("Altri modelli") {
                        ForEach(others) { v in Text(v.label).tag("voice:\(v.id)") }
                    }
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            Label(String(format: L("Giudice: %@"), store.judgeLabel), systemImage: "checkmark.seal")
        }
        .tint(Brand.text)  // menu neutri come in Claude, non nell'accento
        .fixedSize()
        .help(L("Chi emette il verdetto"))
        .accessibilityLabel(L("Giudice"))
    }

    private var webToggle: some View {
        // Senza modelli che cercano sul web l'interruttore resta spento (la scelta salvata non cambia).
        Toggle(isOn: Binding(get: { store.webSearch && store.webSearchAvailable }, set: { store.webSearch = $0 })) {
            Label(L("Cerca sul web"), systemImage: "globe")
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .fixedSize()
        .disabled(!store.webSearchAvailable)
        .help(store.webSearchHelp)
        .accessibilityLabel(L("Cerca sul web"))
        .accessibilityHint(store.webSearchHelp)
    }

    @ViewBuilder private var estimate: some View {
        if store.canEstimate {
            Label(String(format: L("%d chiamate + 1 verdetto"), store.estimatedCalls)
                    + (store.estimatedTime.map { " · " + $0 } ?? ""),
                  systemImage: "arrow.left.arrow.right")
                .monospacedDigit()
                .lineLimit(1)
                .fixedSize()
                .help(store.hint)
                .accessibilityLabel(store.hint)
                .contentTransition(.numericText())
                .animation(.snappy(duration: 0.2), value: store.estimatedCalls)
        }
    }

    @ViewBuilder private var messages: some View {
        VStack(alignment: .leading, spacing: 6) {
            AttachmentWarnings(notice: store.attachmentNotice, items: store.attachments)
            if let err = store.startError {
                Label(err, systemImage: "exclamationmark.circle")
                    .foregroundStyle(Brand.danger)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            } else if !store.canEstimate {
                Text(store.hint)
                    .foregroundStyle(Brand.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Problemi dei modelli: simbolo + testo sempre visibile, con l'azione per risolverli
            if !troubled.isEmpty {
                ForEach(troubled) { v in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .symbolRenderingMode(.multicolor)
                            .accessibilityHidden(true)
                        Text(verbatim: "\(store.displayName(v)): \(v.problem ?? "")")
                            .foregroundStyle(Brand.secondaryText)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Button("Apri impostazioni…", action: openSettings)
                    .buttonStyle(.link)
            }

            if !hasOtherVoices && store.engineReady {
                Button("Aggiungi le chiavi API…", action: openSettings)
                    .buttonStyle(.link)
            }
        }
        .font(Brand.Fonts.small)
    }

    /// Valore unico del menu Giudice: "claude:<modello>" oppure "voice:<id>".
    private var judgeBinding: Binding<String> {
        Binding(
            get: { store.judge == "claude" ? "claude:\(store.claudeModel)" : "voice:\(store.judge)" },
            set: { tag in
                if tag.hasPrefix("claude:") {
                    store.claudeModel = String(tag.dropFirst(7))
                    store.judge = "claude"
                } else if tag.hasPrefix("voice:") {
                    store.judge = String(tag.dropFirst(6))
                }
            }
        )
    }
}

/// Partecipante: chip compatta attivabile. Stato con colore del marchio **e** segno di spunta;
/// per VoiceOver resta un interruttore con tratto "selezionato".
private struct VoiceChipStyle: ToggleStyle {
    let problem: String?
    let provider: String
    var role: String? = nil

    private var roleTitle: String? {
        switch role {
        case "devil": return L("Avvocato del diavolo")
        case "checker": return L("Verificatore di fatti")
        default: return nil
        }
    }

    func makeBody(configuration: Configuration) -> some View {
        let on = configuration.isOn
        return Button { configuration.isOn.toggle() } label: {
            HStack(spacing: 4) {
                if on {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
                }
                configuration.label
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let roleTitle {
                    Text(verbatim: "· " + roleTitle).font(Brand.Fonts.small).lineLimit(1)
                }
                if problem != nil {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .symbolRenderingMode(.multicolor)
                        .imageScale(.small)
                }
            }
            .font(Brand.Fonts.body)
            .foregroundStyle(on ? AnyShapeStyle(Brand.accent) : AnyShapeStyle(Brand.secondaryText))
            .padding(.horizontal, 10)
            .frame(height: 26)
            .background(Capsule().fill(on ? Brand.accent.opacity(0.14) : Color.primary.opacity(0.04)))
            .overlay(Capsule().strokeBorder(on ? Brand.accent.opacity(0.45) : Brand.hairline, lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(problem.map { String(format: L("Problema: %@"), $0) } ?? provider + L(" — clic destro per assegnare un ruolo"))
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityValue(problem.map { String(format: L("problema: %@"), $0) } ?? (on ? L("partecipa") : L("escluso")))
    }
}

// MARK: - Layout che va a capo

struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, widest: CGFloat = 0
        for s in subviews {
            let size = fitted(s, maxWidth)
            if x > 0 && x + size.width > maxWidth {
                y += lineHeight + lineSpacing
                x = 0
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
            widest = max(widest, x - spacing)
        }
        return CGSize(width: proposal.width ?? widest, height: y + lineHeight)
    }

    /// Misura naturale, ristretta alla larghezza disponibile (il testo si tronca invece di uscire).
    private func fitted(_ s: LayoutSubview, _ maxWidth: CGFloat) -> CGSize {
        let natural = s.sizeThatFits(.unspecified)
        guard maxWidth.isFinite, natural.width > maxWidth else { return natural }
        return s.sizeThatFits(ProposedViewSize(width: maxWidth, height: nil))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for s in subviews {
            let size = fitted(s, bounds.width)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += lineHeight + lineSpacing
                x = bounds.minX
                lineHeight = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

// MARK: - Dibattito

struct DebateView: View {
    @ObservedObject var store: CouncilStore
    let debate: DebateState
    var saveFile: (_ filename: String, _ text: String) -> Void

    @State private var expanded: [String: Bool] = [:]
    /// Verdetto appena copiato ("verdict" o "turn-<n>"), per la spunta sul pulsante.
    @State private var copiedKey: String?
    /// Domanda lunga mostrata per intero nell'intestazione.
    @State private var questionExpanded = false
    /// Dibattito seguito dal vivo: a ogni round la vista scende alla nuova sezione e al verdetto
    /// le fasi si compattano.
    @State private var watchedLive: Bool
    /// true finché si segue il dibattito dal vivo (l'utente non ha scorso in su per rileggere).
    @State private var following = true
    @State private var userScrolling = false
    /// true quando la vista è lontana dal fondo (più di 300 punti). Solo un booleano: cambia di
    /// rado, mentre la distanza cambierebbe a ogni scatto e ricalcolerebbe tutta la vista.
    @State private var awayFromBottom = false
    /// Agganciato in fondo (dibattito concluso), come `isPinned` della chat di Claude: finché vale,
    /// ogni cambio di altezza del contenuto riporta subito in fondo ("resnap"). Serve perché la
    /// pila pigra stima le altezze delle righe non ancora costruite e il primo salto può sbagliare.
    @State private var pinnedBottom = false
    /// Fino a questo istante gli spostamenti della vista sono di uno scorrimento animato del programma,
    /// non dell'utente (vedi la rotella in `onScrollGeometryChange`).
    @State private var programmaticUntil = Date.distantPast
    /// Larghezza della colonna del contenuto: decide le card per riga.
    @State private var contentWidth: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// Spazio dei nomi delle voci del rotore "Fasi" di VoiceOver.
    @Namespace private var rotorNS
    /// Posizione di lettura (riga in cima e scarto): un oggetto di riferimento, scritto a ogni scatto
    /// senza ricalcolare la vista; si salva quando si lascia la discussione.
    @State private var reading = ReadingTracker()

    init(store: CouncilStore, debate: DebateState, saveFile: @escaping (_ filename: String, _ text: String) -> Void) {
        self.store = store
        self.debate = debate
        self.saveFile = saveFile
        _watchedLive = State(initialValue: debate.isRunning)
    }

    /// Domanda di seguito in corso, se c'è.
    private var runningTurn: Int? { debate.turns.last(where: \.isRunning)?.turn }

    /// Dibattito originale in corso (non una domanda di seguito): lo scorrimento lo guida `sectionKey`.
    private var liveOriginal: Bool { debate.isRunning && runningTurn == nil }

    private var steps: [DebateStep] { store.steps(debate) }

    var body: some View {
        ScrollViewReader { proxy in
          // Come la chat di Claude: il contenuto scorre sopra, il campo della domanda di seguito
          // resta fisso sotto (fuori dalla vista che scorre).
          VStack(spacing: 0) {
            ScrollView {
                // Pila pigra, come la chat di Claude: si costruiscono solo le righe vicine alla parte
                // visibile. Ogni fase si scompone in righe (intestazione e una riga per coppia di
                // card), così anche un round lungo non va misurato tutto insieme.
                LazyVStack(alignment: .leading, spacing: 0) {
                    DebateHeader(store: store, debate: debate, questionExpanded: $questionExpanded)
                        .readingRow("debate-header", reading)
                        .id("debate-header")

                    if !debate.phases.isEmpty || debate.isRunning {
                        StepsRow(steps: steps, reduceMotion: reduceMotion) { id in
                            let target = id == "verdict" && debate.verdict != nil ? "phase-verdict" : "phase-\(id)"
                            if reduceMotion { proxy.scrollTo(target, anchor: .top) }
                            else { withAnimation(.easeInOut(duration: 0.25)) { proxy.scrollTo(target, anchor: .top) } }
                        }
                        .padding(.top, 16)
                    }

                    if debate.isRunning { progressBar.padding(.top, 16) }

                    if !debate.phases.isEmpty {
                        courseHeading.padding(.top, 32)
                            .padding(.bottom, 16)
                        ForEach(Array(debate.phases.enumerated()), id: \.element.id) { i, p in
                            phaseRows(p, last: i == debate.phases.count - 1)
                        }
                    }

                    // Come in una chat, il risultato viene dopo lo svolgimento e prima delle domande di
                    // seguito: il verdetto, con la sintesi del dibattito in fondo. Una sola riga con un'identità sola
                    // per segnaposto e verdetto: con due rami `if/else` entrambi con id "phase-verdict" la
                    // pila pigra aveva due righe con lo stesso id nello stesso aggiornamento e restava
                    // bloccata sul segnaposto (e con lei la vista).
                    if debate.verdict != nil || (debate.isRunning && debate.judging) {
                        DebateResult(store: store, debate: debate, text: debate.verdict, verdictBy: debate.verdictBy,
                                     confidence: debate.confidence, key: "verdict", copiedKey: $copiedKey, saveFile: saveFile)
                            .accessibilityRotorEntry(id: "phase-verdict", in: rotorNS)
                            .readingRow("phase-verdict", reading)
                            .id("phase-verdict")
                            .padding(.top, 32)
                    }

                    // Domande di seguito, in ordine, dopo il dibattito originale.
                    ForEach(debate.turns, id: \.turn) { t in
                        turnRows(t)
                    }

                    Color.clear.frame(height: 1).id(Self.endID)
                }
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { contentWidth = $0 }
                .padding(.horizontal, 28)
                .padding(.vertical, 24)
                .frame(maxWidth: 980, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            // Rotore "Fasi" di VoiceOver: salta tra le intestazioni delle fasi, i verdetti e le domande
            // di seguito. La pila pigra non ha ancora costruito le righe lontane: `prepare` le porta in
            // vista prima che VoiceOver ci si sposti, sganciando dal fondo (altrimenti il resnap
            // riporterebbe subito giù).
            .accessibilityRotor(L("Fasi")) {
                ForEach(rotorTargets, id: \.id) { t in
                    AccessibilityRotorEntry(Text(t.label), id: t.id, in: rotorNS) {
                        following = false
                        pinnedBottom = false
                        programmaticUntil = Date().addingTimeInterval(0.6)
                        proxy.scrollTo(t.id, anchor: .top)
                    }
                }
            }
            // Si segue il dibattito come in una chat: a ogni nuovo round (e al verdetto) la vista
            // scende all'inizio della nuova sezione, così si legge dall'inizio. Lo stato
            // "agganciato" segue le regole della chat di Claude: basta scorrere in su di 2 punti
            // per sganciarsi e rileggere, e si torna agganciati appena l'utente riporta la vista in
            // fondo (nessuna soglia ampia, nessuna attesa della fine dello scorrimento). Solo lo
            // scorrimento dell'utente cambia `following`: la crescita del contenuto e gli
            // scorrimenti del programma non lo toccano.
            .onScrollPhaseChange { _, new in
                userScrolling = new == .interacting || new == .decelerating
            }
            .onScrollGeometryChange(for: ScrollMetrics.self) { g in
                ScrollMetrics(offset: g.contentOffset.y,
                              distance: max(0, g.contentSize.height - g.visibleRect.maxY),
                              height: g.contentSize.height,
                              overshoot: g.visibleRect.maxY - g.contentSize.height > 2,
                              viewport: g.visibleRect.height,
                              atTop: g.contentOffset.y + g.contentInsets.top <= 1)
            } action: { old, new in
                reading.atBottom = new.distance <= 2
                reading.viewport = new.viewport
                reading.atTop = new.atTop
                let away = new.distance > 300
                if away != awayFromBottom { awayFromBottom = away }
                // La rotella del mouse non ha fasi di scorrimento (`userScrolling` resta false): uno
                // spostamento a contenuto invariato e fuori dagli scorrimenti del programma è comunque
                // dell'utente. Senza, il resnap riportava in fondo a ogni scatto e la vista restava bloccata.
                var wheel = new.height == old.height && new.offset != old.offset && Date() >= programmaticUntil
                // Durante il ripristino della posizione `programmaticUntil` copre l'assestamento; uno
                // spostamento a contenuto invariato lontano dall'ultimo salto del ripristino è la rotella
                // dell'utente: il ripristino si ferma e lo scorrimento torna normale.
                if reading.restoreTask != nil, new.height == old.height, new.offset != old.offset,
                   Date().timeIntervalSince(reading.lastRestoreJump) > 0.15 {
                    reading.cancelRestore()
                    programmaticUntil = .distantPast
                    wheel = true
                }
                if userScrolling || wheel {
                    reading.userMoved = true
                    if new.offset < old.offset - 2 { following = false; pinnedBottom = false }
                    else if new.distance <= 2 { following = true; pinnedBottom = true }
                } else if new.overshoot && !old.overshoot
                            || pinnedBottom && !liveOriginal && (new.distance > 2 || new.height != old.height) {
                    // Resnap di Claude: agganciati in fondo, si resta in fondo anche quando le
                    // righe appena costruite hanno un'altezza diversa da quella stimata. Lo stesso
                    // se la vista è finita oltre la fine del contenuto (righe più corte della stima:
                    // la discussione restava vuota dopo una domanda di seguito). Durante le domande
                    // di seguito la discussione risulta in corso: il resnap vale anche lì.
                    jumpToEnd(proxy)
                }
            }
            .onChange(of: sectionKey) {
                // L'arrivo del verdetto lo gestisce `onChange(of: debate.verdict != nil)`.
                guard watchedLive, following, debate.verdict == nil else { return }
                // Si va all'inizio del risultato, non in fondo: niente resnap al termine del dibattito.
                if debate.judging { pinnedBottom = false }
                Task { @MainActor in
                    // Si attende il layout della nuova sezione prima di scorrere.
                    try? await Task.sleep(for: .milliseconds(80))
                    scrollToLatest(proxy)
                }
            }
            // Con il campo di seguito sotto, il testo sfuma verso il basso invece di essere tagliato di netto.
            .mask {
                VStack(spacing: 0) {
                    Color.black
                    if store.canFollowUp(debate) {
                        LinearGradient(colors: [.black, .black.opacity(0)], startPoint: .top, endPoint: .bottom)
                            .frame(height: 28)
                    }
                }
                // Sopra, la maschera arriva fin sotto la toolbar: il testo che scorre passa sotto i
                // pulsanti con l'effetto bordo, invece di essere tagliato di netto al bordo della toolbar.
                .ignoresSafeArea(.container, edges: .top)
            }
            // Come nella chat di Claude: un pulsante rotondo con la freccia, in basso al centro,
            // compare quando non si è in fondo (dal vivo: quando ci si è sganciati).
            .overlay(alignment: .bottom) {
                let live = debate.isRunning
                let show = live ? !following : awayFromBottom
                ZStack {
                if show {
                    let title = live ? (debate.judging ? L("Vai al verdetto") : L("Vai al round in corso")) : L("Vai in fondo")
                    Button {
                        if live {
                            following = true
                            scrollToLatest(proxy)
                        } else {
                            // Come `scrollToBottom` di Claude: salto immediato e aggancio.
                            pinnedBottom = true
                            jumpToEnd(proxy)
                        }
                    } label: {
                        Image(systemName: "arrow.down")
                            .font(.system(size: Brand.bodySize))
                            .frame(width: 22, height: 22)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.circle)
                    .controlSize(.large)
                    .background(Circle().fill(Brand.surface))
                    .shadow(color: .black.opacity(0.15), radius: 4, y: 1)
                    .help(title)
                    .accessibilityLabel(title)
                    .padding(.bottom, 18)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
                }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: show)
            }

            if store.canFollowUp(debate) {
                FollowupBar(store: store, debate: debate)
            }
          }
          // Posizione di lettura, come la chat di Claude: si salva lasciando la discussione (la vista si
          // ricrea a ogni discussione) e si ripristina riaprendola.
          .onAppear { restoreReading(proxy) }
          .onDisappear { saveReading() }
          // VoiceOver: un solo annuncio quando arrivano risposte, mai uno per ogni aggiornamento. Solo
          // dal vivo: aprendo una discussione dalla cronologia le risposte ci sono già.
          .onChange(of: answeredCards) { old, new in
              guard debate.isRunning else { return }
              let before = Set(old.map(\.key))
              let names = new.filter { !before.contains($0.key) }.map(\.title)
              guard !names.isEmpty else { return }
              let text = names.count == 1 ? String(format: L("Ha risposto %@"), names[0])
                  : String(format: L("Hanno risposto: %@"), names.joined(separator: ", "))
              AccessibilityNotification.Announcement(text).post()
          }
          // Inviata una domanda di seguito: si va in fondo e si resta agganciati mentre arriva la
          // risposta (resnap di `pinnedBottom`), come nella chat di Claude.
          .onChange(of: debate.turns.count) { old, new in
              guard new > old, runningTurn != nil else { return }
              pinnedBottom = true
              Task { @MainActor in
                  try? await Task.sleep(for: .milliseconds(60))
                  jumpToEnd(proxy)
              }
          }
          // Arrivato il verdetto (scelta dell'utente): le fasi del dibattito si compattano da sole e
          // la vista va all'inizio del risultato. Una fase si riapre con un clic sull'intestazione.
          .onChange(of: debate.verdict != nil) { had, has in
              // Solo dal vivo: aperta dalla cronologia la discussione ha già le fasi compresse.
              guard !had, has, watchedLive else { return }
              collapsePhases(debate.phases, prefix: "")
              pinnedBottom = false
              scrollToResult("phase-verdict", proxy)
          }
          // Lo stesso per il verdetto di un turno del consiglio; nella risposta rapida si compattano solo
          // le fasi (la ricerca) e la vista resta agganciata in fondo mentre arriva il testo.
          .onChange(of: debate.turns.map { $0.verdict != nil || $0.answer?.text != nil }) { old, new in
              // Solo turni già presenti prima (arrivati dal vivo), non quelli caricati aprendo la discussione.
              for (i, t) in debate.turns.enumerated() where i < old.count && i < new.count && new[i] && !old[i] {
                  collapsePhases(t.phases, prefix: "turn-\(t.turn)-")
                  guard !t.isQuick, t.verdict != nil else { continue }
                  pinnedBottom = false
                  scrollToResult("turn-\(t.turn)-verdict", proxy)
              }
          }
        }
    }

    private static let endID = "debate-end"

    /// Card con una risposta arrivata, con una chiave unica nella discussione (turno, fase, voce).
    private struct AnsweredCard: Equatable {
        let key: String
        let title: String
    }

    private var answeredCards: [AnsweredCard] {
        func cards(_ phases: [PhaseState], _ prefix: String) -> [AnsweredCard] {
            phases.flatMap { p in
                p.cards.filter { $0.text != nil && !p.id.hasPrefix("research") }
                    .map { AnsweredCard(key: "\(prefix)\(p.id)/\($0.id)", title: $0.title) }
            }
        }
        var all = cards(debate.phases, "")
        for t in debate.turns {
            all += cards(t.phases, "turn-\(t.turn)-")
            if let a = t.answer, a.text != nil { all.append(AnsweredCard(key: "turn-\(t.turn)-answer", title: a.title)) }
        }
        return all
    }

    /// Voci del rotore "Fasi": id della riga nella pila pigra ed etichetta letta da VoiceOver.
    private var rotorTargets: [(id: String, label: String)] {
        var all = debate.phases.map { (id: "phase-\($0.id)", label: rotorTitle($0)) }
        if debate.verdict != nil || (debate.isRunning && debate.judging) { all.append((id: "phase-verdict", label: L("Verdetto"))) }
        for t in debate.turns {
            let n = t.turn
            all.append((id: "turn-\(n)-question", label: String(format: L("Domanda di seguito %d"), n)))
            all += t.phases.map { (id: "turn-\(n)-phase-\($0.id)", label: rotorTitle($0)) }
            if t.answer != nil { all.append((id: "turn-\(n)-answer", label: String(format: L("Risposta alla domanda di seguito %d"), n))) }
            if t.verdict != nil || (t.isRunning && t.judging) {
                all.append((id: "turn-\(n)-verdict", label: String(format: L("Verdetto della domanda di seguito %d"), n)))
            }
        }
        return all
    }

    private func rotorTitle(_ p: PhaseState) -> String {
        p.id == "research" ? (CouncilStore.phaseNames[p.id] ?? p.title) : compactTitle(p)
    }

    private struct ScrollMetrics: Equatable {
        var offset: CGFloat
        var distance: CGFloat
        var height: CGFloat
        /// La parte visibile va oltre la fine del contenuto.
        var overshoot: Bool
        var viewport: CGFloat
        var atTop: Bool
    }

    // MARK: Posizione di lettura

    /// Come lo snapshot della chat di Claude: agganciati in fondo, oppure la riga che attraversa il
    /// bordo superiore e di quanto è già scorsa (`anchorKey`, `anchorOffsetPx`).
    private func saveReading() {
        // Ripristino non ancora finito: la posizione salvata resta quella di prima (le metriche e le
        // righe registrate non dicono ancora dove si è davvero).
        if reading.restoreTask != nil { reading.cancelRestore(); return }
        guard debate.verdict != nil || !debate.phases.isEmpty, !reading.rows.isEmpty else { return }
        if reading.atBottom {
            ReadingPositions.save(debate.id, ReadingPositions.Snapshot(pinned: true))
            return
        }
        // `scrollTo(id, anchor: y)` allinea il punto `y` della riga allo stesso punto della vista: la
        // riga torna dov'era se y = minY / (vista − altezza). Si prende la riga più in alto per cui y
        // cade tra 0 e 1 (quella che attraversa il bordo se è più alta della vista, altrimenti la prima
        // tutta visibile): equivale ad `anchorKey` + `anchorOffsetPx` di Claude.
        let v = reading.viewport
        let anchor = reading.rows.sorted { $0.value.minY < $1.value.minY }.lazy.compactMap { row -> (String, CGFloat)? in
            let span = v - row.value.height
            guard abs(span) > 1 else { return row.value.minY.magnitude <= 1 ? (row.key, 0) : nil }
            let y = row.value.minY / span
            return (0...1).contains(y) ? (row.key, y) : nil
        }.first
        guard !reading.atTop, let (key, y) = anchor else {
            ReadingPositions.forget(debate.id)   // in cima: si riapre come sempre, dall'inizio
            return
        }
        ReadingPositions.save(debate.id, ReadingPositions.Snapshot(pinned: false, key: key, anchorY: y,
                                                                    fallback: phaseRowID(of: key)))
    }

    /// Riapertura: in fondo se si era in fondo, altrimenti sulla riga salvata. Le righe di card
    /// dipendono dalle colonne e dalle fasi aperte (in memoria): se la riga non c'è più si va
    /// all'intestazione della sua fase. Come Claude, si rinuncia se l'utente scorre nel frattempo.
    private func restoreReading(_ proxy: ScrollViewProxy) {
        guard !watchedLive, let snap = ReadingPositions.load(debate.id) else { return }
        reading.userMoved = false
        if snap.pinned {
            pinnedBottom = true
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(60))
                jumpToEnd(proxy)
            }
            return
        }
        reading.restoreTask = Task { @MainActor in
            defer { reading.restoreTask = nil }
            // Serve la larghezza della colonna: decide le card per riga e quindi gli id delle righe.
            for _ in 0..<20 where contentWidth == 0 { try? await Task.sleep(for: .milliseconds(25)) }
            guard !Task.isCancelled else { return }
            // Gli spostamenti dell'assestamento iniziale non sono dell'utente: non annullano il ripristino.
            programmaticUntil = Date().addingTimeInterval(2)
            reading.userMoved = false
            let ids = rowIDs()
            guard let key = snap.key,
                  let target = ids.contains(key) ? key : snap.fallback.flatMap({ ids.contains($0) ? $0 : nil }) else { return }
            // Sulla riga salvata, nello stesso punto (vedi `saveReading`); sull'intestazione di ripiego, in cima.
            let y: CGFloat = target == key ? (snap.anchorY ?? 0) : 0
            pinnedBottom = false
            // Come l'attesa della riga in Claude: la pila pigra stima le righe non ancora costruite e
            // si assesta dopo il primo salto, che può non restare. Si controlla dove è finita la riga e
            // si riprova finché è al suo posto (al massimo ~1,5 s), poi una verifica finale.
            var settled = 0
            for _ in 0..<15 {
                guard !reading.userMoved, !Task.isCancelled else { return }
                if let r = reading.rows[target], reading.viewport > 0,
                   abs(r.minY - y * (reading.viewport - r.height)) < 2 {
                    settled += 1
                    if settled >= 2 { return }
                } else {
                    settled = 0
                    reading.lastRestoreJump = Date()
                    proxy.scrollTo(target, anchor: UnitPoint(x: 0, y: y))
                }
                try? await Task.sleep(for: .milliseconds(100))
            }
        }
    }

    /// Id delle righe che la pila ha in questo momento (stessa logica di `phaseRows`).
    private func rowIDs() -> Set<String> {
        var ids: Set<String> = ["debate-header", "phase-verdict"]
        func add(_ phases: [PhaseState], _ prefix: String, _ t: DebateState?) {
            for p in phases {
                ids.insert("\(prefix)phase-\(p.id)")
                guard isExpanded(prefix + p.id, in: t), !p.cards.isEmpty else { continue }
                let cols = p.id != "research" && contentWidth >= 652 ? 2 : 1
                for i in 0..<((p.cards.count + cols - 1) / cols) { ids.insert("\(prefix)\(p.id)-\(cols)-\(i)") }
            }
        }
        add(debate.phases, "", nil)
        for t in debate.turns {
            let n = t.turn
            ids.formUnion(["turn-\(n)-question", "turn-\(n)-answer", "turn-\(n)-verdict", "turn-\(n)-status"])
            add(t.phases, "turn-\(n)-", t)
        }
        return ids
    }

    /// Intestazione della fase di una riga di card ("turn-2-critique-2-0" → "turn-2-phase-critique").
    private func phaseRowID(of key: String) -> String? {
        let all = debate.phases.map { ("", $0.id) } + debate.turns.flatMap { t in t.phases.map { ("turn-\(t.turn)-", $0.id) } }
        for (prefix, id) in all where key.hasPrefix(prefix + id + "-") && !key.hasPrefix(prefix + "phase-") {
            return prefix + "phase-" + id
        }
        return nil
    }

    /// Cambia a ogni nuovo round, all'inizio del giudizio e all'arrivo del verdetto.
    private var sectionKey: String {
        "\(debate.phases.count)-\(debate.judging)-\(debate.verdict != nil)"
    }

    /// Porta all'inizio della sezione più recente: risultato (verdetto e sintesi), round in corso o fondo pagina.
    private func scrollToLatest(_ proxy: ScrollViewProxy) {
        let target: String
        let anchor: UnitPoint
        if debate.verdict != nil || debate.judging { target = "phase-verdict"; anchor = .top }
        else if let last = debate.phases.last { target = "phase-\(last.id)"; anchor = .top }
        else { target = Self.endID; anchor = .bottom }
        programmaticUntil = Date().addingTimeInterval(0.6)
        if reduceMotion { proxy.scrollTo(target, anchor: anchor) }
        else { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(target, anchor: anchor) } }
    }

    /// Salto immediato in fondo, segnato come scorrimento del programma: non sgancia dal fondo
    /// anche se la vista sale (correzione di una posizione oltre la fine del contenuto).
    private func jumpToEnd(_ proxy: ScrollViewProxy) {
        programmaticUntil = Date().addingTimeInterval(0.3)
        proxy.scrollTo(Self.endID, anchor: .bottom)
    }

    /// Fasi compattate all'arrivo del risultato: si tolgono le scelte di apertura, così vale il
    /// predefinito (chiuse quando c'è il risultato).
    private func collapsePhases(_ phases: [PhaseState], prefix: String) {
        let apply = {
            for p in phases {
                expanded[prefix + p.id] = nil
                store.expandedPhases[debate.id]?[prefix + p.id] = nil
            }
        }
        if reduceMotion { apply() } else { withAnimation(.easeOut(duration: 0.25)) { apply() } }
    }

    /// Dopo la compattazione delle fasi, all'inizio del risultato (verdetto e sintesi).
    private func scrollToResult(_ id: String, _ proxy: ScrollViewProxy) {
        Task { @MainActor in
            // Si attende il layout delle fasi compresse prima di scorrere.
            try? await Task.sleep(for: .milliseconds(320))
            programmaticUntil = Date().addingTimeInterval(0.6)
            if reduceMotion { proxy.scrollTo(id, anchor: .top) }
            else { withAnimation(.easeInOut(duration: 0.35)) { proxy.scrollTo(id, anchor: .top) } }
        }
    }

    // MARK: Avanzamento determinato e Interrompi

    private var progressBar: some View {
        let pr = store.progress(debate)
        let current = steps.first { $0.state == .current }
        let label = debate.judging || current?.id == "verdict" ? debate.statusText : (current?.heading ?? debate.statusText)
        return HStack(alignment: .center, spacing: 16) {
            ProgressView(value: Double(pr.done), total: Double(pr.total)) {
                Text(label).font(Brand.Fonts.bodyMedium)
            } currentValueLabel: {
                Text(String(format: L("%d di %d risposte"), pr.done, pr.total)).font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText).monospacedDigit()
            }
            .progressViewStyle(.linear)
            .accessibilityValue(label + ", " + String(format: L("%d di %d risposte"), pr.done, pr.total))

            IconButton(L("Interrompi"), symbol: "stop.circle",
                       help: L("Interrompi (⌘.). Le risposte già arrivate restano salvate.")) {
                Task { await store.cancel() }
            }
            .keyboardShortcut(".", modifiers: .command)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .surfaceBox(radius: 12)
    }

    // MARK: Svolgimento (dibattito concluso)

    private var courseHeading: some View {
        let answers = debate.phases.filter { $0.id != "research" }.reduce(0) { $0 + $1.cards.filter { $0.text != nil }.count }
        let rounds = store.roundCount(debate)
        let scope = rounds == 0 ? L("Solo risposte iniziali") : (rounds == 1 ? L("Risposte iniziali e 1 round") : String(format: L("Risposte iniziali e %d round"), rounds))
        let count = answers == 1 ? L("1 risposta") : String(format: L("%d risposte"), answers)
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Svolgimento")).font(Brand.Fonts.section)
                    .accessibilityAddTraits(.isHeader)
                Text(scope + " · " + count)
                    .font(Brand.Fonts.small)
                    .foregroundStyle(Brand.secondaryText)
            }
            Spacer(minLength: 8)
            HStack(spacing: 2) {
                IconButton(L("Espandi tutti"), symbol: "rectangle.expand.vertical",
                           help: L("Espandi tutti i round (⌥⌘→)")) { setAll(true) }
                    .keyboardShortcut(.rightArrow, modifiers: [.command, .option])
                IconButton(L("Comprimi tutti"), symbol: "rectangle.compress.vertical",
                           help: L("Comprimi tutti i round (⌥⌘←)")) { setAll(false) }
                    .keyboardShortcut(.leftArrow, modifiers: [.command, .option])
            }
        }
    }

    private func setAll(_ open: Bool) {
        for p in debate.phases { setExpanded(p.id, open) }
    }

    // MARK: Round

    /// Fase aperta? Scelta dell'utente o, in mancanza, aperta finché manca il risultato.
    private func isExpanded(_ key: String, in t: DebateState? = nil) -> Bool {
        let fallback = t.map { $0.verdict == nil && $0.answer?.text == nil } ?? (debate.verdict == nil)
        return expanded[key] ?? store.expandedPhases[debate.id]?[key] ?? fallback
    }

    private func setExpanded(_ id: String, _ open: Bool) {
        expanded[id] = open
        store.expandedPhases[debate.id, default: [:]][id] = open
    }

    /// Tappa del percorso: numero su una linea verticale, intestazione cliccabile, card sotto.
    /// Restituisce più righe (intestazione + una riga per coppia di card) perché la pila pigra
    /// costruisca solo quelle visibili; la linea del percorso è disegnata riga per riga.
    /// `t`: turno di una domanda di seguito (nil = dibattito originale); le sue righe hanno
    /// identità e stato di apertura propri ("turn-<n>-…").
    @ViewBuilder
    private func phaseRows(_ p: PhaseState, last: Bool, in t: DebateState? = nil) -> some View {
        let d = t ?? debate
        let prefix = t.map { "turn-\($0.turn)-" } ?? ""
        let key = prefix + p.id
        let open = isExpanded(key, in: t)
        let state = store.phaseState(p, in: d)
        let toggle = {
            if reduceMotion { setExpanded(key, !open) }
            else { withAnimation(.easeOut(duration: 0.18)) { setExpanded(key, !open) } }
        }
        // Card per riga: due se il contenuto è largo.
        // La ricerca ha una sola card (il dossier): sempre a tutta larghezza.
        let cols = p.id != "research" && contentWidth >= 652 ? 2 : 1
        let rows = open && !p.cards.isEmpty
            ? stride(from: 0, to: p.cards.count, by: cols).map { Array(p.cards[$0..<min($0 + cols, p.cards.count)]) }
            : []
        let gap: CGFloat = last ? 0 : 24

        // Fase aperta: la linea si interrompe, le card ne occupano il posto.
        TimelineRow(line: !last && rows.isEmpty, lineTop: 34, bottom: rows.isEmpty ? gap : 0) {
            StepMarker(phaseID: p.id, state: state, reduceMotion: reduceMotion)
        } content: {
            Button(action: toggle) {
                // Fase chiusa e non in corso: una sola riga con il riassunto (es. "Round 2 — Revisione:
                // A cambiamenti sostanziali, B nessun cambiamento").
                PhaseHeader(eyebrow: store.phaseEyebrow(p.id, in: d),
                            name: CouncilStore.phaseNames[p.id] ?? p.title,
                            description: CouncilStore.phaseDescriptions[p.id],
                            note: p.note, state: state, meta: phaseMeta(p, state),
                            expanded: open, canExpand: !p.cards.isEmpty,
                            reduceMotion: reduceMotion,
                            compact: open || state == .current ? nil
                                : (title: compactTitle(p), summary: store.phaseSummary(p, in: d)),
                            narrow: contentWidth > 0 && contentWidth < 600)
            }
            .buttonStyle(PhaseHeaderStyle())
            .disabled(p.cards.isEmpty)
            .accessibilityValue(p.cards.isEmpty ? "" : open ? L("espanso") : L("compresso"))
            .accessibilityRotorEntry(id: "\(prefix)phase-\(p.id)", in: rotorNS)
            .help(p.cards.isEmpty ? "" : open ? L("Comprimi la fase") : L("Espandi la fase"))
        }
        .readingRow("\(prefix)phase-\(p.id)", reading)
        .id("\(prefix)phase-\(p.id)")

        // Identità che cambia con le colonne: passando da 1 a 2 card per riga la pila pigra non
        // deve riusare l'altezza misurata per la riga a card singola (il testo uscirebbe dalla card).
        // Card senza rientro: a tutta larghezza, non nella colonna del percorso.
        ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
            CardsRow(cards: row, cols: cols, running: d.isRunning, since: p.startedAt)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, i == 0 ? 10 : 12)
                .padding(.bottom, i == rows.count - 1 ? gap : 0)
                .readingRow("\(prefix)\(p.id)-\(cols)-\(i)", reading)
                .id("\(prefix)\(p.id)-\(cols)-\(i)")
            .transition(.opacity)
        }
    }

    /// Nome della fase nella riga compressa: "Risposte iniziali", "Round 2 — Revisione".
    private func compactTitle(_ p: PhaseState) -> String {
        let name = CouncilStore.phaseNames[p.id] ?? p.title
        guard let i = CouncilStore.phaseOrder.firstIndex(of: p.id), i > 0 else { return name }
        return String(format: L("Round %d — %@"), i, name)
    }

    /// "3 di 5 risposte" durante la fase; "5 risposte · fino a 41 s" a fase chiusa.
    private func phaseMeta(_ p: PhaseState, _ state: StepState) -> String? {
        if p.cards.isEmpty { return nil }
        let arrived = p.cards.filter { !$0.waiting }.count
        if state == .current { return String(format: L("%d di %d risposte"), arrived, p.cards.count) }
        let answered = p.cards.filter { $0.text != nil }.count
        var parts = [answered == 1 ? L("1 risposta") : String(format: L("%d risposte"), answered)]
        let missing = p.cards.count - answered
        if missing > 0 { parts.append(String(format: L("%d senza risposta"), missing)) }
        if let longest = p.cards.compactMap(\.seconds).max() { parts.append(String(format: L("fino a %d s"), Int(longest.rounded()))) }
        return parts.joined(separator: " · ")
    }
}

extension DebateView {
    // MARK: Domande di seguito

    /// Un turno di seguito come righe della pila pigra: domanda, eventuale ricerca, poi la risposta
    /// rapida o le fasi del consiglio con il verdetto. Ogni riga ha un'identità con il turno.
    @ViewBuilder
    fileprivate func turnRows(_ t: DebateState) -> some View {
        let n = t.turn
        TurnQuestion(turn: t)
            .accessibilityRotorEntry(id: "turn-\(n)-question", in: rotorNS)
            .readingRow("turn-\(n)-question", reading)
            .id("turn-\(n)-question")
            .padding(.top, 40)
            .padding(.bottom, 16)

        if t.isQuick {
            ForEach(Array(t.phases.enumerated()), id: \.element.id) { i, p in
                phaseRows(p, last: i == t.phases.count - 1, in: t)
            }
            if let a = t.answer {
                // La card è già un elemento unico per VoiceOver (chi risponde, stato, testo): il turno va
                // nel suggerimento, un contenitore attorno ne nasconderebbe l'etichetta.
                CardView(card: a, running: t.isRunning, since: t.startedAt)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityHint(String(format: L("Risposta alla domanda di seguito %d"), n))
                    .accessibilityRotorEntry(id: "turn-\(n)-answer", in: rotorNS)
                    .readingRow("turn-\(n)-answer", reading)
                    .id("turn-\(n)-answer")
                    .padding(.top, t.phases.isEmpty ? 0 : 24)
            } else {
                turnStatus(t).id("turn-\(n)-status")
            }
        } else {
            // Turno del consiglio: come il dibattito originale, lo svolgimento e poi il risultato
            // (o il segnaposto mentre il giudice scrive).
            let gap: CGFloat = t.phases.isEmpty ? 0 : 32
            ForEach(Array(t.phases.enumerated()), id: \.element.id) { i, p in
                phaseRows(p, last: i == t.phases.count - 1, in: t)
            }
            // Segnaposto e verdetto in una sola riga con un solo id (vedi il verdetto del dibattito).
            if t.verdict != nil || (t.isRunning && t.judging) {
                DebateResult(store: store, debate: debate, text: t.verdict, verdictBy: t.verdictBy,
                             confidence: t.confidence, key: "turn-\(n)", copiedKey: $copiedKey, saveFile: saveFile)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(String(format: L("Verdetto della domanda di seguito %d"), n))
                    .accessibilityRotorEntry(id: "turn-\(n)-verdict", in: rotorNS)
                    .readingRow("turn-\(n)-verdict", reading)
                    .id("turn-\(n)-verdict")
                    .padding(.top, gap)
            } else if !t.isRunning || t.phases.isEmpty {
                turnStatus(t).id("turn-\(n)-status").padding(.top, gap)
            }
        }
    }

    /// Stato del turno senza risultato: in attesa (con la rotella) o fermato, con il motivo.
    fileprivate func turnStatus(_ t: DebateState) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if t.isRunning {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: t.status == "failed" ? "xmark.octagon" : "stop.circle")
                    .foregroundStyle(t.status == "failed" ? AnyShapeStyle(Brand.danger) : AnyShapeStyle(Brand.secondaryText))
                    .accessibilityHidden(true)
            }
            Text(t.isRunning ? t.statusText : (t.status == "done" ? L("Nessuna risposta.") : t.statusText))
                .foregroundStyle(Brand.secondaryText)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(Brand.Fonts.body)
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .surfaceBox(radius: 12)
        .accessibilityElement(children: .combine)
    }
}

/// Domanda di seguito: fumetto a destra come nella chat di Claude, con gli allegati del turno.
private struct TurnQuestion: View {
    let turn: DebateState

    private var kind: String {
        turn.isQuick ? L("Domanda di seguito · risposta rapida") : L("Domanda di seguito · il consiglio ridiscute")
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Label(kind, systemImage: turn.isQuick ? "bolt" : "person.3")
                .font(Brand.Fonts.small)
                .foregroundStyle(Brand.secondaryText)
                .accessibilityHidden(true)
            Text(turn.question)
                .font(Brand.Fonts.body)
                .foregroundStyle(Brand.text)
                .lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(RoundedRectangle(cornerRadius: Brand.Radius.panel, style: .continuous).fill(Brand.selection))
                .accessibilityLabel(L("Domanda") + ": " + turn.question)
            if !turn.attachments.isEmpty {
                AttachmentTags(items: turn.attachments)
            }
        }
        .frame(maxWidth: 640, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(String(format: L("Domanda di seguito %d"), turn.turn) + (turn.isQuick ? "" : ", " + L("il consiglio ridiscute")))
        .accessibilityAddTraits(.isHeader)
    }
}

// MARK: - Campo della domanda di seguito (fisso in fondo alla discussione)

private struct FollowupBar: View {
    @ObservedObject var store: CouncilStore
    let debate: DebateState
    @FocusState private var focused: Bool
    @State private var dropTargeted = false
    @State private var pasteMonitor = AttachmentPasteMonitor()

    /// Una domanda di seguito è in corso: il campo aspetta e c'è il pulsante per fermare.
    private var running: Bool { debate.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            box
            VStack(alignment: .leading, spacing: 4) {
                AttachmentWarnings(notice: store.followupNotice, items: store.followupAttachments)
                if store.followupMode == "council" && store.councilModels(debate).count < 2 {
                    Label(L("Per rilanciare il consiglio servono almeno 2 partecipanti della discussione ancora disponibili."),
                          systemImage: "exclamationmark.circle")
                        .foregroundStyle(Brand.warning)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let e = store.followupError {
                    Label(e, systemImage: "exclamationmark.circle")
                        .foregroundStyle(Brand.danger)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .font(Brand.Fonts.small)
            .padding(.horizontal, 6)
        }
        // Larga quanto la colonna della discussione (980 − margini), allineata al verdetto.
        .frame(maxWidth: 924)
        .padding(.horizontal, 28)
        .padding(.top, 4)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
        .onAppear {
            pasteMonitor.start { [store] urls, image in
                if let image { store.addPastedImage(image, to: .followup) } else { store.addAttachments(urls, to: .followup) }
            }
        }
        .onDisappear { pasteMonitor.stop() }
    }

    private var box: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Mai disabilitato: come nella chat di Claude si può scrivere mentre arriva la risposta,
            // si blocca solo l'invio (`canSendFollowup`). Un `TextField(axis: .vertical)` disabilitato e poi
            // riabilitato restava con il cursore ma non accettava più il testo.
            TextField("Domanda di seguito", text: $store.followup,
                      prompt: Text("Chiedi ancora qualcosa su questa discussione…"),
                      axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: 15))
                .lineLimit(1...8)
                .lineSpacing(2)
                .focused($focused)
                .modifier(SubmitOnReturn { Task { await store.sendFollowup() } })
                .accessibilityLabel(L("Domanda di seguito"))

            if !store.followupAttachments.isEmpty {
                AttachmentChips(items: store.followupAttachments) { store.removeAttachment($0, from: .followup) }
            }

            QuestionCounter(length: store.followupLength,
                            overHelp: String(format: L("La domanda supera il limite di %@ caratteri: accorciala per inviarla."),
                                             formatCount(AttachmentLimits.maxQuestion)))

            // Finestra stretta: "Chi risponde" su una riga propria, così nessuna etichetta si tronca.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) {
                    attachButton
                    webToggle
                    Spacer(minLength: 8)
                    responderMenu
                    sendControl
                }
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 12) {
                        responderMenu
                        Spacer(minLength: 0)
                    }
                    HStack(spacing: 12) {
                        attachButton
                        webToggle
                        Spacer(minLength: 8)
                        sendControl
                    }
                }
            }
            .font(Brand.Fonts.body)
            .foregroundStyle(Brand.secondaryText)
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
        .composerSurface(focused: focused, dropTargeted: $dropTargeted) { store.addAttachments($0, to: .followup) }
    }

    private var attachButton: some View {
        AttachButton(count: store.followupAttachments.count) { store.addAttachments($0, to: .followup) }
            .disabled(running)
    }

    private var webToggle: some View {
        Toggle(isOn: Binding(get: { store.followupWebSearch && store.webSearchAvailable },
                             set: { store.followupWebSearch = $0 })) {
            Label(L("Cerca sul web"), systemImage: "globe")
        }
        .toggleStyle(.switch)
        .controlSize(.mini)
        .fixedSize()
        .disabled(!store.webSearchAvailable || running)
        .help(webHelp)
        .accessibilityLabel(L("Cerca sul web"))
        .accessibilityHint(webHelp)
    }

    /// Invio, oppure il pulsante per fermare mentre arriva la risposta.
    @ViewBuilder private var sendControl: some View {
        if running {
            Button { Task { await store.cancel() } } label: {
                ZStack {
                    Circle().fill(Brand.text)
                    Image(systemName: "stop.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(Brand.surface)
                }
                .frame(width: 32, height: 32)
                .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .help(L("Interrompi (⌘.). Le risposte già arrivate restano salvate."))
            .accessibilityLabel(L("Interrompi"))
        } else {
            SendButton(enabled: store.canSendFollowup, busy: store.sendingFollowup, label: L("Invia la domanda"),
                       help: store.followupProblem(debate) ?? L("Invia la domanda (↩)")) {
                Task { await store.sendFollowup() }
            }
        }
    }

    private var webHelp: String {
        store.webSearchAvailable
            ? L("Prima di rispondere un modello cerca sul web informazioni aggiornate.")
            : L("Ricerca sul web non disponibile: nessun modello configurato può cercare sul web.")
    }

    private var roundsText: String {
        let r = debate.rounds ?? store.rounds
        return r == 0 ? L("senza round") : (r == 1 ? L("1 round") : String(format: L("%d round"), r))
    }

    /// Chi risponde: risposta rapida di un modello (predefinito il giudice) o tutto il consiglio.
    private var responderMenu: some View {
        let council = store.followupMode == "council"
        let label = council ? L("Rilancia il consiglio")
            : String(format: L("Risposta rapida: %@"), store.quickResponder(debate).label)
        return Menu {
            Picker("Chi risponde", selection: whoBinding) {
                Section("Risposta rapida") {
                    Text(String(format: L("Giudice della discussione (%@)"), store.discussionJudge(debate).label)).tag("quick|")
                    ForEach(store.claudeModels, id: \.self) { m in
                        Text(verbatim: "Claude \(m.capitalized)").tag("quick|claude:\(m)")
                    }
                    ForEach(store.voices.filter { !$0.isClaude }) { v in
                        Text(v.label).tag("quick|voice:\(v.id)")
                    }
                }
                Section("Tutto il consiglio") {
                    Text(L("Rilancia il consiglio") + " · " + String(format: L("%d modelli"), store.councilModels(debate).count)
                         + " · " + roundsText).tag("council")
                }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } label: {
            // Pillola sobria: è un'opzione del campo, non deve competere con il pulsante d'invio.
            HStack(spacing: 5) {
                Image(systemName: council ? "person.3.fill" : "bolt.fill")
                    .foregroundStyle(Brand.text)
                Text(label)
                    .foregroundStyle(Brand.text)
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9))
                    .foregroundStyle(Brand.secondaryText)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(Brand.hover))
            .overlay(Capsule().strokeBorder(Brand.hairline, lineWidth: 1))
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .disabled(running)
        .help(council
              ? L("Il consiglio ridiscute la domanda con gli stessi partecipanti e round, poi il giudice emette un nuovo verdetto.")
              : L("Un solo modello risponde subito, tenendo conto del dibattito."))
        .accessibilityLabel(L("Chi risponde"))
        .accessibilityValue(label)
    }

    /// Valore unico del menu: "council" oppure "quick|" + scelta del modello ("" = giudice).
    private var whoBinding: Binding<String> {
        Binding(
            get: {
                guard store.followupMode != "council" else { return "council" }
                let r = store.responder
                let valid = r.hasPrefix("claude:") ? store.claudeModels.contains(String(r.dropFirst(7)))
                    : r.hasPrefix("voice:") ? store.voices.contains { $0.id == String(r.dropFirst(6)) } : false
                return "quick|" + (valid ? r : "")
            },
            set: { tag in
                if tag == "council" {
                    store.followupMode = "council"
                } else {
                    store.followupMode = "quick"
                    store.responder = String(tag.dropFirst(6))
                }
            }
        )
    }
}

// MARK: - Intestazione di una fase

/// Fondo leggero al passaggio del mouse sull'intestazione cliccabile di una fase.
private struct PhaseHeaderStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { HeaderBody(configuration: configuration) }

    struct HeaderBody: View {
        let configuration: ButtonStyleConfiguration
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(RoundedRectangle(cornerRadius: Brand.Radius.card, style: .continuous)
                    .fill(Brand.hover.opacity(!enabled ? 0 : configuration.isPressed ? 1 : hover ? 0.7 : 0)))
                // Il fondo sporge solo verso il percorso, a destra resta allineato alle card.
                .padding(.leading, -10)
                .contentShape(Rectangle())
                .onHover { hover = $0 }
        }
    }
}

/// Tappa nel percorso: pieno se completata, contornato se in corso, tenue se saltata.
/// Nei round il numero è quello del round ("2" accanto a "Round 2 di 3"); preparazione e apertura,
/// che non sono round, hanno un simbolo: un numero progressivo diverso da quello del round confondeva.
private struct StepMarker: View {
    let phaseID: String
    let state: StepState
    let reduceMotion: Bool

    @ViewBuilder private var mark: some View {
        if let i = CouncilStore.phaseOrder.firstIndex(of: phaseID), i > 0 {
            Text(verbatim: "\(i)")
        } else {
            Image(systemName: phaseID == "research" ? "globe" : "text.bubble")
                .font(.system(size: 12))
        }
    }

    var body: some View {
        ZStack {
            switch state {
            case .done:
                Circle().fill(Brand.clay.opacity(0.14))
                mark.foregroundStyle(Brand.clay)
            case .current:
                Circle().fill(Brand.surface)
                Circle().strokeBorder(Brand.clay, lineWidth: 1.5)
                mark.foregroundStyle(Brand.clay)
            case .stopped:
                Circle().fill(Brand.surface)
                Circle().strokeBorder(Brand.warning, lineWidth: 1.5)
                mark.foregroundStyle(Brand.warning)
            default:
                Circle().fill(Brand.surface)
                Circle().strokeBorder(Brand.hairline, lineWidth: 1.5)
                mark.foregroundStyle(Brand.secondaryText)
            }
        }
        .font(Brand.Fonts.smallMedium.monospacedDigit())
        .frame(width: 28, height: 28)
        .padding(.top, 6)
        .symbolEffect(.pulse, isActive: state == .current && !reduceMotion)
        .accessibilityHidden(true)
    }
}

private struct PhaseHeader: View {
    let eyebrow: String
    let name: String
    let description: String?
    let note: String?
    let state: StepState
    let meta: String?
    let expanded: Bool
    let canExpand: Bool
    let reduceMotion: Bool
    /// Fase compressa: titolo e riassunto in una riga al posto dell'intestazione completa.
    var compact: (title: String, summary: String?)? = nil
    /// Colonna del contenuto stretta (finestra piccola): stato e conteggi vanno sotto il nome.
    var narrow = false

    var body: some View {
        if let compact { compactBody(compact) } else { fullBody }
    }

    private func compactBody(_ c: (title: String, summary: String?)) -> some View {
        var line = AttributedString(c.title)
        line.font = Brand.Fonts.body
        if let s = c.summary, !s.isEmpty {
            var rest = AttributedString(": " + s)
            rest.font = Brand.Fonts.body
            rest.foregroundColor = Brand.secondaryText
            line += rest
        }
        return HStack(alignment: .center, spacing: 12) {
            Text(line)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .multilineTextAlignment(.leading)
            // Il segno di completato è implicito; gli altri stati restano scritti.
            if state != .done {
                PhaseStatusLabel(state: state, reduceMotion: reduceMotion).fixedSize()
            }
            if canExpand {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundStyle(Brand.tertiaryText)
                    .frame(width: 16, height: 22)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel([c.title, state == .done ? nil : PhaseStatusLabel.text(state), c.summary].compactMap { $0 }.joined(separator: ", "))
    }

    private var fullBody: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(eyebrow)
                    .font(Brand.Fonts.small)
                    .foregroundStyle(Brand.secondaryText)
                Text(name)
                    .font(Brand.Fonts.bodyMedium)
                    .foregroundStyle(Brand.text)
                    .fixedSize(horizontal: false, vertical: true)
                // Colonna stretta: stato e conteggi sotto il nome, così la descrizione non resta in pochi punti.
                if narrow {
                    FlowLayout(spacing: 10, lineSpacing: 4) {
                        PhaseStatusLabel(state: state, reduceMotion: reduceMotion)
                        if let meta {
                            Text(meta)
                                .font(Brand.Fonts.small)
                                .foregroundStyle(Brand.secondaryText)
                                .monospacedDigit()
                        }
                    }
                    .padding(.vertical, 2)
                }
                if let description {
                    Text(description)
                        .font(Brand.Fonts.body)
                        .foregroundStyle(Brand.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let note {
                    Label(note, systemImage: "info.circle")
                        .font(Brand.Fonts.body)
                        .foregroundStyle(Brand.secondaryText)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .multilineTextAlignment(.leading)

            if !narrow {
                VStack(alignment: .trailing, spacing: 4) {
                    PhaseStatusLabel(state: state, reduceMotion: reduceMotion)
                    if let meta {
                        Text(meta)
                            .font(Brand.Fonts.small)
                            .foregroundStyle(Brand.secondaryText)
                            .monospacedDigit()
                    }
                }
                .fixedSize()
                .padding(.top, 2)
            }

            if canExpand {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12))
                    .foregroundStyle(Brand.tertiaryText)
                    .rotationEffect(.degrees(expanded ? 90 : 0))
                    .frame(width: 16, height: 22)
                    .padding(.top, 2)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityLabel([eyebrow, name, PhaseStatusLabel.text(state), meta].compactMap { $0 }.joined(separator: ", "))
    }
}

/// Stato di un round a parole con simbolo: il colore è solo una seconda codifica.
private struct PhaseStatusLabel: View {
    let state: StepState
    let reduceMotion: Bool

    static func text(_ s: StepState) -> String {
        switch s {
        case .done: return L("Completato")
        case .current: return L("In corso")
        case .pending: return L("In attesa")
        case .skipped: return L("Saltato")
        case .notRun: return L("Non svolto")
        case .stopped: return L("Interrotto")
        }
    }

    static func symbol(_ s: StepState) -> String {
        switch s {
        case .done: return "checkmark.circle.fill"
        case .current: return "ellipsis.circle"
        case .pending: return "circle.dashed"
        case .skipped: return "forward.circle"
        case .notRun: return "minus.circle"
        case .stopped: return "stop.circle"
        }
    }

    var body: some View {
        Label {
            Text(Self.text(state))
        } icon: {
            Image(systemName: Self.symbol(state))
                .foregroundStyle(state == .done ? AnyShapeStyle(Brand.olive)
                                 : state == .current ? AnyShapeStyle(Brand.amberWarm) : AnyShapeStyle(Brand.secondaryText))
                .symbolEffect(.pulse, isActive: state == .current && !reduceMotion)
        }
        .font(Brand.Fonts.small)
    }
}

/// Esito del dibattito in una capsula: simbolo colorato e testo, fondo appena tinto.
struct StatusBadge: View {
    let text: String
    let symbol: String
    let tint: Color
    var pulse = false

    var body: some View {
        Label {
            Text(text).foregroundStyle(Brand.text)
        } icon: {
            Image(systemName: symbol)
                .foregroundStyle(tint)
                .symbolEffect(.pulse, isActive: pulse)
        }
        .font(Brand.Fonts.small)
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        // Fondo appena tinto del colore (caldo) dello stato.
        .background(Capsule().fill(tint.opacity(0.12)))
    }
}

/// Partecipante nell'intestazione: lettera anonima e nome del modello.
struct ParticipantTag: View {
    let letter: String
    let label: String

    var body: some View {
        HStack(spacing: 5) {
            Text(letter)
                .font(Brand.Fonts.smallMedium)
                .foregroundStyle(Brand.text)
                .frame(width: 17, height: 17)
                .background(Circle().fill(Brand.participant(letter).opacity(0.24)))
            Text(label)
                .font(Brand.Fonts.small)
                .foregroundStyle(Brand.secondaryText)
                .lineLimit(1)
        }
        .padding(.leading, 3)
        .padding(.trailing, 8)
        .frame(height: 22)
        .background(Capsule().fill(Brand.hover.opacity(0.7)))
        .overlay(Capsule().strokeBorder(Brand.hairline, lineWidth: 1))
    }
}

// MARK: - Riga dei passi (Risposte › Critica › … › Verdetto)

private struct StepsRow: View {
    let steps: [DebateStep]
    let reduceMotion: Bool
    let go: (String) -> Void

    private var currentIndex: Int {
        steps.firstIndex { $0.state == .current }
            ?? steps.lastIndex { $0.state == .done || $0.state == .skipped }
            ?? 0
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            full
            compact
        }
    }

    private var full: some View {
        HStack(spacing: 8) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { i, s in
                if i > 0 {
                    Image(systemName: "chevron.right")
                        .imageScale(.small)
                        .foregroundStyle(Brand.tertiaryText)
                        .accessibilityHidden(true)
                }
                stepButton(s)
            }
        }
        .fixedSize()
    }

    private var compact: some View {
        let s = steps.isEmpty ? nil : steps[min(currentIndex, steps.count - 1)]
        return Group {
            if let s {
                Button { go(s.id) } label: {
                    Label(String(format: L("Fase %d di %d · %@"), currentIndex + 1, steps.count, s.short), systemImage: symbol(s.state))
                }
                .buttonStyle(.plain)
                .font(Brand.Fonts.body)
                .help(L("Vai alla fase"))
            }
        }
    }

    @ViewBuilder private func stepButton(_ s: DebateStep) -> some View {
        let reachable = s.state != .pending && s.state != .notRun && !(s.id == "verdict" && s.state != .done)
        // Testo grigio (nero se in corso); l'icona prende il colore caldo dello stato.
        let label = Label {
            Text(s.short)
                .foregroundStyle(s.state == .current ? AnyShapeStyle(Brand.text) : AnyShapeStyle(Brand.secondaryText))
        } icon: {
            Image(systemName: symbol(s.state))
                .foregroundStyle(s.state == .done ? AnyShapeStyle(Brand.olive)
                                 : s.state == .current ? AnyShapeStyle(Brand.amberWarm) : AnyShapeStyle(Brand.secondaryText))
        }
            .font(Brand.Fonts.body)
            .accessibilityLabel("\(s.short), \(PhaseStatusLabel.text(s.state))")
        if reachable {
            Button { go(s.id) } label: { label }
                .buttonStyle(.plain)
                .help(String(format: L("Vai a: %@"), s.heading))
        } else {
            label
        }
    }

    private func symbol(_ s: StepState) -> String {
        switch s {
        case .done: return "checkmark.circle.fill"
        case .current: return "circle.inset.filled"
        case .pending: return "circle"
        case .skipped: return "forward.circle"
        case .notRun: return "minus.circle"
        case .stopped: return "stop.circle"
        }
    }
}

// MARK: - Card di un modello

/// Riga del percorso: colonna con numero (o vuota) e linea verticale, contenuto a destra.
/// La linea copre anche i margini della riga, così le righe di una fase la rendono continua.
private struct TimelineRow<Marker: View, Content: View>: View {
    let line: Bool
    let lineTop: CGFloat
    var top: CGFloat = 0
    var bottom: CGFloat = 0
    @ViewBuilder var marker: Marker
    @ViewBuilder var content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            marker
            content
                .frame(maxWidth: .infinity, alignment: .leading)
                // Altezza piena del contenuto: le card non devono finire sopra l'intestazione.
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, top)
        .padding(.bottom, bottom)
        .background(alignment: .topLeading) {
            if line {
                Rectangle()
                    .fill(Brand.hairline)
                    .frame(width: 2)
                    .padding(.top, lineTop)
                    .padding(.leading, 13)
                    .accessibilityHidden(true)
            }
        }
    }
}

/// Una riga di card (due colonne, una se la finestra è stretta). Le card della stessa riga
/// hanno la stessa altezza: niente vuoti sotto la più corta.
private struct CardsRow: View {
    let cards: [CardState]
    let cols: Int
    let running: Bool
    let since: Date?

    var body: some View {
        // Grid e non HStack: misura il testo alla larghezza finale della colonna, mentre l'HStack
        // con fixedSize poteva stimare un'altezza più bassa e far uscire il testo dalla card.
        Grid(alignment: .topLeading, horizontalSpacing: 12, verticalSpacing: 0) {
            GridRow {
                ForEach(cards) { c in
                    CardView(card: c, running: running, since: since)
                }
                if cards.count < cols {
                    Color.clear
                        .frame(minWidth: 0, maxWidth: .infinity)
                        .gridCellUnsizedAxes(.vertical)
                }
            }
        }
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
    }
}

private struct CardView: View {
    let card: CardState
    let running: Bool
    let since: Date?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline) {
                    // Pallino nel colore del partecipante, lo stesso delle etichette in testa alla discussione.
                    if let letter = card.title.split(separator: " ").last.map(String.init), letter.count == 1 {
                        Circle().fill(Brand.participant(letter)).frame(width: 8, height: 8)
                    }
                    Text(card.title).font(Brand.Fonts.bodyMedium)
                    Spacer(minLength: 6)
                    if let s = card.seconds {
                        Text(String(format: "%.1f s", locale: AppLanguage.locale, s))
                            .font(Brand.Fonts.small)
                            .foregroundStyle(Brand.secondaryText)
                            .monospacedDigit()
                    }
                }
                if let m = card.usedModel {
                    Text(m).font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText).textSelection(.enabled)
                }
            }

            if let r = card.replaced {
                Label {
                    Text(String(format: L("Ha risposto %@ al posto di %@, che non ha risposto in tempo."), card.usedModel ?? L("un modello di riserva"), r))
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(Brand.secondaryText)
                }
                .font(Brand.Fonts.small)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Brand.hover))
            }

            if let text = card.text {
                MarkdownView(text)
            } else if let err = card.error {
                if card.skipped {
                    Label {
                        Text(String(format: L("Ha saltato questo round e rientra nel prossimo: %@"), Self.reason(err)))
                            .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "forward")
                    }
                    .font(Brand.Fonts.body)
                    .foregroundStyle(Brand.secondaryText)
                    .textSelection(.enabled)
                } else if card.id.hasPrefix("research") {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Ricerca sul web non riuscita")
                            Text(err).foregroundStyle(Brand.secondaryText)
                            Text("Il dibattito continua senza i risultati della ricerca.").foregroundStyle(Brand.secondaryText)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle").foregroundStyle(Brand.warning)
                    }
                    .font(Brand.Fonts.body)
                    .textSelection(.enabled)
                } else {
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Non ha risposto")
                            Text(err).foregroundStyle(Brand.secondaryText)
                            Text("Il dibattito continua senza questo modello.").foregroundStyle(Brand.secondaryText)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    } icon: {
                        Image(systemName: "xmark.octagon").foregroundStyle(Brand.danger)
                    }
                    .font(Brand.Fonts.body)
                    .textSelection(.enabled)
                }
            } else if running {
                TimelineView(.periodic(from: .now, by: 1)) { ctx in
                    let secs = since.map { max(0, Int(ctx.date.timeIntervalSince($0))) }
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text(secs.map { String(format: L("In attesa · %d s"), $0) } ?? L("In attesa"))
                            .foregroundStyle(Brand.secondaryText)
                            .monospacedDigit()
                    }
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(secs.map { String(format: L("%@, in attesa da %d secondi"), card.title, $0) } ?? String(format: L("%@, in attesa"), card.title))
                }
            } else {
                Label("Nessuna risposta: il dibattito si è fermato prima.", systemImage: "stop.circle")
                    .foregroundStyle(Brand.secondaryText)
            }
        }
        // Corpo e colore del marchio anche per i testi senza un carattere proprio (attesa, fermato, titolo).
        .font(Brand.Fonts.body)
        .foregroundStyle(Brand.text)
        .padding(14)
        // maxHeight: nella griglia le card della stessa riga hanno la stessa altezza.
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .surfaceBox(radius: 12)
        // Per VoiceOver la card è un solo elemento: chi ha risposto e lo stato nell'etichetta, il testo
        // della risposta (o il motivo dell'errore) nel valore. Con `.combine` l'etichetta esplicita
        // sostituisce quelle dei figli: senza il valore il testo della risposta sparirebbe.
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityStatus)
        .accessibilityValue(card.text.map(Self.spokenText) ?? card.error.map(Self.reason) ?? "")
        .contextMenu {
            if let text = card.text {
                Button("Copia risposta") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
            }
        }
    }

    /// Chi ha risposto e come: "Gemini · Risposta B, ha risposto in 3,2 s", "…, non ha risposto".
    private var accessibilityStatus: String {
        var parts = [card.title]
        if card.text != nil {
            parts.append(card.seconds.map { String(format: L("ha risposto in %@ s"), String(format: "%.1f", locale: AppLanguage.locale, $0)) } ?? L("ha risposto"))
            if let m = card.usedModel { parts.append(m) }
            if let r = card.replaced { parts.append(String(format: L("al posto di %@"), r)) }
        } else if card.error != nil {
            parts.append(card.skipped ? L("ha saltato questo round")
                         : card.id.hasPrefix("research") ? L("Ricerca sul web non riuscita") : L("Non ha risposto"))
        } else {
            parts.append(running ? L("In attesa") : L("Nessuna risposta"))
        }
        return parts.joined(separator: ", ")
    }

    /// Testo della risposta da leggere ad alta voce: senza i segni del Markdown (asterischi,
    /// cancelletti, barre delle tabelle, apici inversi) che VoiceOver pronuncerebbe.
    static func spokenText(_ md: String) -> String {
        md.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            var l = String(line).trimmingCharacters(in: .whitespaces)
            while l.hasPrefix("#") || l.hasPrefix(">") { l = String(l.dropFirst()).trimmingCharacters(in: .whitespaces) }
            // Righe di separazione delle tabelle ("|---|:--:|").
            if !l.isEmpty, l.allSatisfy({ "|-: ".contains($0) }) { return "" }
            for mark in ["**", "__", "`", "|"] { l = l.replacingOccurrences(of: mark, with: mark == "|" ? ", " : "") }
            return l
        }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
    }

    /// L'errore del motore è "ha saltato questo round (<motivo>)": si mostra solo il motivo.
    static func reason(_ err: String) -> String {
        guard err.hasPrefix("ha saltato"), let open = err.firstIndex(of: "("), err.hasSuffix(")") else { return err }
        return String(err[err.index(after: open)..<err.index(before: err.endIndex)])
    }
}

// MARK: - Posizione di lettura

/// Righe visibili della discussione con la loro posizione rispetto al bordo superiore della vista.
/// Classe e non `@State` di valori: si aggiorna a ogni scatto senza ricalcolare la vista.
final class ReadingTracker {
    var rows: [String: (minY: CGFloat, height: CGFloat)] = [:]
    var atBottom = false
    var atTop = true
    var viewport: CGFloat = 0
    /// L'utente ha scorso: un ripristino ancora in corso si annulla (come `reader_scrolled` di Claude).
    var userMoved = false
    /// Ripristino in corso (salti ripetuti finché la riga resta al suo posto) e ora dell'ultimo salto.
    var restoreTask: Task<Void, Never>?
    var lastRestoreJump = Date.distantPast

    func cancelRestore() {
        restoreTask?.cancel()
        restoreTask = nil
        userMoved = true
    }
}

extension View {
    /// Registra la posizione della riga nella vista che scorre finché la pila pigra la tiene.
    func readingRow(_ id: String, _ tracker: ReadingTracker) -> some View {
        onGeometryChange(for: CGRect.self) { $0.frame(in: .scrollView) } action: { f in
            tracker.rows[id] = (f.minY, f.height)
        }
        .onDisappear { tracker.rows[id] = nil }
    }
}

/// Posizioni di lettura delle discussioni in `UserDefaults`: le 32 aperte più di recente, come la
/// cache in memoria della chat di Claude (che però si perde al riavvio).
enum ReadingPositions {
    struct Snapshot: Codable {
        var pinned: Bool
        var key: String?
        /// Punto della riga (0 = bordo superiore, 1 = inferiore) allineato allo stesso punto della vista.
        var anchorY: CGFloat?
        var fallback: String?
    }

    /// Con `COUNCIL_DATA` (prove) una chiave a parte: gli id delle discussioni di prova coincidono
    /// con quelli reali e le preferenze sono le stesse dell'app installata.
    private static let key = ProcessInfo.processInfo.environment["COUNCIL_DATA"] == nil ? "ReadingPositions" : "ReadingPositionsTest"
    private static let cap = 32

    private static var all: [(id: Int, snap: Snapshot)] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let list = try? JSONDecoder().decode([Entry].self, from: data) else { return [] }
        return list.map { ($0.id, $0.snap) }
    }

    private struct Entry: Codable { let id: Int; let snap: Snapshot }

    private static func write(_ list: [(id: Int, snap: Snapshot)]) {
        let entries = list.suffix(cap).map { Entry(id: $0.id, snap: $0.snap) }
        if let data = try? JSONEncoder().encode(entries) { UserDefaults.standard.set(data, forKey: key) }
    }

    static func load(_ id: Int) -> Snapshot? { all.last { $0.id == id }?.snap }

    static func save(_ id: Int, _ snap: Snapshot) { write(all.filter { $0.id != id } + [(id, snap)]) }

    static func forget(_ id: Int) {
        let list = all
        if list.contains(where: { $0.id == id }) { write(list.filter { $0.id != id }) }
    }
}
