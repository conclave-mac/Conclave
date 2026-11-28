// Primo avvio guidato: un foglio sulla finestra principale in tre passi (Claude, chiavi gratuite,
// domanda d'esempio). Si apre da solo solo se non ci sono chiavi e Claude non c'è; "Salta" lo chiude
// per sempre e Aiuto ▸ "Guida al primo avvio…" lo riapre.

import AppKit
import SwiftUI

// MARK: - Claude Code

enum ClaudeStatus: Equatable {
    case checking, ready, notConnected, missing
}

enum ClaudeDetector {
    /// `claude` nel PATH salvato della shell di login (più le cartelle solite) e collegato:
    /// `claude auth status` esce con 0 solo se c'è un accesso (non consuma l'abbonamento).
    /// Nelle prove (solo con `COUNCIL_DATA`) `COUNCIL_ONBOARDING_CLAUDE=ready|offline|missing` lo impone.
    static func detect() async -> ClaudeStatus {
        let env = ProcessInfo.processInfo.environment
        if !(env["COUNCIL_DATA"] ?? "").isEmpty {
            switch env["COUNCIL_ONBOARDING_CLAUDE"] {
            case "ready": return .ready
            case "offline": return .notConnected
            case "missing": return .missing
            default: break
            }
        }
        return await Task.detached(priority: .userInitiated) { check() }.value
    }

    private static func check() -> ClaudeStatus {
        let path = ServerController.searchPath()
        guard let claude = ServerController.find("claude", in: path) else { return .missing }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: claude)
        p.arguments = ["auth", "status"]
        // Come per il motore: mai la chiave dell'API (fatturerebbe l'API) né le variabili di Conclave.
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = path
        env.removeValue(forKey: "ANTHROPIC_API_KEY")
        for k in env.keys where k.hasPrefix("COUNCIL_") { env.removeValue(forKey: k) }
        p.environment = env
        p.currentDirectoryURL = FileManager.default.temporaryDirectory
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { return .notConnected }
        let deadline = Date().addingTimeInterval(10)
        while p.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if p.isRunning { p.terminate(); return .notConnected }
        return p.terminationStatus == 0 ? .ready : .notConnected
    }
}

// MARK: - Stato del foglio

@MainActor
final class Onboarding: ObservableObject {
    enum Step: Int, CaseIterable { case claude, keys, question }

    @Published var step: Step = .claude
    @Published var claude: ClaudeStatus = .checking
    @Published var saveError: String?
    /// Modello delle chiavi a parte (stessa prova e stesso salvataggio delle Impostazioni): quello che si
    /// scrive qui non diventa una modifica non salvata della finestra Impostazioni.
    let keys: SettingsModel
    var openKeySettings: () -> Void = {}
    var fillExample: (String) -> Void = { _ in }
    private var sheet: NSWindow?
    private var checkGeneration = 0
    /// La prima apertura usa la lettura delle chiavi fatta da `init` di SettingsModel (Portachiavi: 0,2–1 s).
    private var presentedOnce = false
    /// In attesa che si chiuda un altro foglio della finestra principale.
    private var sheetWaiter: NSObjectProtocol?

    /// Gemini consigliata (una voce), Groq seconda chiave gratuita (GPT-OSS e Qwen): senza Claude una
    /// chiave sola di Gemini non basta per un consiglio, che vuole almeno due voci.
    static let providerIDs = ["gemini", "groq"]

    init(keys: SettingsModel) {
        self.keys = keys
    }

    var isShown: Bool { sheet != nil }
    var guides: [ProviderGuide] {
        Self.providerIDs.compactMap { id in keys.providers[id] == nil ? nil : providerGuides.first { $0.id == id } }
    }

    /// Voci che il consiglio avrà (stima): Claude 1, Gemini 1, Groq 2 (GPT-OSS e Qwen).
    var voices: Int {
        (claude == .ready ? 1 : 0) + (keys.hasKey("gemini") ? 1 : 0) + (keys.hasKey("groq") ? 2 : 0)
    }

    // MARK: Scelta di non vederlo più

    private static let doneKey = "OnboardingDone"
    /// Con `COUNCIL_DATA` (prove) la scelta sta nella cartella dati, mai nelle preferenze reali.
    private static var testMarker: URL? {
        let custom = ProcessInfo.processInfo.environment["COUNCIL_DATA"] ?? ""
        return custom.isEmpty ? nil : Paths.dataDir.appendingPathComponent("onboarding-done")
    }

    static var isDone: Bool {
        get {
            if let m = testMarker { return FileManager.default.fileExists(atPath: m.path) }
            return UserDefaults.standard.bool(forKey: doneKey)
        }
        set {
            if let m = testMarker {
                if newValue { FileManager.default.createFile(atPath: m.path, contents: Data()) } else { try? FileManager.default.removeItem(at: m) }
                return
            }
            UserDefaults.standard.set(newValue, forKey: doneKey)
        }
    }

    // MARK: Foglio

