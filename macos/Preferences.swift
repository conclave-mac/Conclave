// Preferenze della pagina Generale: lingua dell'interfaccia, apertura all'accesso
// e icona nella barra dei menu. Valori in UserDefaults; le viste li leggono con @AppStorage.

import AppKit
import ServiceManagement
import SwiftUI

/// Testo dell'interfaccia nella lingua scelta (Localizable.strings), per i contesti fuori da Text("…").
func L(_ key: String) -> String {
    NSLocalizedString(key, comment: "")
}

/// Lingua dell'interfaccia. "Sistema" segue l'ordine delle lingue di macOS; il cambio vale al riavvio.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system, it, en
    var id: String { rawValue }
    static let key = "AppLanguage"

    var title: String {
        switch self {
        case .system: L("Come il sistema")
        case .it: "Italiano"
        case .en: "English"
        }
    }

    static var current: AppLanguage {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .system
    }

    /// Lingua effettiva in uso adesso (quella caricata all'avvio).
    static var active: String { Bundle.main.preferredLocalizations.first ?? "it" }

    /// Locale per date e numeri, coerente con la lingua dell'interfaccia.
    static var locale: Locale { Locale(identifier: active == "en" ? "en_US" : "it_IT") }

    /// Salva la scelta: AppleLanguages dell'app decide la lingua al prossimo avvio.
    static func save(_ l: AppLanguage) {
        let d = UserDefaults.standard
        d.set(l.rawValue, forKey: key)
        if l == .system { d.removeObject(forKey: "AppleLanguages") } else { d.set([l.rawValue], forKey: "AppleLanguages") }
    }

    /// Scelta valida in questa esecuzione (letta una volta all'avvio).
    static let launched = current

    /// Riavvio chiesto e chiusura in corso: lo script che riapre l'app parte in `applicationWillTerminate`.
    /// Torna false se la chiusura viene annullata (Impostazioni non salvate), come gli aggiornamenti.
    @MainActor static var relaunchPending = false

    /// Riavvia l'app: chiude questa e la riapre solo dopo la sua uscita (mai due app e due motori insieme).
    /// Con una discussione in corso chiede prima, perché il riavvio la interrompe.
    @MainActor static func relaunch() {
        if UpdateCheck.isBusy() {
            let alert = NSAlert()
            alert.messageText = L("Una discussione è in corso")
            alert.informativeText = L("Il riavvio interrompe la discussione in corso.")
            alert.addButton(withTitle: L("Riavvia ora"))
            alert.addButton(withTitle: L("Annulla"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
        }
        relaunchPending = true
        NSApp.terminate(nil)
    }

    /// Da `applicationWillTerminate`, dopo l'arresto del motore: uno script staccato aspetta che questo
    /// processo esca (al massimo 60 s) e che finisca un eventuale script di aggiornamento (che riapre l'app da
    /// sé o sostituisce il pacchetto: riaprirla prima farebbe saltare lo scambio), poi la riapre.
    /// Con `COUNCIL_DATA` (prove) l'app si riapre con le stesse variabili, mai sui dati reali.
    @MainActor static func launchIfPending() {
        guard relaunchPending else { return }
        relaunchPending = false
        // Il nome dello script di aggiornamento arriva come argomento ("conclave-" + "update"): scritto per
        // intero nel testo, `pgrep -f` troverebbe anche questo script.
        let script = """
        PID="$1" APP="$2" OTHER="conclave-$3"
        for _ in $(seq 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
        for _ in $(seq 450); do /usr/bin/pgrep -f "$OTHER" >/dev/null 2>&1 || break; sleep 0.2; done
        env=()
        for v in COUNCIL_DATA COUNCIL_MODELS COUNCIL_UPDATE_API; do [ -n "${!v}" ] && env+=(--env "$v=${!v}"); done
        /usr/bin/open "${env[@]}" "$APP"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", script, "conclave-relaunch", String(getpid()), Bundle.main.bundleURL.path, "update"]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }
}

extension View {
    /// Ricrea la vista quando cambia il tema: i menu a comparsa (NSPopUpButton) altrimenti
    /// restano disegnati con i colori del tema precedente e il testo diventa invisibile.
    func rebuildOnAppearanceChange() -> some View { modifier(AppearanceRebuild()) }
}

private struct AppearanceRebuild: ViewModifier {
    @AppStorage(AppAppearance.key) private var appearance = AppAppearance.system.rawValue

    func body(content: Content) -> some View { content.id(appearance) }
}

/// Apertura automatica all'accesso (Elementi di login di macOS).
enum LoginItem {
    static var enabled: Bool { SMAppService.mainApp.status == .enabled }
    /// macOS chiede l'approvazione in Impostazioni di Sistema ▸ Elementi di login.
    static var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }

    static func set(_ on: Bool) throws {
        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    }
}

/// Dimensione del testo di risposte e verdetto (Vista ▸ Ingrandisci / Riduci / Dimensioni reali).
enum TextZoom {
    static let key = "TextZoom"
    private static let steps: [Double] = [0.85, 1, 1.15, 1.3, 1.5, 1.75]

    static var value: Double {
        let v = UserDefaults.standard.double(forKey: key)
        return v == 0 ? 1 : v
    }

    private static var index: Int {
        steps.enumerated().min { abs($0.element - value) < abs($1.element - value) }?.offset ?? 1
    }

    static var canGrow: Bool { index < steps.count - 1 }
    static var canShrink: Bool { index > 0 }
    static var isDefault: Bool { value == 1 }

    static func step(_ by: Int) {
        UserDefaults.standard.set(steps[min(max(index + by, 0), steps.count - 1)], forKey: key)
    }

    static func reset() { UserDefaults.standard.set(1.0, forKey: key) }
}

private struct TextZoomKey: EnvironmentKey {
    static let defaultValue = 1.0
}

extension EnvironmentValues {
    /// Ingrandimento del testo scelto dall'utente, letto dal renderer Markdown.
    var textZoom: Double {
        get { self[TextZoomKey.self] }
        set { self[TextZoomKey.self] = newValue }
    }
}

/// Icona nella barra dei menu: la mostra o la toglie l'AppDelegate quando cambia.
enum MenuBarPreference {
    static let key = "ShowInMenuBar"
    static let changed = Notification.Name("MenuBarPreferenceChanged")
    static var enabled: Bool { UserDefaults.standard.bool(forKey: key) }

    static func set(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: key)
        NotificationCenter.default.post(name: changed, object: nil)
    }
}
