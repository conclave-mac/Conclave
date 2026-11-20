// Aggiornamenti: l'app chiede a GitHub qual è l'ultima versione pubblicata e, se è più recente,
// propone di installarla da sola (come Sparkle) o, se non si può, di aprire la pagina del download.
// Installazione: DMG della propria architettura scaricato con URLSession (niente attributo di
// quarantena, quindi niente Gatekeeper), SHA256 confrontato con SHA256SUMS.txt della release, app
// copiata accanto a quella installata e accettata solo se la sua firma soddisfa il requisito
// designato dell'app in uso (certificato del progetto: solo chi ha il .p12 può produrla). Una build
// di sviluppo ad-hoc ha un requisito legato al cdhash e quindi non accetta mai un aggiornamento.
// La sostituzione la fa uno script staccato dopo la chiusura dell'app, che poi la riapre.
// È l'unica richiesta di rete che l'app fa di sua iniziativa: si disattiva in Impostazioni ▸ Generale.

import AppKit
import CryptoKit
import Security
import SwiftUI

enum UpdateCheck {
    static let enabledKey = "UpdateCheckEnabled"
    private static let skippedKey = "UpdateSkippedVersion"
    /// Versione per cui l'app si è chiusa per installare: al riavvio dice se la sostituzione non è riuscita.
    private static let installingKey = "UpdateInstalling"
    private static let api = URL(string: "https://api.github.com/repos/peppolone/Conclave/releases/latest")!
    static let releasesPage = URL(string: "https://github.com/peppolone/Conclave/releases")!

    struct Release: Equatable {
        let version: String
        let notes: String
        let page: URL
        /// Nome del file → indirizzo di download, solo per indirizzi accettati da `trusted`.
        var assets: [String: URL] = [:]
    }

    static var enabled: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    static var currentVersion: String? { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String }

    /// Discussioni in corso (le imposta l'AppDelegate): l'installazione chiude l'app e le interromperebbe.
    @MainActor static var isBusy: () -> Bool = { false }

    /// Solo per le prove: con `COUNCIL_DATA` si può puntare a una release finta su 127.0.0.1.
    private static var testAPI: URL? {
        let env = ProcessInfo.processInfo.environment
        guard !(env["COUNCIL_DATA"] ?? "").isEmpty, let s = env["COUNCIL_UPDATE_API"],
              let u = URL(string: s), u.scheme == "http", u.host == "127.0.0.1" else { return nil }
        return u
    }

    /// Un indirizzo arrivato dalla rete si apre o si scarica solo se è su github.com in https.
    private static func trusted(_ u: URL) -> Bool {
        if u.scheme == "https", u.host == "github.com" { return true }
        return testAPI != nil && u.scheme == "http" && u.host == "127.0.0.1"
    }

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

