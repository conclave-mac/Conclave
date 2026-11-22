// MarkdownView.swift — rendering nativo (SwiftUI) del Markdown prodotto dai modelli.
// Parser a blocchi scritto a mano: titoli, paragrafi, elenchi (un livello di annidamento),
// tabelle, citazioni, blocchi di codice, righe orizzontali. L'inline (grassetto, corsivo,
// codice, link) passa da AttributedString(markdown:) con i link limitati a http/https.
// L'HTML non viene mai interpretato: solo <br> diventa un a capo, il resto resta testo.

import AppKit
import SwiftUI

// MARK: - Inline

/// Sostituisce <br>, <br/>, <br /> (qualsiasi maiuscola) con un a capo.
func replaceHTMLLineBreaks(_ s: String) -> String {
    guard s.range(of: "<br", options: .caseInsensitive) != nil else { return s }
    var out = ""
    out.reserveCapacity(s.count)
    var idx = s.startIndex
    while idx < s.endIndex {
        guard let r = s.range(of: "<br", options: .caseInsensitive, range: idx..<s.endIndex) else {
            out += s[idx...]
            break
        }
        out += s[idx..<r.lowerBound]
        var j = r.upperBound
        while j < s.endIndex, s[j] == " " || s[j] == "\t" { j = s.index(after: j) }
        if j < s.endIndex, s[j] == "/" { j = s.index(after: j) }
        while j < s.endIndex, s[j] == " " || s[j] == "\t" { j = s.index(after: j) }
        if j < s.endIndex, s[j] == ">" {
            out += "\n"
            idx = s.index(after: j)
        } else {
            out += s[r]
            idx = r.upperBound
        }
    }
    return out
}

private final class MarkdownCache: @unchecked Sendable {
    static let shared = MarkdownCache()
    final class BlocksBox { let value: [MarkdownBlock]; init(_ v: [MarkdownBlock]) { value = v } }
    final class InlineBox { let value: AttributedString; init(_ v: AttributedString) { value = v } }
    let blocks: NSCache<NSString, BlocksBox> = { let c = NSCache<NSString, BlocksBox>(); c.countLimit = 300; return c }()
    let inline: NSCache<NSString, InlineBox> = { let c = NSCache<NSString, InlineBox>(); c.countLimit = 5000; return c }()
}

/// Blocchi memorizzati per testo: il parsing non si ripete a ogni render.
func cachedMarkdownBlocks(_ text: String) -> [MarkdownBlock] {
    let key = text as NSString
    if let hit = MarkdownCache.shared.blocks.object(forKey: key) { return hit.value }
    let parsed = parseMarkdownBlocks(text)
    MarkdownCache.shared.blocks.setObject(.init(parsed), forKey: key)
    return parsed
}

/// Testo inline con grassetto, corsivo, codice e link (solo http/https). Mai in errore.
func renderInlineMarkdown(_ raw: String) -> AttributedString {
    let key = raw as NSString
    if let hit = MarkdownCache.shared.inline.object(forKey: key) { return hit.value }
    let s = replaceHTMLLineBreaks(raw)
    var result: AttributedString
    if s.count > 20_000 {
        result = AttributedString(s)   // troppo lungo: testo semplice
    } else {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false,
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        if let parsed = try? AttributedString(markdown: s, options: options) {
            result = parsed
            var unsafe: [Range<AttributedString.Index>] = []
            for (link, range) in result.runs[\.link] {
                guard let url = link else { continue }
                let scheme = url.scheme?.lowercased() ?? ""
                if scheme != "http" && scheme != "https" { unsafe.append(range) }
            }
            for range in unsafe { result[range].link = nil }
            // Link nel colore del marchio e sottolineati (non solo colore); codice inline su fondo tenue.
            var links: [Range<AttributedString.Index>] = []
            for (link, range) in result.runs[\.link] where link != nil { links.append(range) }
            for range in links {
                result[range].foregroundColor = Brand.accent
                result[range].underlineStyle = .single
            }
            var codes: [Range<AttributedString.Index>] = []
            for (intent, range) in result.runs[\.inlinePresentationIntent] where intent?.contains(.code) == true {
                codes.append(range)
            }
            for range in codes { result[range].backgroundColor = Brand.hover }
            // Le immagini non vengono caricate: resta solo il testo alternativo.
            result.imageURL = nil
        } else {
            result = AttributedString(s)
        }
    }
    MarkdownCache.shared.inline.setObject(.init(result), forKey: key)
    return result
}

// MARK: - Vista

struct MarkdownView: View {
    let text: String
    var baseFont: Font = .system(size: Brand.bodySize)
    private let blocks: [MarkdownBlock]
    @AppStorage(TextZoom.key) private var zoom = 1.0

    init(_ text: String, baseFont: Font = .system(size: Brand.bodySize)) {
        self.text = text
        self.baseFont = baseFont
        self.blocks = cachedMarkdownBlocks(text)
    }