    /// `claude`: stato già rilevato (avvio automatico), altrimenti lo si rileva ora.
    func present(over window: NSWindow, claude known: ClaudeStatus? = nil) {
        if let sheet { sheet.makeKeyAndOrderFront(nil); return }
        // Un foglio alla volta (HIG): se ce n'è già uno (per esempio un avviso dell'aggiornamento) si aspetta che si chiuda.
        if window.attachedSheet != nil {
            guard sheetWaiter == nil else { return }
            sheetWaiter = NotificationCenter.default.addObserver(forName: NSWindow.didEndSheetNotification, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    if let w = self.sheetWaiter { NotificationCenter.default.removeObserver(w) }
                    self.sheetWaiter = nil
                    // Dopo la chiusura vera del foglio: la notifica arriva mentre è ancora attaccato.
                    DispatchQueue.main.async { self.present(over: window, claude: known) }
                }
            }
            return
        }
        step = .claude
        saveError = nil
        if presentedOnce { keys.reload() }
        presentedOnce = true
        if let known { claude = known } else { recheckClaude() }
        let host = NSHostingController(rootView: OnboardingView(model: self))
        host.sizingOptions = [.preferredContentSize]
        let s = NSWindow(contentViewController: host)
        s.styleMask = [.titled]
        sheet = s
        window.beginSheet(s)
    }

    /// `done`: la guida non si riapre più da sola (Salta, Inizia). La chiusura per ⌘Q non conta come scelta.
    func close(done: Bool) {
        guard let s = sheet else { return }
        sheet = nil
        checkGeneration += 1
        if done { Self.isDone = true }
        if let parent = s.sheetParent { parent.endSheet(s) } else { s.orderOut(nil) }
    }

    func recheckClaude() {
        checkGeneration += 1
        let generation = checkGeneration
        claude = .checking
        Task {
            let status = await ClaudeDetector.detect()
            guard generation == checkGeneration else { return }
            claude = status
        }
    }

    func back() {
        if let previous = Step(rawValue: step.rawValue - 1) { step = previous }
    }

    /// Dal passo delle chiavi si salva quello che è cambiato (Portachiavi fuori dal main thread, come le
    /// Impostazioni); il motore si riavvia con le chiavi nuove mentre si legge l'ultimo passo.
    func next() {
        switch step {
        case .claude: step = .keys
        case .keys:
            guard Self.providerIDs.contains(where: keys.isChanged) else { step = .question; return }
            saveError = nil
            Task {
                do {
                    try await keys.save()
                    step = .question
                } catch {
                    saveError = String(format: L("Impossibile salvare la chiave: %@"), error.localizedDescription)
                }
            }
        case .question:
            fillExample(L("Per una famiglia di quattro persone conviene di più un'auto elettrica o una ibrida?"))
            close(done: true)
        }
    }
}

// MARK: - Interfaccia

struct OnboardingView: View {
    @ObservedObject var model: Onboarding
    @ObservedObject private var keys: SettingsModel

