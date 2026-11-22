// Voci del Portachiavi di macOS (quello tradizionale, a file). Niente Portachiavi "data
// protection" né access group: richiedono un team Apple. Senza Team ID la partition list lega
// ogni voce creata dall'app alla singola build (`cdhash:`): dopo ogni aggiornamento macOS
// chiederebbe la password. Per questo le voci si leggono e scrivono con `/usr/bin/security`,
// come fa gh (go-keyring): la voce appartiene a quello strumento di Apple, che non cambia
// con gli aggiornamenti dell'app, e non ci sono più richieste. Le funzioni `legacy…` usano le
// API dirette solo per recuperare la voce delle versioni precedenti (vedi `KeyStore`).

import Foundation
import Security

struct KeychainError: LocalizedError {
    let status: OSStatus
    let account: String
    var detail: String? = nil

    var errorDescription: String? {
        let reason = detail ?? SecCopyErrorMessageString(status, nil) as String? ?? String(format: L("errore %d"), Int(status))
        return String(format: L("Portachiavi, voce %@: %@"), account, reason)
    }
}

/// Voci `kSecClassGenericPassword` di un servizio.
struct Keychain {
    let service: String
    /// Portachiavi da usare (solo per le prove); nil = quello predefinito dell'utente.
    var keychain: String? = nil

    static let conclave = Keychain(service: "io.github.peppolone.conclave")

    /// `security` termina con 44 quando la voce non c'è.
    private static let notFoundExit: Int32 = 44

    /// Comandi passati sullo stdin di `security -i`, così il valore non compare tra gli argomenti
    /// del processo; una riga oltre ~4 KB viene troncata (limite noto anche a go-keyring).
    private static let maxCommandLength = 4000

    /// `-w` stampa in esadecimale i valori con caratteri non ASCII: si salva sempre in base64
    /// con un prefisso (come `go-keyring-base64:`), così la lettura è univoca.
    private static let base64Prefix = "conclave-base64:"

    /// Attesa massima di un comando `security` (di solito 0,2–1 s). Larga perché un portachiavi bloccato
    /// mostra la richiesta della password e l'utente deve avere il tempo di scriverla.
    static let timeout: TimeInterval = 120