    var body: some View {
        MarkdownBlocksStack(blocks: blocks, baseFont: zoom == 1 ? baseFont : .system(size: Brand.bodySize * zoom))
            .foregroundStyle(Brand.text)
            // Interlinea di Claude: 1,4 volte il corpo (14 pt → ~19,6 pt, cioè ~3 pt oltre quella naturale).
            .lineSpacing(3 * zoom)
            .environment(\.textZoom, zoom)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct MarkdownBlocksStack: View {
    let blocks: [MarkdownBlock]
    let baseFont: Font

    var body: some View {
        // Mai pigra: dentro la pila pigra del dibattito una seconda pila pigra sbaglia le altezze.
        // Tra blocchi 0,75 em come in Claude.
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block, baseFont: baseFont)
            }
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let baseFont: Font
    @Environment(\.textZoom) private var zoom

    var body: some View {
        switch block {
        case let .heading(level, text):
            Text(renderInlineMarkdown(text))
                .font(headingFont(level))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                // Più aria prima del titolo che dopo: il titolo regge il blocco che segue.
                .padding(.top, level == 1 ? 14 : level == 2 ? 10 : 6)
                .padding(.bottom, -2)
                .accessibilityAddTraits(.isHeader)
                .accessibilityHeading(accessibilityLevel(level))

        case let .paragraph(text):
            Text(renderInlineMarkdown(text))
                .font(baseFont)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .list(items):
            MarkdownListView(items: items, baseFont: baseFont)

        case let .table(header, rows):
            MarkdownTableView(header: header, rows: rows, baseFont: baseFont)

        case let .quote(inner):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1, style: .continuous)
                    .fill(Brand.secondaryText.opacity(0.35))
                    .frame(width: 3)
                AnyView(MarkdownBlocksStack(blocks: inner, baseFont: baseFont))
                    .foregroundStyle(Brand.secondaryText)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 2)

        case let .code(_, text):
            ScrollView(.horizontal, showsIndicators: true) {
                Text(verbatim: text)
                    .font(baseFont.monospaced())
                    .fixedSize(horizontal: true, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Brand.hover, in: RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous).strokeBorder(Brand.hairline, lineWidth: 1))

        case .rule:
            Rectangle().fill(Brand.hairline).frame(height: 1).padding(.vertical, 6)
                .accessibilityHidden(true)
        }
    }

    /// Nelle risposte i titoli non superano mai l'intestazione di card e verdetto (`Brand.Fonts.section`,
    /// 15 pt): # e ## a 15 pt semibold, ### e oltre come il corpo (semibold); la gerarchia la dà
    /// la spaziatura. Con il testo ingrandito crescono nella stessa proporzione.
    private func headingFont(_ level: Int) -> Font {
        if level <= 2 { return .system(size: 15 * zoom, weight: .semibold) }
        return .system(size: Brand.bodySize * zoom, weight: .semibold)
    }

    private func accessibilityLevel(_ level: Int) -> AccessibilityHeadingLevel {
        switch level {
        case 1: return .h1
        case 2: return .h2
        case 3: return .h3
        default: return .h4
        }
    }
}

private struct MarkdownListView: View {
    let items: [MarkdownListItem]
    let baseFont: Font
    @Environment(\.textZoom) private var zoom

    var body: some View {
        let hasOrdered = items.contains { $0.ordered }
        let longest = items.filter { $0.ordered }.map { $0.marker.count }.max() ?? 1
        let markerWidth: CGFloat = hasOrdered ? (CGFloat(max(longest, 2)) * 8 + 4) * zoom : 14 * zoom
        // Tra voci di elenco 0,25 em come in Claude.
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verbatim: item.marker)
                        .font(baseFont)
                        .monospacedDigit()
                        .foregroundStyle(item.ordered ? AnyShapeStyle(Brand.text) : AnyShapeStyle(Brand.secondaryText))
                        .frame(width: markerWidth, alignment: item.ordered ? .trailing : .center)
                    Text(renderInlineMarkdown(item.text))
                        .font(baseFont)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, CGFloat(item.level) * 20 * zoom)
            }
        }
    }
}

private struct MarkdownTableView: View {
    let header: [String]
    let rows: [[String]]
    let baseFont: Font
    @Environment(\.textZoom) private var zoom

    /// Misure delle colonne per testo e zoom: misurare ogni parola di ogni cella a ogni rivalutazione
    /// (scorrimento, ridimensionamento) era il costo principale delle tabelle.
    private final class Bounds {
        let value: [(min: CGFloat, max: CGFloat)]
        init(_ value: [(min: CGFloat, max: CGFloat)]) { self.value = value }
    }
    private static let boundsCache: NSCache<NSString, Bounds> = {
        let c = NSCache<NSString, Bounds>()
        c.countLimit = 300
        return c
    }()

    private var columnBounds: [(min: CGFloat, max: CGFloat)] {
        // Numero di colonne e separatore dopo l'intestazione: senza, intestazione [A, B] + riga [C] e
        // intestazione [A] + riga [B, C] avevano la stessa chiave, e misure con meno colonne mandavano
        // `widths[col]` fuori indice.
        var parts: [String] = ["\(zoom)", "\(header.count)"]
        parts += header
        parts.append("\u{1}")
        for row in rows { parts += row; parts.append("\u{1}") }
        let key = parts.joined(separator: "\u{2}") as NSString
        if let hit = Self.boundsCache.object(forKey: key) { return hit.value }
        let value = measuredBounds
        Self.boundsCache.setObject(Bounds(value), forKey: key)
        return value
    }