    init(model: Onboarding) {
        self.model = model
        self.keys = model.keys
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .center, spacing: 12) {
                CouncilLogo(size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Benvenuto in Conclave")).font(Brand.Fonts.pageTitle).foregroundStyle(Brand.text)
                    Text(String(format: L("Passo %d di %d"), model.step.rawValue + 1, Onboarding.Step.allCases.count))
                        .font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText)
                }
            }
            Group {
                switch model.step {
                case .claude: claudeStep
                case .keys: keysStep
                case .question: questionStep
                }
            }
            .frame(maxWidth: .infinity, minHeight: 250, alignment: .topLeading)
            buttons
        }
        .font(Brand.Fonts.body)
        .foregroundStyle(Brand.text)
        .padding(24)
        .frame(width: 560)
        .background(Brand.canvas)
    }

    // MARK: Passo 1

    private var claudeStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Claude, con il tuo abbonamento")).font(Brand.Fonts.section)
            Text(L("Conclave mette a confronto più modelli AI sulla stessa domanda; alla fine un giudice scrive il verdetto. Claude partecipa tramite Claude Code e il tuo abbonamento Claude, senza chiavi."))
                .fixedSize(horizontal: false, vertical: true)
            switch model.claude {
            case .checking:
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text(L("Cerco Claude Code…")).foregroundStyle(Brand.secondaryText)
                }
            case .ready:
                status(L("Claude trovato ✓"), L("Claude Code è installato e collegato: Claude può partecipare e fare da giudice."),
                       "checkmark.circle.fill", Brand.success)
            case .notConnected:
                status(L("Claude Code non è collegato"), L("Apri il Terminale, scrivi claude e accedi con il tuo account Claude, poi premi Controlla di nuovo."),
                       "exclamationmark.triangle.fill", Brand.warning)
            case .missing:
                status(L("Claude Code non è installato"), L("È facoltativo: serve un abbonamento Claude (Pro o superiore). Senza Claude bastano le chiavi gratuite del passo successivo."),
                       "info.circle.fill", Brand.secondaryText)
            }
            if model.claude != .ready && model.claude != .checking {
                HStack(spacing: 8) {
                    Button {
                        NSWorkspace.shared.open(URL(string: "https://code.claude.com/docs/en/setup")!)
                    } label: {
                        Label(L("Come installare Claude Code…"), systemImage: "arrow.up.right.square")
                    }
                    .help("https://code.claude.com/docs/en/setup")
                    Button(L("Controlla di nuovo")) { model.recheckClaude() }
                }
            }
        }
    }

    private func status(_ title: String, _ detail: String, _ symbol: String, _ color: Color) -> some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(Brand.Fonts.section)
                Text(detail).foregroundStyle(Brand.secondaryText).fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: symbol).foregroundStyle(color)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Passo 2

    private var keysStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Aggiungi una chiave gratuita")).font(Brand.Fonts.section)
            Text(model.claude == .ready
                 ? L("Con Claude basta una chiave: Gemini è la più semplice, gratis e senza carta di credito (circa 2 minuti).")
                 : L("Un consiglio vuole almeno due voci. Gemini è consigliata (gratis, circa 2 minuti); Groq, anche lei gratuita, aggiunge GPT-OSS e Qwen."))
                .fixedSize(horizontal: false, vertical: true)
            ForEach(model.guides) { guide in
                OnboardingKeyRow(guide: guide, keys: keys, recommended: guide.id == "gemini")
            }
            HStack {
                Button(L("Altri provider…")) { model.openKeySettings() }
                    .help(L("Apri Impostazioni ▸ Chiavi API"))
                if keys.saving {
                    ProgressView().controlSize(.small)
                    Text(L("Salvataggio…")).foregroundStyle(Brand.secondaryText)
                }
            }
            if let e = model.saveError {
                TestResultView(state: .fail(e))
            }
        }
    }

    // MARK: Passo 3

    private var questionStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Fai la prima domanda")).font(Brand.Fonts.section)
            Text(L("Premendo Inizia trovi una domanda d'esempio già scritta nel campo: scegli chi partecipa e premi Avvia (⌘↩), oppure scrivi la tua. Niente parte finché non premi Avvia."))
                .fixedSize(horizontal: false, vertical: true)
            if model.voices < 2 {
                Label {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("Per avviare un consiglio servono almeno due voci: aggiungi un'altra chiave gratuita in Impostazioni ▸ Chiavi API."))
                            .fixedSize(horizontal: false, vertical: true)
                        Button(L("Apri Chiavi API…")) { model.openKeySettings() }
                    }
                } icon: {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.warning)
                }
            }
            Text(L("Questa guida resta in Aiuto ▸ Guida al primo avvio…"))
                .font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText)
        }
    }

    // MARK: Pulsanti

    private var buttons: some View {
        HStack(spacing: 8) {
            if model.step != .question {
                Button(L("Salta")) { model.close(done: true) }
                    .keyboardShortcut(.cancelAction)
                    .help(L("Chiudi la guida; la ritrovi in Aiuto ▸ Guida al primo avvio…"))
            }
            Spacer()
            if model.step != .claude {
                Button(L("Indietro")) { model.back() }
                    .disabled(keys.saving)
            }
            Button(model.step == .question ? L("Inizia") : L("Avanti")) { model.next() }
                .keyboardShortcut(.defaultAction)
                .disabled(keys.saving)
        }
    }
}

/// Una chiave del passo 2: nome con le condizioni, sito del provider, campo con etichetta visibile e Prova.
private struct OnboardingKeyRow: View {
    let guide: ProviderGuide
    @ObservedObject var keys: SettingsModel
    let recommended: Bool

    private var test: TestState { keys.tests[guide.id] ?? .idle }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(recommended ? String(format: L("%@ (consigliata)"), guide.name) : guide.name).font(Brand.Fonts.section)
                Text(guide.summary).font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText)
            }
            HStack(spacing: 8) {
                Text(String(format: L("Chiave API di %@"), guide.name)).foregroundStyle(Brand.secondaryText)
                Spacer()
                Button {
                    NSWorkspace.shared.open(guide.url)
                } label: {
                    Label(String(format: L("Apri %@…"), guide.url.host() ?? guide.name), systemImage: "arrow.up.right.square")
                }
                .help(guide.url.absoluteString)
            }
            HStack(spacing: 8) {
                SecureField(String(format: L("Chiave API di %@"), guide.name), text: keys.binding(guide.id), prompt: Text(L("Incolla la chiave")))
                    .labelsHidden()
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 13, design: .monospaced))
                    .accessibilityLabel(String(format: L("Chiave API di %@"), guide.name))
                Button(L("Prova")) { keys.test(guide.id) }
                    .help(L("Prova la chiave con una richiesta vera ai modelli del consiglio"))
                    .disabled(!keys.hasKey(guide.id) || test == .testing)
            }
            if test != .idle { TestResultView(state: test) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 8).strokeBorder(Brand.hairline))
    }
}