    /// Legge la risposta di GitHub.
    static func parse(_ data: Data) -> Release? {
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let tag = j["tag_name"] as? String else { return nil }
        let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
        guard version.first?.isNumber == true else { return nil }
        var page = releasesPage
        if let s = j["html_url"] as? String, let u = URL(string: s), trusted(u) { page = u }
        var assets: [String: URL] = [:]
        for a in j["assets"] as? [[String: Any]] ?? [] {
            if let name = a["name"] as? String, let s = a["browser_download_url"] as? String,
               let u = URL(string: s), trusted(u) { assets[name] = u }
        }
        return Release(version: version, notes: j["body"] as? String ?? "", page: page, assets: assets)
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

    /// Ultima versione pubblicata; nil se non ce n'è ancora nessuna.
    static func latest() async throws -> Release? {
        var req = URLRequest(url: testAPI ?? api, timeoutInterval: 15)
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        req.setValue("Conclave", forHTTPHeaderField: "User-Agent")
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { return nil }
        guard code == 200 else { throw URLError(.badServerResponse) }
        return parse(data)
    }

    /// Controllo automatico (a ogni avvio) o richiesto dal menu.
    /// Quello automatico non disturba mai: parla solo se c'è una versione nuova non saltata.
    /// L'avviso automatico è un foglio sulla finestra principale, mai una finestra modale a sé:
    /// non deve comparire sopra le Impostazioni del primo avvio o mentre si scrive altrove.
    @MainActor
    static func run(manual: Bool, over window: NSWindow?) async {
        let d = UserDefaults.standard
        if Installer.busy {
            if manual { Installer.progressWindow?.makeKeyAndOrderFront(nil) }
            return
        }
        if Installer.hasWaiting {
            if manual { inform(L("Aggiornamento pronto"), L("Si installerà al termine della discussione in corso.")) }
            return
        }
        if let version = Installer.deferredVersion {
            if manual { inform(L("Aggiornamento pronto"), String(format: L("Conclave %@ si installerà quando chiudi l'app."), version)) }
            return
        }
        if !manual {
            // Mai durante le prove (COUNCIL_DATA) né con una build senza versione.
            guard enabled, currentVersion != nil, (ProcessInfo.processInfo.environment["COUNCIL_DATA"] ?? "").isEmpty else { return }
            // Data del prossimo controllo delle versioni che controllavano una volta a settimana.
            d.removeObject(forKey: "UpdateCheckNext")
        }
        let current = currentVersion ?? "0"
        let release: Release?
        do { release = try await latest() } catch {
            if manual { inform(L("Impossibile controllare gli aggiornamenti"), error.localizedDescription) }
            return
        }
        // Finestra principale non visibile o già con un foglio aperto: si riprova al prossimo avvio.
        if !manual { guard let window, window.isVisible, window.attachedSheet == nil else { return } }
        guard let release, isNewer(release.version, than: current) else {
            if manual { inform(L("Conclave è aggiornato"), String(format: L("La versione %@ è la più recente."), current)) }
            return
        }
        if !manual, d.string(forKey: skippedKey) == release.version { return }

        let alert = NSAlert()
        alert.messageText = String(format: L("È disponibile Conclave %@"), release.version)
        let notes = readableNotes(release.notes)
        alert.informativeText = String(format: L("Hai la versione %@."), current)
            + (notes.isEmpty ? "" : "\n\n" + (notes.count > 600 ? String(notes.prefix(600)) + "…" : notes))
        // Senza i file della release o senza permesso di scrittura si resta sulla pagina del download.
        let installable = Installer.canInstall(release)
        alert.addButton(withTitle: installable ? L("Installa e riavvia") : L("Apri la pagina del download…"))
        alert.addButton(withTitle: L("Più tardi"))
        alert.addButton(withTitle: L("Salta questa versione"))
        present(alert, over: window) { r in
            switch r {
            case .alertFirstButtonReturn:
                if installable { Task { await Installer.install(release, over: window) } } else { NSWorkspace.shared.open(release.page) }
            case .alertThirdButtonReturn: d.set(release.version, forKey: skippedKey)
            default: break
            }
        }
    }

    /// All'avvio: se l'app si era chiusa per installare una versione e questa non è quella in uso,
    /// la sostituzione non è riuscita (per esempio macOS l'ha bloccata): si propone il download.
    @MainActor
    static func reportFailedInstall(over window: NSWindow?) {
        let d = UserDefaults.standard
        guard let wanted = d.string(forKey: installingKey) else { return }
        d.removeObject(forKey: installingKey)
        let current = currentVersion ?? "0"
        guard isNewer(wanted, than: current) else { return }
        let alert = NSAlert()
        alert.messageText = String(format: L("Conclave %@ non è stato installato"), wanted)
        alert.informativeText = L("Non è stato possibile sostituire l'app. Puoi scaricare la versione nuova dalla pagina del download.")
        alert.addButton(withTitle: L("Apri la pagina del download…"))
        alert.addButton(withTitle: L("Chiudi"))
        present(alert, over: window) { if $0 == .alertFirstButtonReturn { NSWorkspace.shared.open(releasesPage) } }
    }

    @MainActor
    static func present(_ alert: NSAlert, over window: NSWindow?, _ handle: @escaping (NSApplication.ModalResponse) -> Void) {
        if let window, window.isVisible, window.attachedSheet == nil {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }

    @MainActor
    private static func inform(_ title: String, _ text: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: L("Chiudi"))
        alert.runModal()
    }

    // MARK: - Installazione

    enum Installer {
        struct Staged {
            let version: String
            /// App nuova già verificata, sullo stesso volume di quella installata.
            let app: URL
            /// Cartella temporanea che la contiene: lo script la cancella dopo la sostituzione.
            let dir: URL
        }

        enum Failure: LocalizedError {
            case missingFiles, download(Int), checksum, signature, version, tool(String)
            var errorDescription: String? {
                switch self {
                case .missingFiles: L("La release non contiene i file per questo Mac.")
                case .download(let code): String(format: L("Download non riuscito (HTTP %d)."), code)
                case .checksum: L("Il file scaricato non corrisponde a quello pubblicato.")
                case .signature: L("La firma della versione scaricata non è quella di Conclave.")
                case .version: L("La versione scaricata non è quella attesa.")
                case .tool(let msg): msg
                }
            }
        }

        @MainActor static var busy = false
        @MainActor static var progressWindow: NSWindow?
        /// Pronto da installare alla chiusura dell'app (lo script parte in `applicationWillTerminate`).
        @MainActor private static var staged: Staged?
        /// Pronto ma in attesa che finiscano le discussioni in corso.
        @MainActor private static var waiting: Staged?
        /// Pronto, ma la chiusura per installarlo è stata annullata: si installa alla prossima
        /// chiusura dell'app, senza riaprirla (mai da `installIfWaiting`, che richiuderebbe l'app).
        @MainActor private static var deferred: Staged?
        /// Cartella dell'aggiornamento dal download fino alla consegna allo script: alla chiusura
        /// dell'app (⌘Q a metà, avviso ancora aperto) si smonta il volume e si cancella.
        @MainActor private static var work: UpdateWork?

        static func assetName(_ version: String) -> String {
            #if arch(arm64)
            "Conclave-\(version)-apple-silicon.dmg"
            #else
            "Conclave-\(version)-intel.dmg"
            #endif
        }

        /// Serve il DMG di questa architettura, l'elenco degli SHA256 e il permesso di spostare l'app
        /// (anche la cartella del pacchetto: spostare una cartella altrove ne riscrive il "..").
        /// Un'app avviata dal DMG o in traslocazione sta su un volume di sola lettura.
        static func canInstall(_ r: Release) -> Bool {
            let app = Bundle.main.bundleURL
            let fm = FileManager.default
            return r.assets[assetName(r.version)] != nil && r.assets["SHA256SUMS.txt"] != nil
                && app.pathExtension == "app" && !app.path.contains("/AppTranslocation/")
                && fm.isWritableFile(atPath: app.path) && fm.isWritableFile(atPath: app.deletingLastPathComponent().path)
        }

        @MainActor
        static func install(_ r: Release, over window: NSWindow?) async {
            guard !busy else { return }
            busy = true
            let model = UpdateProgress(title: String(format: L("Aggiornamento a Conclave %@"), r.version))
            let w = UpdateWork()
            work = w
            let task = Task { try await prepare(r, model, w) }
            model.onCancel = { task.cancel() }
            showProgress(model, over: window)
            let result = await task.result
            closeProgress(over: window)
            busy = false
            switch result {
            case .success(let s):
                guard isBusy() else { return finish(s) }
                let alert = NSAlert()
                alert.messageText = L("Una discussione è in corso")
                alert.informativeText = L("Per installare l'aggiornamento Conclave si chiude e si riapre, interrompendo la discussione in corso.")
                alert.addButton(withTitle: L("Installa al termine"))
                alert.addButton(withTitle: L("Installa ora"))
                present(alert, over: window) { r in
                    if r == .alertSecondButtonReturn { finish(s) } else { waiting = s }
                }
            case .failure(let error):
                work = nil
                if error is CancellationError || (error as? URLError)?.code == .cancelled { return }
                let alert = NSAlert()
                alert.messageText = L("Impossibile installare l'aggiornamento")
                alert.informativeText = error.localizedDescription
                alert.addButton(withTitle: L("Apri la pagina del download…"))
                alert.addButton(withTitle: L("Chiudi"))
                present(alert, over: window) { if $0 == .alertFirstButtonReturn { NSWorkspace.shared.open(r.page) } }
            }
        }

        /// Chiamata quando cambia lo stato delle discussioni: installa se ne era in attesa una.
        @MainActor
        static func installIfWaiting() {
            guard let s = waiting, !isBusy() else { return }
            waiting = nil
            finish(s)
        }

        @MainActor static var hasWaiting: Bool { waiting != nil }

        @MainActor static var deferredVersion: String? { deferred?.version }

        /// Chiusura dell'app annullata (per esempio per le Impostazioni non salvate): l'aggiornamento
        /// pronto non deve riaprire l'app alla prossima chiusura, ma non si butta senza dirlo: si
        /// installa quando l'utente chiude l'app, e lo si avvisa.
        @MainActor
        static func deferStaged() {
            guard let s = staged else { return }
            staged = nil
            deferred = s
            UserDefaults.standard.removeObject(forKey: installingKey)
            // Dopo la risposta a applicationShouldTerminate, non dentro.
            Task { @MainActor in
                inform(L("Aggiornamento rimandato"), String(format: L("Conclave %@ si installerà quando chiudi l'app."), s.version))
            }
        }

        @MainActor
        private static func finish(_ s: Staged) {
            staged = s
            UserDefaults.standard.set(s.version, forKey: installingKey)
            NSApp.terminate(nil)
        }

        /// Da `applicationWillTerminate`, dopo l'arresto del motore: lo script aspetta che il processo
        /// esca (al massimo 60 s), scambia i pacchetti (in caso di errore rimette quello vecchio) e
        /// riapre l'app. Un aggiornamento in attesa della fine delle discussioni (o rimandato) si
        /// installa anche se l'utente chiude l'app, ma senza riaprirla. Senza nulla da installare,
        /// un aggiornamento a metà si annulla e la sua cartella si cancella.
        @MainActor
        static func launchIfStaged() {
            guard let s = staged ?? waiting ?? deferred else {
                work?.discard()
                work = nil
                return
            }
            let reopen = staged != nil
            staged = nil
            waiting = nil
            deferred = nil
            work = nil
            if !reopen { UserDefaults.standard.set(s.version, forKey: installingKey) }
            // La copia nuova ha aspettato in una cartella temporanea (anche ore, con "Installa al termine"):
            // la sua firma si ricontrolla subito prima dello scambio, altrimenti non si installa nulla.
            // Se il requisito non si legge, "never": lo script scarta la copia e riapre comunque l'app vecchia.
            let requirement = designatedRequirementText() ?? "never"
            // Prima dello scambio nessun processo deve girare dal pacchetto: il motore che si sta
            // chiudendo (fino a 10 s) o una seconda istanza aperta nel frattempo. A questa si
            // toglierebbe l'app da sotto (e `open` riattiverebbe lei, non la versione nuova): niente
            // scambio né riapertura, il marker resta e l'istanza aperta dice che non è stato installato.
            // La firma (lenta: tutto il pacchetto, Node compreso) si controlla prima di quell'attesa,
            // così tra l'ultimo controllo dei processi e lo spostamento non passa quasi nulla; e se
            // un'istanza parte proprio in quell'attimo (il suo percorso resta quello dell'app anche
            // dopo lo spostamento) si rimette subito tutto com'era.
            // Con `COUNCIL_DATA` (prove) l'app si riapre con le stesse variabili, mai sui dati reali.
            let script = """
            PID="$1" APP="$2" DIR="$3" NEW="$4" REOPEN="$5" REQ="$6"
            inside() { /bin/ps -axww -o comm= | { while IFS= read -r c; do case "$c" in "$APP"/*) exit 0;; esac; done; exit 1; }; }
            clean() { [ -d "$DIR/mnt" ] && /usr/bin/hdiutil detach -force "$DIR/mnt" >/dev/null 2>&1; rm -rf "$DIR"; }
            reopen() {
              [ "$REOPEN" = 1 ] || return 0
              env=()
              for v in COUNCIL_DATA COUNCIL_MODELS COUNCIL_UPDATE_API; do [ -n "${!v}" ] && env+=(--env "$v=${!v}"); done
              /usr/bin/open "${env[@]}" "$APP"
            }
            signed=1
            /usr/bin/codesign --verify --deep --strict --test-requirement="=$REQ" "$NEW" 2>/dev/null || signed=0
            for _ in $(seq 300); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
            for _ in $(seq 50); do inside || break; sleep 0.2; done
            if inside; then clean; exit 0; fi
            if [ "$signed" = 0 ]; then clean; reopen; exit 0; fi
            if mv "$APP" "$DIR/old.app"; then
              if inside; then mv "$DIR/old.app" "$APP"; clean; exit 0; fi
              mv "$NEW" "$APP" || mv "$DIR/old.app" "$APP"
            fi
            [ -e "$APP" ] && clean
            reopen
            """
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/bin/bash")
            p.arguments = ["-c", script, "conclave-update", String(getpid()), Bundle.main.bundleURL.path, s.dir.path, s.app.path,
                           reopen ? "1" : "0", requirement]
            p.standardInput = FileHandle.nullDevice
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            try? p.run()
        }

        /// Scarica, controlla e prepara l'app nuova accanto a quella installata. Non tocca l'app in uso.
        private static func prepare(_ r: Release, _ model: UpdateProgress, _ work: UpdateWork) async throws -> Staged {
            let name = assetName(r.version)
            guard let dmgURL = r.assets[name], let sumsURL = r.assets["SHA256SUMS.txt"] else { throw Failure.missingFiles }
            let fm = FileManager.default
            let dir = try fm.url(for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: Bundle.main.bundleURL, create: true)
            work.dir = dir
            do {
                let (sums, resp) = try await URLSession.shared.data(from: sumsURL)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                guard code == 200 else { throw Failure.download(code) }
                // Righe "<sha256>  <nome del file>".
                let expected = String(decoding: sums, as: UTF8.self).split(whereSeparator: \.isNewline)
                    .map { $0.split(separator: " ", omittingEmptySubsequences: true) }
                    .first { $0.count == 2 && $0[1] == name }?[0].lowercased()
                guard let expected else { throw Failure.missingFiles }

                let dmg = dir.appendingPathComponent("update.dmg")
                try await download(dmgURL, to: dmg) { f in Task { @MainActor in model.fraction = f } }
                try Task.checkCancellation()
                await MainActor.run { model.fraction = nil; model.status = L("Verifica…") }
                // Il task staccato non eredita l'annullamento: Annulla lo passa a `work`, che chiude
                // subito `ditto` (prima si aspettava la fine della copia).
                let job = Task.detached { () throws -> URL in
                    guard try sha256(dmg, work) == expected else { throw Failure.checksum }
                    let mnt = dir.appendingPathComponent("mnt")
                    try fm.createDirectory(at: mnt, withIntermediateDirectories: true)
                    // `attach` non si interrompe a metà (il volume potrebbe restare collegato).
                    try work.run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt.path, dmg.path])
                    let app = dir.appendingPathComponent("Conclave.app")
                    let copied = Result { try work.run("/usr/bin/ditto", [mnt.appendingPathComponent("Conclave.app").path, app.path], cancellable: true) }
                    // Se resta montato si riprova quando la cartella si cancella (errore, chiusura, script).
                    UpdateWork.unmount(mnt)
                    try copied.get()
                    try? fm.removeItem(at: dmg)
                    if work.isCancelled { throw CancellationError() }
                    _ = try? work.run("/usr/bin/xattr", ["-dr", "com.apple.quarantine", app.path])
                    try verify(app, version: r.version)
                    return app
                }
                let staged = try await withTaskCancellationHandler { try await job.value } onCancel: {
                    work.cancel()
                    job.cancel()
                }
                try Task.checkCancellation()
                return Staged(version: r.version, app: staged, dir: dir)
            } catch {
                let cancelled = work.isCancelled
                work.cleanUp()
                // `ditto` chiuso da Annulla esce con un errore: è un annullamento, non un guasto.
                throw cancelled ? CancellationError() : error
            }
        }

