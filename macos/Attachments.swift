// Allegati del composer: lettura del testo dai file (PDF con PDFKit, testo con rilevamento della
// codifica, immagini e PDF senza testo con l'OCR di Vision) e gettoni per mostrarli.
// Il motore riceve solo testo: l'estrazione avviene sempre qui, in background.

import AppKit
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import Vision

// MARK: - Dati

/// Limiti concordati con il motore (contratto web + allegati). Lunghezze in unità UTF-16,
/// come le conta JavaScript (`text.length`).
enum AttachmentLimits {
    static let maxFiles = 5
    static let maxChars = 40_000
    static let maxTotal = 60_000
    static let maxName = 200
    static let maxQuestion = 20_000
    /// Oltre questa soglia il contatore della domanda diventa visibile.
    static let questionWarning = 15_000
}

enum AttachmentKind: String {
    case pdf, text, image

    var symbol: String {
        switch self {
        case .pdf: return "doc.richtext"
        case .text: return "doc.plaintext"
        case .image: return "photo"
        }
    }

    /// Nome breve del tipo, sempre visibile nel gettone (l'etichetta lunga resta nel suggerimento).
    var shortLabel: String {
        switch self {
        case .pdf: return L("PDF")
        case .text: return L("Testo")
        case .image: return L("Immagine")
        }
    }

    var label: String {
        switch self {
        case .pdf: return L("PDF")
        case .text: return L("Testo")
        case .image: return L("Immagine (testo riconosciuto)")
        }
    }
}

/// Allegato nel composer: in lettura, pronto (con il testo) o non leggibile (con il motivo).
struct AttachmentItem: Identifiable, Equatable {
    let id = UUID()
    var name: String
    var kind: AttachmentKind
    var text: String?
    /// JPEG ridotto in base64 (solo immagini): viaggia al motore insieme al testo OCR. Escluso da ==.
    var imageData: String?
    var error: String?
    var truncated = false
    var loading: Bool { text == nil && error == nil }
    var chars: Int { text?.utf16.count ?? 0 }

    static func == (a: AttachmentItem, b: AttachmentItem) -> Bool {
        a.id == b.id && a.name == b.name && a.kind == b.kind && a.text == b.text
            && a.error == b.error && a.truncated == b.truncated
            && (a.imageData == nil) == (b.imageData == nil)
    }
}

/// Allegato di una discussione salvata: solo i metadati (il testo resta al motore).
struct AttachmentMeta: Equatable {
    let name: String
    let kind: AttachmentKind
    let chars: Int
}

/// Numero con i separatori delle migliaia della lingua dell'interfaccia ("15.234").
func formatCount(_ n: Int) -> String {
    n.formatted(.number.locale(AppLanguage.locale))
}

/// "12.345 caratteri".
func charsText(_ n: Int) -> String {
    n == 1 ? L("1 carattere") : String(format: L("%@ caratteri"), formatCount(n))
}

// MARK: - Lettura del testo

enum AttachmentReader {
    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    /// Estensioni di testo accettate anche quando il sistema non ne conosce il tipo.
    private static let textExtensions: Set<String> = [
        "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "log",
        "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "swift", "py", "rb", "go", "rs", "java",
        "kt", "c", "h", "cpp", "hpp", "m", "cs", "php", "sh", "zsh", "sql", "r", "tex", "srt", "vtt",
    ]

