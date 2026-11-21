// Identità visiva di Conclave: colori del marchio, logo nativo e sfondo dell'app.
// Il logo riprende l'icona (AppIcon.icon): una c dentro una c, con il verdetto al centro
// (metodo di Paula Scher: la lettera come immagine).
// Tutte le viste usano questi token, mai colori scritti a mano.

import AppKit
import SwiftUI

enum Brand {
    /// Colore d'accento dell'app (pulsanti principali, selezioni del marchio): azzurro
    /// polvere, tenue ma leggibile su chiaro e su scuro.
    static let accent = Color(nsColor: NSColor(name: "BrandAccent") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x9d / 255, green: 0xbb / 255, blue: 0xec / 255, alpha: 1)
            : NSColor(srgbRed: 0x52 / 255, green: 0x7e / 255, blue: 0xcc / 255, alpha: 1)
    })

    // Colori di stato, pastello e in tinta col logo (mai i verdi/rossi accesi di sistema).
    /// Riuscito, funziona, gratuito.
    static let success = Color(nsColor: NSColor(name: "BrandSuccess") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x8c / 255, green: 0xd4 / 255, blue: 0xae / 255, alpha: 1)
            : NSColor(srgbRed: 0x3f / 255, green: 0x9a / 255, blue: 0x70 / 255, alpha: 1)
    })
    /// Avviso, attesa, a pagamento.
    static let warning = Color(nsColor: NSColor(name: "BrandWarning") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0xf0 / 255, green: 0xc9 / 255, blue: 0x80 / 255, alpha: 1)
            : NSColor(srgbRed: 0xc0 / 255, green: 0x86 / 255, blue: 0x2c / 255, alpha: 1)
    })
    /// Errore, non riuscito.
    static let danger = Color(nsColor: NSColor(name: "BrandDanger") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0xf0 / 255, green: 0xa0 / 255, blue: 0x9c / 255, alpha: 1)
            : NSColor(srgbRed: 0xc4 / 255, green: 0x5c / 255, blue: 0x58 / 255, alpha: 1)
    })

    /// Fondo del contenuto: carta calda in chiaro, grafite calda in scuro.
    static let canvas = Color(nsColor: NSColor(name: "BrandCanvas") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x1f / 255, green: 0x1e / 255, blue: 0x1c / 255, alpha: 1)
            : NSColor(srgbRed: 0xf8 / 255, green: 0xf5 / 255, blue: 0xef / 255, alpha: 1)
    })

    /// Velo caldo delle barre laterali sopra il vetro di sistema: un tono appena più scuro del fondo.
    /// Opaco con "Riduci trasparenza" o "Aumenta contrasto" (il vetro sotto non deve trasparire).
    static let sidebarTint = Color(nsColor: NSColor(name: "BrandSidebarTint") { a in
        let solid = DisplayOptions.opaque
        return a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x19 / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: solid ? 1 : 0.85)
            : NSColor(srgbRed: 0xf0 / 255, green: 0xeb / 255, blue: 0xe2 / 255, alpha: solid ? 1 : 0.9)
    })

    /// Lo stesso velo sempre opaco: fondo che la barra laterale si mette da sola quando "Riduci
    /// trasparenza" si accende ad app aperta (SwiftUI non rilegge `sidebarTint` per quel cambio).
    static let sidebarTintOpaque = Color(nsColor: NSColor(name: "BrandSidebarTintOpaque") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x19 / 255, green: 0x18 / 255, blue: 0x16 / 255, alpha: 1)
            : NSColor(srgbRed: 0xf0 / 255, green: 0xeb / 255, blue: 0xe2 / 255, alpha: 1)
    })

    /// Superficie dei riquadri (composer, card, verdetto) sopra il fondo.
    static let surface = Color(nsColor: NSColor(name: "BrandSurface") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x2a / 255, green: 0x28 / 255, blue: 0x25 / 255, alpha: 1)
            : NSColor(srgbRed: 0xff / 255, green: 0xfe / 255, blue: 0xfb / 255, alpha: 1)
    })

    /// Fondo della riga selezionata (barra laterale, elenchi): marrone caldo tenue, intonato al fondo.
    static let selection = Color(nsColor: NSColor(name: "BrandSelection") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0xe8 / 255, green: 0xd8 / 255, blue: 0xc4 / 255, alpha: 0.14)
            : NSColor(srgbRed: 0x6b / 255, green: 0x4a / 255, blue: 0x2b / 255, alpha: 0.12)
    })

    /// Testo della chat e della barra laterale: nero al 90% (#000000e6), bianco al 90% nello scuro.
    static let text = Color(nsColor: NSColor(name: "BrandText") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.9)
            : NSColor(white: 0, alpha: 0.9)
    })

    /// Testo secondario (intestazioni delle sezioni nelle barre laterali): nero al 60%, come Claude;
    /// al 78% con "Aumenta contrasto".
    static let secondaryText = Color(nsColor: NSColor(name: "BrandSecondaryText") { a in
        let more = DisplayOptions.increaseContrast
        return a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: more ? 0.8 : 0.6)
            : NSColor(white: 0, alpha: more ? 0.78 : 0.6)
    })

    /// Fondo della riga sotto il puntatore (barra laterale), grigio neutro come in Claude.
    static let hover = Color(nsColor: NSColor(name: "BrandHover") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.08)
            : NSColor(white: 0, alpha: 0.06)
    })

    /// Corpo del testo della chat e della barra laterale.
    static let bodySize: CGFloat = 14

    /// Testo terziario (orari, suggerimenti): nero al 47%, come gli orari di Claude; al 66% con
    /// "Aumenta contrasto".
    static let tertiaryText = Color(nsColor: NSColor(name: "BrandTertiaryText") { a in
        let more = DisplayOptions.increaseContrast
        return a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: more ? 0.68 : 0.45)
            : NSColor(white: 0, alpha: more ? 0.66 : 0.47)
    })

    /// Colori caldi della chat (argilla, ambra, oliva, rosa antico, come la palette di Claude): stati,
    /// partecipanti e verdetto. Tenui, mai su testo lungo; versioni più chiare nello scuro.
    private static func warm(_ name: String, _ light: UInt32, _ dark: UInt32) -> Color {
        func c(_ v: UInt32) -> NSColor {
            NSColor(srgbRed: CGFloat(v >> 16 & 0xff) / 255, green: CGFloat(v >> 8 & 0xff) / 255, blue: CGFloat(v & 0xff) / 255, alpha: 1)
        }
        return Color(nsColor: NSColor(name: name) { a in a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? c(dark) : c(light) })
    }
    static let clay = warm("BrandClay", 0xC96442, 0xE08A6A)
    /// Colori del logo, uguali all'icona: inchiostro (chiaro sullo scuro), argilla e oro fissi.
    static let logoInk = warm("BrandLogoInk", 0x1F1E1C, 0xEDE8DF)
    static let logoClay = warm("BrandLogoClay", 0xC96442, 0xC96442)
    static let logoGold = warm("BrandLogoGold", 0xE3B062, 0xE3B062)
    static let amberWarm = warm("BrandAmberWarm", 0xB97A1E, 0xE3B062)
    static let olive = warm("BrandOlive", 0x6B7F3A, 0xA9BA70)
    static let rose = warm("BrandRose", 0xB5524A, 0xDB8A82)

    /// Colore del partecipante dalla sua lettera anonima (A, B, C…): sempre lo stesso per la stessa lettera.
    static func participant(_ letter: String) -> Color {
        let palette = [clay, amberWarm, olive, rose]
        let i = Int(letter.unicodeScalars.first?.value ?? 65) - 65
        return palette[((i % palette.count) + palette.count) % palette.count]
    }

    /// Scala tipografica unica (misurata su claude.ai): titolo di pagina 22, titolo di sezione 15,
    /// corpo 14, testi piccoli 12. Le viste usano questi, mai .caption/.callout/.headline di sistema.
    enum Fonts {
        static let pageTitle = Font.system(size: 22, weight: .semibold)
        static let section = Font.system(size: 15, weight: .semibold)
        static let body = Font.system(size: Brand.bodySize)
        static let bodyMedium = Font.system(size: Brand.bodySize, weight: .medium)
        static let small = Font.system(size: 12)
        static let smallMedium = Font.system(size: 12, weight: .medium)
        static let smallSemibold = Font.system(size: 12, weight: .semibold)
    }

    /// Fondo tenue del verdetto: superficie appena tinta dell'accento.
    static let verdictSurface = Color(nsColor: NSColor(name: "BrandVerdictSurface") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0x2e / 255, green: 0x2b / 255, blue: 0x27 / 255, alpha: 1)
            : NSColor(srgbRed: 0xfd / 255, green: 0xfb / 255, blue: 0xf6 / 255, alpha: 1)
    })

    // Raggi comuni (pt).
    enum Radius {
        static let control: CGFloat = 8, card: CGFloat = 12, panel: CGFloat = 16, composer: CGFloat = 20
    }

    /// Bordo sottile dei riquadri.
    static let hairline = Color(nsColor: NSColor(name: "BrandHairline") { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(white: 1, alpha: 0.10)
            : NSColor(srgbRed: 0x2b / 255, green: 0x22 / 255, blue: 0x14 / 255, alpha: 0.10)
    })
}