        /// Requisito designato dell'app in uso come testo (per `codesign --test-requirement`).
        private static func designatedRequirementText() -> String? {
            var me: SecCode?, mine: SecStaticCode?, req: SecRequirement?, text: CFString?
            guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
                  SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine,
                  SecCodeCopyDesignatedRequirement(mine, [], &req) == errSecSuccess, let req,
                  SecRequirementCopyString(req, [], &text) == errSecSuccess, let text else { return nil }
            return text as String
        }

        /// La firma dell'app nuova deve soddisfare il requisito designato di quella in uso.
        private static func verify(_ app: URL, version: String) throws {
            var me: SecCode?, mine: SecStaticCode?, req: SecRequirement?, new: SecStaticCode?
            guard SecCodeCopySelf([], &me) == errSecSuccess, let me,
                  SecCodeCopyStaticCode(me, [], &mine) == errSecSuccess, let mine,
                  SecCodeCopyDesignatedRequirement(mine, [], &req) == errSecSuccess, let req,
                  SecStaticCodeCreateWithPath(app as CFURL, [], &new) == errSecSuccess, let new else { throw Failure.signature }
            let flags = SecCSFlags(rawValue: UInt32(kSecCSCheckAllArchitectures) | UInt32(kSecCSStrictValidate) | UInt32(kSecCSCheckNestedCode))
            guard SecStaticCodeCheckValidity(new, flags, req) == errSecSuccess else { throw Failure.signature }
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
            guard info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier,
                  info?["CFBundleShortVersionString"] as? String == version else { throw Failure.version }
        }