    /// Tipo dell'allegato dal file, o nil se non è supportato.
    static func kind(of url: URL) -> AttachmentKind? {
        let type = (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType
            ?? UTType(filenameExtension: url.pathExtension)
        if let t = type {
            if t.conforms(to: .pdf) { return .pdf }
            if t.conforms(to: .image) { return .image }
            if t.conforms(to: .text) || t.conforms(to: .sourceCode) || t.conforms(to: .json) { return .text }
        }
        return textExtensions.contains(url.pathExtension.lowercased()) ? .text : nil
    }

    /// Legge il testo di un file. Lento (OCR, PDF grandi): da chiamare fuori dal thread principale.
    static func read(_ url: URL, kind: AttachmentKind) throws -> (text: String, imageData: String?) {
        switch kind {
        case .pdf: return (try readPDF(url), nil)
        case .text: return (try readText(url), nil)
        case .image:
            guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
                  let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
            else { throw Failure(message: L("Immagine non leggibile.")) }
            return try imageResult(img, src)
        }
    }

    /// Testo riconosciuto in un'immagine incollata (dati PNG/TIFF degli appunti) e immagine ridotta.
    static func readImage(_ data: Data) throws -> (text: String, imageData: String?) {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil),
              let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
        else { throw Failure(message: L("Immagine non leggibile.")) }
        return try imageResult(img, src)
    }

    /// Foto o grafico senza testo: valido lo stesso se c'è l'immagine ridotta (Gemini la vede davvero).
    private static func imageResult(_ img: CGImage, _ src: CGImageSource) throws -> (text: String, imageData: String?) {
        let jpeg = ImageEncoder.jpegBase64(src)
        do { return (try ocr([img]), jpeg) }
        catch let e as Failure where jpeg != nil && e.message == L("Nessun testo riconosciuto.") { return ("", jpeg) }
    }

    private static func readText(_ url: URL) throws -> String {
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
        guard size <= 20_000_000 else { throw Failure(message: L("File troppo grande (oltre 20 MB).")) }
        let data: Data
        do { data = try Data(contentsOf: url) } catch { throw Failure(message: L("File non leggibile.")) }
        // Un byte nullo nelle prime righe = file binario, non testo.
        if data.prefix(8192).contains(0) { throw Failure(message: L("Il file non contiene testo.")) }
        var converted: NSString?
        var lossy: ObjCBool = false
        let enc = NSString.stringEncoding(for: data, encodingOptions: [
            .suggestedEncodingsKey: [String.Encoding.utf8.rawValue, String.Encoding.windowsCP1252.rawValue,
                                     String.Encoding.isoLatin1.rawValue, String.Encoding.utf16.rawValue],
            .allowLossyKey: false,
        ], convertedString: &converted, usedLossyConversion: &lossy)
        if enc != 0, let s = converted as String? { return s }
        if let s = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .windowsCP1252) { return s }
        throw Failure(message: L("Codifica del testo non riconosciuta."))
    }

    /// Testo del PDF; se non ne ha (scansione), OCR delle pagine (al massimo 30).
    private static func readPDF(_ url: URL) throws -> String {
        guard let doc = PDFDocument(url: url) else { throw Failure(message: L("PDF non leggibile.")) }
        if doc.isLocked { throw Failure(message: L("PDF protetto da password.")) }
        if let s = doc.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return s }
        // Una pagina alla volta (resa e OCR) in un autoreleasepool: tenere in memoria 30 pagine a 200 dpi
        // (fino a ~30 MB l'una) poteva arrivare a centinaia di MB.
        var pages: [String] = []
        for i in 0..<min(doc.pageCount, 30) {
            let text: String? = try autoreleasepool {
                guard let page = doc.page(at: i), let img = render(page) else { return nil }
                return try recognize(img)
            }
            if let text { pages.append(text) }
        }
        return try joined(pages)
    }

    /// Pagina del PDF come immagine a ~200 dpi, per l'OCR.
    private static func render(_ page: PDFPage) -> CGImage? {
        let box = page.bounds(for: .mediaBox)
        let scale: CGFloat = 200.0 / 72.0
        let w = Int(box.width * scale), h = Int(box.height * scale)
        guard w > 0, h > 0, w * h < 60_000_000,
              let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
        else { return nil }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -box.minX, y: -box.minY)
        page.draw(with: .mediaBox, to: ctx)
        return ctx.makeImage()
    }

    /// OCR con Vision (accurato, italiano e inglese); le immagini sono pagine in ordine.
    private static func ocr(_ images: [CGImage]) throws -> String {
        try joined(images.compactMap { try recognize($0) })
    }

    /// Testo riconosciuto in una pagina (nil se non ce n'è).
    private static func recognize(_ img: CGImage) throws -> String? {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["it-IT", "en-US"]
        req.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: img, options: [:]).perform([req])
        let lines = (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    /// Pagine unite; errore se in nessuna c'era testo.
    private static func joined(_ pages: [String]) throws -> String {
        let text = pages.joined(separator: "\n\n")
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw Failure(message: L("Nessun testo riconosciuto."))
        }
        return text
    }

    /// Taglia a `max` unità UTF-16 senza spezzare un carattere.
    static func truncate(_ s: String, to max: Int) -> String {
        guard s.utf16.count > max else { return s }
        // Gli indici di String vengono arrotondati al confine del carattere precedente.
        return String(s[..<String.Index(utf16Offset: max, in: s)])
    }
}