/// Opzioni di visualizzazione di Accessibilità ("Aumenta contrasto", "Riduci trasparenza"), lette
/// dai colori del marchio a ogni risoluzione: mai una copia statica, così l'ordine tra la notifica
/// di sistema e il ridisegno non conta. Al cambio di "Aumenta contrasto" SwiftUI rilegge da solo
/// tutti i colori (cambia `colorSchemeContrast`); per "Riduci trasparenza" no: la barra laterale
/// lo segue con `accessibilityReduceTransparency` (vedi `SidebarView`).
///
/// Prove senza toccare le impostazioni di sistema: `COUNCIL_A11Y_DISPLAY=contrast,transparency`
/// (anche una sola delle due), valida solo insieme a `COUNCIL_DATA` come le altre variabili di prova.
enum DisplayOptions {
    private static let forced: Set<String> = {
        let env = ProcessInfo.processInfo.environment
        guard env["COUNCIL_DATA"] != nil, let v = env["COUNCIL_A11Y_DISPLAY"] else { return [] }
        return Set(v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    }()

    static var increaseContrast: Bool {
        forced.contains("contrast") || NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
    }

    static var reduceTransparency: Bool {
        forced.contains("transparency") || NSWorkspace.shared.accessibilityDisplayShouldReduceTransparency
    }

    /// Velo delle barre laterali opaco: con uno qualsiasi dei due flag (macOS accende "Riduci
    /// trasparenza" insieme ad "Aumenta contrasto").
    static var opaque: Bool { increaseContrast || reduceTransparency }
}

/// Logo del consiglio disegnato in SwiftUI (nitido a ogni dimensione, segue chiaro/scuro).
struct CouncilLogo: View {
    var size: CGFloat = 40