    /// Larghezze misurate di ogni colonna, come il layout automatico delle tabelle HTML (quello di
    /// claude.ai): minima = la parola più larga (mai spezzata a metà), massima = la riga più lunga
    /// (al massimo 320 pt). Misura in semibold: per titoli e grassetti non resta mai corta.
    private var measuredBounds: [(min: CGFloat, max: CGFloat)] {
        let font = NSFont.systemFont(ofSize: Brand.bodySize * zoom, weight: .semibold)
        let attrs: [NSAttributedString.Key: Any] = [.font: font]
        func width(_ s: Substring) -> CGFloat { ceil((String(s) as NSString).size(withAttributes: attrs).width) }
        let padding: CGFloat = 16 + 2   // margini della cella + arrotondamenti del testo
        return (0..<header.count).map { col in
            var lo: CGFloat = 0, hi: CGFloat = 0
            for row in [header] + rows where col < row.count {
                let plain = String(renderInlineMarkdown(row[col]).characters)
                for line in plain.split(separator: "\n") {
                    hi = max(hi, width(line))
                    for word in line.split(whereSeparator: \.isWhitespace) { lo = max(lo, width(word)) }
                }
            }
            let low = lo + padding
            return (low, max(low, min(hi + padding, 320 * zoom)))
        }
    }

    /// Larghezza disponibile, misurata dal contenitore.
    @State private var available: CGFloat = 0
    @State private var tableHeight: CGFloat = 0

    /// Colonne alla larghezza piena se ci stanno; altrimenti ognuna cede in proporzione a quanto
    /// può stringersi, mai sotto la sua parola più larga. Se nemmeno così ci stanno, la tabella
    /// scorre in orizzontale (come `overflow-x: auto` di claude.ai).
    private func fitted(_ bounds: [(min: CGFloat, max: CGFloat)]) -> [CGFloat] {
        let maxTotal = bounds.reduce(0) { $0 + $1.max }
        guard available > 0, maxTotal > available else { return bounds.map(\.max) }
        let minTotal = bounds.reduce(0) { $0 + $1.min }
        // Non ci sta comunque: si scorre, quindi colonne leggibili (fino a 200 pt) e non strette
        // alla parola più larga, che darebbero intestazioni alte una parola per riga.
        guard available > minTotal else { return bounds.map { max($0.min, min($0.max, 200 * zoom)) } }
        let share = (available - minTotal) / (maxTotal - minTotal)
        return bounds.map { ($0.min + ($0.max - $0.min) * share).rounded(.down) }
    }

    var body: some View {
        let widths = fitted(columnBounds)
        Group {
            if available > 0, widths.reduce(0, +) > available + 1 {
                // Altezza dello scorrimento = quella misurata della tabella: da sola la ScrollView
                // orizzontale non la segue e tagliava le ultime righe.
                ScrollView(.horizontal) {
                    table(widths).padding(.bottom, 8)
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tableHeight = $0 }
                }
                .frame(height: tableHeight > 0 ? tableHeight : nil)
                .scrollIndicators(.visible)
            } else {
                table(widths)
            }
        }
        // minWidth 0: la cornice prende la larghezza offerta dalla card, non quella della tabella,
        // così la misura è quella disponibile e la tabella non esce dal riquadro.
        .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { available = $0 }
    }

    private func table(_ widths: [CGFloat]) -> some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(Array(header.enumerated()), id: \.offset) { col, cell in
                    cellView(cell, width: widths[col], header: true)
                }
            }
            .background(Brand.hover)
            ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                Rectangle().fill(Brand.hairline).frame(height: 1)
                    .gridCellUnsizedAxes(.horizontal)   // il divisore non allarga la tabella
                GridRow {
                    ForEach(Array(row.enumerated()), id: \.offset) { col, cell in
                        cellView(cell, width: widths[min(col, widths.count - 1)], header: false)
                    }
                }
                .background(rowBackground(i))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Brand.Radius.control, style: .continuous).strokeBorder(Brand.hairline, lineWidth: 1))
    }

    /// Righe alternate (token Brand) solo per tabelle lunghe, dove aiutano a seguire la riga.
    private func rowBackground(_ i: Int) -> Color {
        guard rows.count > 4, i % 2 == 1 else { return .clear }
        return Brand.hover.opacity(0.5)
    }

    private func cellView(_ text: String, width: CGFloat, header: Bool) -> some View {
        Text(renderInlineMarkdown(text))
            .font(baseFont)
            .fontWeight(header ? .semibold : nil)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .accessibilityAddTraits(header ? .isHeader : [])
            // Ogni cella riempie l'altezza della riga: sfondi di riga uniformi.
            .frame(width: width, alignment: .leading)
            .frame(maxHeight: .infinity, alignment: .topLeading)
    }
}