// MARK: - Gettoni

/// Allegato nel composer: icona del tipo, nome, caratteri (o stato) e ✕ per toglierlo.
struct AttachmentChip: View {
    let item: AttachmentItem
    let remove: () -> Void

    private var detail: String {
        if item.loading { return item.kind == .text ? L("lettura…") : L("riconoscimento del testo…") }
        if let e = item.error { return e }
        return item.kind.shortLabel + " · " + charsText(item.chars) + (item.truncated ? " · " + L("troncato") : "")
    }

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if item.loading {
                    ProgressView().controlSize(.mini)
                } else if item.error != nil {
                    Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.danger)
                } else if item.truncated {
                    Image(systemName: "scissors").foregroundStyle(Brand.warning)
                } else {
                    Image(systemName: item.kind.symbol).foregroundStyle(Brand.text)
                }
            }
            .frame(width: 16)
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 0) {
                Text(item.name)
                    .font(Brand.Fonts.body)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(detail)
                    .font(Brand.Fonts.small)
                    .foregroundStyle(item.error != nil ? AnyShapeStyle(Brand.danger) : AnyShapeStyle(Brand.secondaryText))
                    .lineLimit(item.error != nil ? 2 : 1)
                    .fixedSize(horizontal: false, vertical: true)
                    .monospacedDigit()
            }
            .frame(maxWidth: 220, alignment: .leading)
            Button(action: remove) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Brand.secondaryText)
            .help(String(format: L("Togli %@"), item.name))
            .accessibilityLabel(String(format: L("Togli %@"), item.name))
        }
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous).fill(Brand.hover))
        .overlay(RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous)
            .strokeBorder(item.error != nil ? Brand.danger.opacity(0.5) : item.truncated ? Brand.warning.opacity(0.6) : Brand.hairline, lineWidth: 1))
        .help(item.truncated
              ? String(format: L("Il file era più lungo di %@ caratteri: è stato troncato."), formatCount(AttachmentLimits.maxChars))
              : item.error ?? item.kind.label)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(item.error != nil
            ? String(format: L("Errore: %@"), "\(item.name), \(detail)")
            : "\(item.name), \(item.kind.label), \(detail)")
    }
}

/// Allegati in preparazione (composer e domanda di seguito), su più righe se serve.
struct AttachmentChips: View {
    let items: [AttachmentItem]
    let remove: (UUID) -> Void

    var body: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(items) { a in
                AttachmentChip(item: a) { remove(a.id) }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Allegati"))
    }
}

/// Allegati di una discussione salvata o di una domanda di seguito.
struct AttachmentTags: View {
    let items: [AttachmentMeta]

