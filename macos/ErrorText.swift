import Foundation

/// Testo e azione per i codici d'errore stabili del motore (`error_code` su messaggi ed eventi,
/// vedi `src/errors.ts`). Il motore scrive sempre anche il testo italiano (`error`): resta per la
/// cronologia, le esportazioni e come dettaglio; all'utente si mostra il testo tradotto con un'azione.
/// Codici sconosciuti (motore più nuovo), `unknown`, `cancelled` o assenti (discussioni vecchie):
/// si mostra il testo del motore com'è.
enum ErrorText {
    struct Info: Equatable {
        /// Cosa è successo, in una frase.
        let message: String
        /// Cosa può fare l'utente.
        let action: String
        /// Testo completo da mostrare: "Messaggio Azione".
        var text: String { "\(message) \(action)" }
    }

    static func info(_ code: String?) -> Info? {
        switch code {
        case "rate_limited":
            return Info(message: L("Servizio occupato o limite di richieste raggiunto."), action: L("Riprova tra qualche minuto."))
        case "quota_exhausted":
            return Info(message: L("Quota del piano esaurita."), action: L("Riprova più tardi (le quote giornaliere tornano il giorno dopo) o togli questa voce dal consiglio."))
        case "invalid_key":
            return Info(message: L("Chiave API rifiutata dal provider."), action: L("Controllala in Impostazioni ▸ Chiavi API."))
        case "missing_key":
            return Info(message: L("Chiave API mancante."), action: L("Aggiungila in Impostazioni ▸ Chiavi API."))
        case "network":
            return Info(message: L("Provider non raggiungibile."), action: L("Controlla la connessione a Internet."))
        case "model_retired":
            return Info(message: L("Modello ritirato dal provider."), action: L("Scegline un altro in Impostazioni ▸ Modelli."))
        case "timeout":
            return Info(message: L("Nessuna risposta in tempo."), action: L("Il servizio è lento: riprova più tardi."))
        case "interrupted":
            return Info(message: L("Risposta interrotta a metà."), action: L("Rilancia la domanda."))
        case "too_long":
            return Info(message: L("Domanda o allegati troppo lunghi per questo modello."), action: L("Accorcia la domanda o togli qualche allegato."))
        case "empty":
            return Info(message: L("Il modello ha restituito una risposta vuota."), action: L("Riprova o scegli un altro modello."))
        case "claude_unavailable":
            return Info(message: L("Claude non si avvia."), action: L("Controlla che Claude Code sia installato e collegato al tuo account."))
        case "claude_credits":
            return Info(message: L("Claude chiede un credito o un piano a parte per l'uso da altre app."), action: L("Usa un altro giudice o un'altra voce al posto di Claude."))
        case "provider_error":
            return Info(message: L("Errore del provider."), action: L("Riprova più tardi."))
        case "no_answer":
            return Info(message: L("Nessun modello ha risposto."), action: L("Controlla chiavi e modelli nelle Impostazioni."))
        case "no_verdict":
            return Info(message: L("Nessun giudice ha prodotto il verdetto."), action: L("Rilancia la domanda o scegli un altro giudice."))
        default:
            return nil
        }
    }

    /// Testo da mostrare per un errore: tradotto con l'azione se il codice è noto, altrimenti quello del motore.
    static func text(code: String?, raw: String) -> String {
        info(code)?.text ?? raw
    }
}