        private static func sha256(_ file: URL, _ work: UpdateWork) throws -> String {
            let h = try FileHandle(forReadingFrom: file)
            defer { try? h.close() }
            var hasher = SHA256()
            while let chunk = try h.read(upToCount: 1 << 20), !chunk.isEmpty {
                if work.isCancelled { throw CancellationError() }
                hasher.update(data: chunk)
            }
            return hasher.finalize().map { String(format: "%02x", $0) }.joined()
        }

        private static func download(_ url: URL, to dest: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
            let d = Downloader(dest: dest, progress: progress)
            let session = URLSession(configuration: .ephemeral, delegate: d, delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let task = session.downloadTask(with: url)
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
                    d.continuation = c
                    task.resume()
                }
            } onCancel: { task.cancel() }
        }

        @MainActor
        private static func showProgress(_ model: UpdateProgress, over window: NSWindow?) {
            let sheet = NSWindow(contentViewController: NSHostingController(rootView: UpdateProgressView(model: model)))
            sheet.styleMask = [.titled]
            progressWindow = sheet
            if let window, window.isVisible, window.attachedSheet == nil {
                window.beginSheet(sheet)
            } else {
                sheet.center()
                sheet.makeKeyAndOrderFront(nil)
            }
        }

        @MainActor
        private static func closeProgress(over window: NSWindow?) {
            guard let sheet = progressWindow else { return }
            progressWindow = nil
            if let parent = sheet.sheetParent { parent.endSheet(sheet) } else { sheet.orderOut(nil) }
        }

        /// Poco dopo l'avvio: cartelle di aggiornamenti rimaste nei temporanei (app finita in crash
        /// con un aggiornamento pronto, rimandato o a metà). Mai con un'altra istanza aperta, che
        /// potrebbe averne uno in corso, né per cartelle cambiate negli ultimi 10 minuti (lo script
        /// di scambio di un'istanza appena chiusa, o un aggiornamento appena avviato da questa).
        @MainActor
        static func removeLeftovers() {
            DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
                let me = getpid()
                let others = NSRunningApplication.runningApplications(withBundleIdentifier: Bundle.main.bundleIdentifier ?? "")
                    .contains { $0.processIdentifier != me }
                guard !others, !MainActor.assumeIsolated({ busy }) else { return }
                DispatchQueue.global(qos: .utility).async {
                    let fm = FileManager.default
                    // Stessa cartella che userebbe un aggiornamento: se ne crea una e si guardano le sorelle
                    // con lo stesso prefisso ("NSIRD_Conclave_…").
                    guard let probe = try? fm.url(for: .itemReplacementDirectory, in: .userDomainMask,
                                                  appropriateFor: Bundle.main.bundleURL, create: true) else { return }
                    try? fm.removeItem(at: probe)
                    let name = probe.lastPathComponent
                    guard let cut = name.lastIndex(of: "_"), name.contains(ProcessInfo.processInfo.processName) else { return }
                    let prefix = String(name[...cut])
                    let items = (try? fm.contentsOfDirectory(at: probe.deletingLastPathComponent(),
                                                             includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
                    for item in items where item.lastPathComponent.hasPrefix(prefix) {
                        let changed = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantFuture
                        guard Date().timeIntervalSince(changed) > 600 else { continue }
                        // Volume rimasto montato: si smonta prima; se non si riesce, la cartella resta.
                        guard UpdateWork.unmount(item.appendingPathComponent("mnt")) else { continue }
                        try? fm.removeItem(at: item)
                    }
                }
            }
        }
    }
}