    /// Esegue `/usr/bin/security`; restituisce codice di uscita, stdout e stderr. Il comando e la lettura
    /// delle uscite girano su thread a parte; oltre `timeout` il processo si termina e la chiamata fallisce
    /// con un errore: per chi chiama è una voce che non si legge, quindi non viene mai riscritta (KeyStore.write).
    private func run(_ args: [String], stdin: String? = nil) throws -> (Int32, String, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = args
        let out = Pipe(), err = Pipe(), input = Pipe()
        process.standardOutput = out
        process.standardError = err
        process.standardInput = input
        let ended = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in ended.signal() }
        try process.run()
        // Le due uscite si leggono insieme: lette una dopo l'altra, un stderr pieno bloccherebbe `security`.
        let reads = DispatchGroup()
        let buffers = Buffers()
        for (pipe, isOut) in [(out, true), (err, false)] {
            DispatchQueue.global(qos: .userInitiated).async(group: reads) {
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                buffers.set(data, out: isOut)
            }
        }
        if let stdin { try? input.fileHandleForWriting.write(contentsOf: Data(stdin.utf8)) }
        try? input.fileHandleForWriting.close()
        guard ended.wait(timeout: .now() + Self.timeout) == .success else {
            process.terminate()
            if ended.wait(timeout: .now() + 1) == .timedOut { kill(process.processIdentifier, SIGKILL) }
            throw KeychainError(status: errSecIO, account: args.count > 4 ? args[4] : "",
                                detail: String(format: L("security non ha risposto entro %d s"), Int(Self.timeout)))
        }
        _ = reads.wait(timeout: .now() + 2)
        let (outData, errData) = buffers.get()
        return (process.terminationStatus, String(decoding: outData, as: UTF8.self), String(decoding: errData, as: UTF8.self))
    }

    /// Uscite di `security` scritte dai thread di lettura.
    private final class Buffers: @unchecked Sendable {
        private let lock = NSLock()
        private var out = Data(), err = Data()
        func set(_ d: Data, out isOut: Bool) { lock.withLock { if isOut { out = d } else { err = d } } }
        func get() -> (Data, Data) { lock.withLock { (out, err) } }
    }

    private func failure(_ account: String, _ code: Int32, _ stderr: String) -> KeychainError {
        let text = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        return KeychainError(status: errSecIO, account: account, detail: text.isEmpty ? String(format: L("errore %d"), Int(code)) : text)
    }

    /// Argomento tra apici per l'interprete di `security -i`, che non conosce l'escape `'\\''`
    /// della shell: un argomento con un apice non si può passare (il valore è in base64, quindi
    /// può capitare solo con servizio, account o etichetta).
    private static func quote(_ s: String, _ account: String) throws -> String {
        guard !s.contains("'"), !s.contains("\n") else {
            throw KeychainError(status: errSecParam, account: account, detail: L("carattere non ammesso"))
        }
        return "'" + s + "'"
    }

    /// nil se la voce non esiste.
    func read(_ account: String) throws -> String? {
        var args = ["find-generic-password", "-s", service, "-a", account, "-w"]
        if let keychain { args.append(keychain) }
        let (code, out, err) = try run(args)
        if code == Self.notFoundExit { return nil }
        guard code == 0 else { throw failure(account, code, err) }
        // `-w` stampa il valore seguito da un a capo.
        let text = out.hasSuffix("\n") ? String(out.dropLast()) : out
        guard text.hasPrefix(Self.base64Prefix) else { return text }
        guard let data = Data(base64Encoded: String(text.dropFirst(Self.base64Prefix.count))) else {
            throw KeychainError(status: errSecDecode, account: account)
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Crea o aggiorna la voce. Un valore vuoto la cancella.
    func write(_ account: String, _ value: String, label: String? = nil) throws {
        guard !value.isEmpty else { return try delete(account) }
        var command = try ["add-generic-password", "-U", "-s", service, "-a", account,
                       "-l", label ?? "Conclave – \(account)",
                       "-w", Self.base64Prefix + Data(value.utf8).base64EncodedString()].map { try Self.quote($0, account) }
        if let keychain { command.append(try Self.quote(keychain, account)) }
        let line = command.joined(separator: " ")
        guard line.utf8.count <= Self.maxCommandLength else {
            throw KeychainError(status: errSecParam, account: account, detail: L("valore troppo lungo"))
        }
        let (code, _, err) = try run(["-i"], stdin: line + "\n")
        // Qualsiasi messaggio sullo stderr è un errore, anche se il codice di uscita fosse 0.
        let text = err.trimmingCharacters(in: .whitespacesAndNewlines)
        guard code == 0, text.isEmpty else { throw failure(account, code, err) }
    }

    /// Cancellare una voce che non c'è non è un errore.
    func delete(_ account: String) throws {
        var args = ["delete-generic-password", "-s", service, "-a", account]
        if let keychain { args.append(keychain) }
        let (code, _, err) = try run(args)
        guard code == 0 || code == Self.notFoundExit else { throw failure(account, code, err) }
    }

    // MARK: Voci create dalle versioni precedenti con le API dirette

    private func legacyQuery(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account]
    }

    /// nil se la voce non esiste. macOS può chiedere la password (voce legata a un'altra build).
    func legacyRead(_ account: String) throws -> String? {
        var q = legacyQuery(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw KeychainError(status: status, account: account) }
        return String(data: data, encoding: .utf8)
    }

    /// Spesso non riesce (una build diversa non può cancellare: errSecInvalidOwnerEdit).
    func legacyDelete(_ account: String) -> Bool {
        let status = SecItemDelete(legacyQuery(account) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