    var body: some View {
        // Stesse coordinate dei livelli di AppIcon.icon (griglia 1024): c esterna inchiostro,
        // c interna argilla, punto oro; aperture a destra tra 40° e 320°. Centro spostato a destra
        // (540) per compensare otticamente l'apertura della c.
        Canvas { ctx, s in
            let u = s.width / 1024
            let center = CGPoint(x: 540 * u, y: 512 * u)
            for (r, color) in [(328.0, Brand.logoInk), (195.0, Brand.logoClay)] {
                var c = Path()
                c.addArc(center: center, radius: r * u, startAngle: .degrees(40), endAngle: .degrees(320), clockwise: false)
                ctx.stroke(c, with: .color(color), style: StrokeStyle(lineWidth: 98 * u, lineCap: .butt))
            }
            let d = 72 * u
            ctx.fill(Path(ellipseIn: CGRect(x: center.x - d, y: center.y - d, width: d * 2, height: d * 2)), with: .color(Brand.logoGold))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Sfondo dell'app: carta calda con due aloni molto tenui, argilla e ambra.
/// Statico (nessuna animazione) e senza vetro: resta nel livello del contenuto.
struct BrandBackground: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let o = scheme == .dark ? 0.07 : 0.08
        GeometryReader { g in
            let r = max(g.size.width, g.size.height)
            ZStack {
                Brand.canvas
                RadialGradient(colors: [Brand.clay.opacity(o), .clear], center: UnitPoint(x: 0.85, y: 0), startRadius: 0, endRadius: r * 0.6)
                RadialGradient(colors: [Brand.amberWarm.opacity(o * 0.8), .clear], center: UnitPoint(x: 0, y: 1), startRadius: 0, endRadius: r * 0.5)
            }
        }
        .ignoresSafeArea()
        .accessibilityHidden(true)
    }
}

/// Tema scelto nelle Impostazioni (Sistema / Chiaro / Scuro), salvato in UserDefaults.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    static let key = "AppAppearance"

    var title: String {
        switch self {
        case .system: L("Sistema")
        case .light: L("Chiaro")
        case .dark: L("Scuro")
        }
    }

    static var current: AppAppearance {
        AppAppearance(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .system
    }

    /// Applica il tema a tutta l'app; da chiamare all'avvio e a ogni cambio.
    static func apply(_ a: AppAppearance = current) {
        UserDefaults.standard.set(a.rawValue, forKey: key)
        switch a {
        case .system: NSApp.appearance = nil
        case .light: NSApp.appearance = NSAppearance(named: .aqua)
        case .dark: NSApp.appearance = NSAppearance(named: .darkAqua)
        }
    }
}