/// Un aggiornamento in preparazione: cartella, processo in corso e annullamento. Usato dal task
/// staccato della verifica e dal main thread (Annulla, chiusura dell'app), quindi con un lock.
final class UpdateWork: @unchecked Sendable {
    private let lock = NSLock()
    private var folder: URL?
    private var process: Process?
    /// Il processo in corso si può chiudere con Annulla (`ditto` sì, `hdiutil attach` no).
    private var killable = false
    private var cancelled = false

    var isCancelled: Bool { lock.withLock { cancelled } }
    var dir: URL? {
        get { lock.withLock { folder } }
        set { lock.withLock { folder = newValue } }
    }

    /// Esegue uno strumento e ne aspetta la fine; dopo Annulla non ne parte più nessuno.
    func run(_ path: String, _ args: [String], cancellable: Bool = false) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        let err = Pipe()
        p.standardOutput = FileHandle.nullDevice
        p.standardError = err
        try lock.withLock {
            if cancelled { throw CancellationError() }
            try p.run()
            process = p
            killable = cancellable
        }
        let msg = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        lock.withLock { process = nil }
        guard p.terminationStatus == 0 else {
            throw UpdateCheck.Installer.Failure.tool("\((path as NSString).lastPathComponent): " + msg.trimmingCharacters(in: .whitespacesAndNewlines).prefix(300))
        }
    }

    func cancel() {
        lock.withLock {
            cancelled = true
            if killable { process?.terminate() }
        }
    }

    /// Annulla, smonta e cancella. Sincrono ma breve: va bene anche in `applicationWillTerminate`,
    /// dove poi il processo esce. `hdiutil attach` non si interrompe: se dopo 1 s è ancora in corso,
    /// la pulizia passa a uno script staccato che ne aspetta la fine, anche ad app chiusa.
    func discard() {
        cancel()
        let deadline = Date().addingTimeInterval(1)
        while lock.withLock({ process?.isRunning == true }), Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
        if let pid = lock.withLock({ process?.isRunning == true ? process?.processIdentifier : nil }), let dir {
            self.dir = nil
            Self.cleanLater(dir, after: pid)
            return
        }
        cleanUp()
    }

    /// Smonta il volume del DMG se è ancora montato e cancella la cartella. Se il volume resta
    /// montato, ci riprova uno script staccato.
    func cleanUp() {
        guard let dir else { return }
        if Self.unmount(dir.appendingPathComponent("mnt")) {
            try? FileManager.default.removeItem(at: dir)
        } else {
            Self.cleanLater(dir, after: 0)
        }
        self.dir = nil
    }

    /// Script staccato (sopravvive alla chiusura dell'app): aspetta la fine del processo `pid`
    /// (0 = nessuno; al massimo 2 minuti), smonta il volume con fino a tre tentativi forzati e
    /// cancella la cartella, mai con il volume ancora montato.
    static func cleanLater(_ dir: URL, after pid: Int32) {
        let script = """
        PID="$1" DIR="$2"
        if [ "$PID" -gt 0 ]; then for _ in $(seq 600); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done; fi
        mounted() { [ -d "$DIR/mnt" ] && [ "$(/usr/bin/stat -f %d "$DIR/mnt")" != "$(/usr/bin/stat -f %d "$DIR")" ]; }
        for _ in 1 2 3; do mounted || break; /usr/bin/hdiutil detach -force "$DIR/mnt" >/dev/null 2>&1 || sleep 1; done
        mounted || rm -rf "$DIR"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/bash")
        p.arguments = ["-c", script, "conclave-cleanup", String(pid), dir.path]
        p.standardInput = FileHandle.nullDevice
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }

    /// `detach` può fallire per un attimo (volume ancora in uso, Spotlight): fino a tre tentativi,
    /// gli ultimi forzati. false se resta montato.
    @discardableResult
    static func unmount(_ mnt: URL) -> Bool {
        for attempt in 0..<3 {
            guard isMountPoint(mnt) else { return true }
            if attempt > 0 { Thread.sleep(forTimeInterval: 1) }
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/hdiutil")
            p.arguments = ["detach"] + (attempt > 0 ? ["-force"] : []) + [mnt.path]
            p.standardOutput = FileHandle.nullDevice
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { continue }
            p.waitUntilExit()
        }
        return !isMountPoint(mnt)
    }

    /// Un volume montato ha un dispositivo diverso dalla cartella che lo contiene.
    private static func isMountPoint(_ url: URL) -> Bool {
        var a = stat(), b = stat()
        guard stat(url.path, &a) == 0, stat(url.deletingLastPathComponent().path, &b) == 0 else { return false }
        return a.st_dev != b.st_dev
    }
}

/// Riceve il DMG e lo sposta subito nella cartella dell'aggiornamento (il file temporaneo di
/// URLSession sparisce al ritorno del metodo).
private final class Downloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    let dest: URL
    let progress: @Sendable (Double) -> Void
    var continuation: CheckedContinuation<Void, Error>?
    private var failure: Error?

    init(dest: URL, progress: @escaping @Sendable (Double) -> Void) {
        self.dest = dest
        self.progress = progress
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        let code = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { failure = UpdateCheck.Installer.Failure.download(code); return }
        do { try FileManager.default.moveItem(at: location, to: dest) } catch { failure = error }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        if totalBytesExpectedToWrite > 0 { progress(Double(totalBytesWritten) / Double(totalBytesExpectedToWrite)) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let e = error ?? failure { continuation?.resume(throwing: e) } else { continuation?.resume() }
        continuation = nil
    }
}

@MainActor
final class UpdateProgress: ObservableObject {
    let title: String
    @Published var status = L("Download…")
    /// nil = avanzamento indeterminato (verifica).
    @Published var fraction: Double? = 0
    var onCancel: () -> Void = {}
    init(title: String) { self.title = title }
}

struct UpdateProgressView: View {
    @ObservedObject var model: UpdateProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.title).font(Brand.Fonts.section).foregroundStyle(Brand.text)
            if let f = model.fraction {
                ProgressView(value: f).progressViewStyle(.linear)
            } else {
                ProgressView().progressViewStyle(.linear)
            }
            Text(model.status).font(Brand.Fonts.small).foregroundStyle(Brand.secondaryText)
            HStack {
                Spacer()
                Button(L("Annulla")) { model.onCancel() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(20)
        .frame(width: 360)
    }
}