    var body: some View {
        FlowLayout(spacing: 6, lineSpacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, a in
                AttachmentTag(meta: a)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(L("Allegati"))
    }
}

/// Allegato nell'intestazione di una discussione: icona del tipo, nome e caratteri.
struct AttachmentTag: View {
    let meta: AttachmentMeta

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: meta.kind.symbol)
                .foregroundStyle(Brand.text)
                .accessibilityHidden(true)
            Text(meta.name)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(meta.kind.shortLabel + " · " + charsText(meta.chars))
                .foregroundStyle(Brand.secondaryText)
                .monospacedDigit()
        }
        .font(Brand.Fonts.small)
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(Capsule().fill(Brand.hover))
        .overlay(Capsule().strokeBorder(Brand.hairline, lineWidth: 1))
        .help(meta.name + " — " + meta.kind.label)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(String(format: L("Allegato: %@, %@, %@"), meta.name, meta.kind.label, charsText(meta.chars)))
    }
}

// MARK: - Incolla di file e immagini nel composer

/// Intercetta ⌘V nella finestra principale quando gli appunti contengono file o un'immagine
/// senza testo: diventano allegati invece del nome del file incollato nel campo.
@MainActor
final class AttachmentPasteMonitor {
    private var token: Any?

    func start(_ handle: @escaping (_ urls: [URL], _ image: Data?) -> Void) {
        stop()
        token = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v",
                  // Solo nella finestra principale (non nelle Impostazioni) e non nel campo di ricerca.
                  let win = event.window, win.toolbar?.identifier.hasPrefix("MainToolbar") == true, win.attachedSheet == nil,
                  !((win.firstResponder as? NSTextView)?.delegate is NSSearchField)
            else { return event }
            let pb = NSPasteboard.general
            let urls = (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
            if !urls.isEmpty { handle(urls, nil); return nil }
            // Immagine copiata (es. schermata) senza testo: si riconosce il testo con l'OCR.
            if pb.string(forType: .string) == nil, let data = pb.data(forType: .png) ?? pb.data(forType: .tiff) {
                handle([], data)
                return nil
            }
            return event
        }
    }

    func stop() {
        if let token { NSEvent.removeMonitor(token) }
        token = nil
    }
}

/// Finestra di scelta dei file da allegare (scelta multipla), come foglio della finestra.
@MainActor
func chooseAttachments(_ done: @escaping ([URL]) -> Void) {
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = true
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [.pdf, .image, .text, .sourceCode, .json, .commaSeparatedText, .xml, .yaml]
    panel.prompt = L("Allega")
    panel.message = L("Scegli PDF, file di testo o immagini: il consiglio ne leggerà il testo.")
    let handler: (NSApplication.ModalResponse) -> Void = { r in
        if r == .OK { done(panel.urls) }
    }
    if let win = NSApp.keyWindow ?? NSApp.mainWindow { panel.beginSheetModal(for: win, completionHandler: handler) }
    else { panel.begin(completionHandler: handler) }
}

// MARK: - Immagine ridotta per il motore

// BEGIN ImageEncoder (estratto dalle prove: nessuna dipendenza dal resto dell'app)
enum ImageEncoder {
    /// Massimo di caratteri base64 per allegato e in totale (contratto con il motore).
    static let maxPerImage = 250_000
    static let maxTotal = 600_000

    /// JPEG (senza prefisso data:) in base64, lato lungo <= 1280 px; se troppo grande riprova con
    /// qualità e dimensioni minori. nil se non ci si riesce: l'immagine viaggia solo come testo.
    static func jpegBase64(_ src: CGImageSource) -> String? {
        for (side, quality) in [(1280, 0.7), (1024, 0.5), (768, 0.35), (512, 0.35)] as [(Int, Double)] {
            guard let data = jpeg(src, maxSide: side, quality: quality) else { return nil }
            let b64 = data.base64EncodedString()
            if b64.utf16.count <= maxPerImage { return b64 }
        }
        return nil
    }

    static func jpeg(_ src: CGImageSource, maxSide: Int, quality: Double) -> Data? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxSide,
        ]
        guard let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let w = thumb.width, h = thumb.height
        // JPEG non ha alfa: si disegna su sfondo bianco.
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        let rect = CGRect(x: 0, y: 0, width: w, height: h)
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.fill(rect)
        ctx.draw(thumb, in: rect)
        guard let flat = ctx.makeImage() else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, flat, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
// END ImageEncoder
