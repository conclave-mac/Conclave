// PrintExport.swift — stampa (⌘P) ed esportazione PDF di una discussione, come Note e Mail:
// lo stesso Markdown dell'esportazione diventa un NSAttributedString impaginato da un NSTextView
// fuori schermo e stampato con NSPrintOperation (il PDF è una stampa salvata su file).
// La carta è sempre bianca: colori fissi nero/grigio, mai i colori dinamici del tema.

import AppKit

enum DebatePrint {
    private static let bodySize: CGFloat = 11
    private static let text = NSColor.black
    private static let secondary = NSColor(white: 0.35, alpha: 1)
    private static let rule = NSColor(white: 0.8, alpha: 1)
    private static let fill = NSColor(white: 0.95, alpha: 1)

    /// Mostra il pannello di stampa (con "PDF" in basso, come ogni app Mac) come foglio sulla finestra.
    static func print(markdown: String, title: String, in window: NSWindow) {
        let op = operation(markdown: markdown, title: title, info: NSPrintInfo.shared.copy() as! NSPrintInfo)
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    /// Salva direttamente in PDF (voce "Esporta come PDF…"), senza pannello di stampa.
    static func exportPDF(markdown: String, title: String, to url: URL) -> Bool {
        let info = NSPrintInfo.shared.copy() as! NSPrintInfo
        info.jobDisposition = .save
        info.dictionary()[NSPrintInfo.AttributeKey.jobSavingURL] = url
        let op = operation(markdown: markdown, title: title, info: info)
        op.showsPrintPanel = false
        op.showsProgressPanel = false
        return op.run()
    }

    private static func operation(markdown: String, title: String, info: NSPrintInfo) -> NSPrintOperation {
        info.horizontalPagination = .fit
        info.verticalPagination = .automatic
        info.isHorizontallyCentered = false
        info.isVerticallyCentered = false
        for m in [\NSPrintInfo.leftMargin, \.rightMargin, \.topMargin, \.bottomMargin] { info[keyPath: m] = 54 }
        let width = info.paperSize.width - info.leftMargin - info.rightMargin

        let view = NSTextView(frame: NSRect(x: 0, y: 0, width: width, height: 100))
        view.isEditable = false
        view.drawsBackground = true
        view.backgroundColor = .white
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.textStorage?.setAttributedString(document(markdown))
        view.appearance = NSAppearance(named: .aqua)
        if let lm = view.layoutManager, let tc = view.textContainer {
            lm.ensureLayout(for: tc)
            view.setFrameSize(NSSize(width: width, height: ceil(lm.usedRect(for: tc).height) + 1))
        }

        let op = NSPrintOperation(view: view, printInfo: info)
        op.jobTitle = title
        return op
    }

    // MARK: Markdown → testo per la carta

    static func document(_ markdown: String) -> NSAttributedString {
        let out = NSMutableAttributedString()
        append(parseMarkdownBlocks(markdown), to: out, indent: 0)
        // Niente riga vuota in fondo (pagina in più se cade sul bordo).
        while out.string.hasSuffix("\n") { out.deleteCharacters(in: NSRange(location: out.length - 1, length: 1)) }
        return out
    }

    private static func paragraph(indent: CGFloat = 0, head: CGFloat? = nil, before: CGFloat = 0, after: CGFloat = 6) -> NSMutableParagraphStyle {
        let p = NSMutableParagraphStyle()
        p.firstLineHeadIndent = indent
        p.headIndent = head ?? indent
        p.paragraphSpacingBefore = before
        p.paragraphSpacing = after
        p.lineSpacing = 2
        return p
    }

    private static func append(_ blocks: [MarkdownBlock], to out: NSMutableAttributedString, indent: CGFloat, color: NSColor = text) {
        for block in blocks {
            switch block {
            case let .heading(level, s):
                let size: CGFloat = level <= 1 ? 18 : level == 2 ? 14.5 : 12.5
                let p = paragraph(indent: indent, before: level <= 2 ? 10 : 6, after: 4)
                out.append(inline(s, size: size, weight: .semibold, color: color, style: p))
            case let .paragraph(s):
                out.append(inline(s, size: bodySize, color: color, style: paragraph(indent: indent)))
            case let .list(items):
                for (i, item) in items.enumerated() {
                    let left = indent + CGFloat(item.level) * 16
                    let p = paragraph(indent: left, head: left + 16, after: i == items.count - 1 ? 6 : 2)
                    p.tabStops = [NSTextTab(textAlignment: .left, location: left + 16)]
                    let marker = item.ordered ? item.marker : "•"
                    out.append(inline(marker + "\t" + item.text, size: bodySize, color: color, style: p))
                }
            case let .table(header, rows):
                table(header: header, rows: rows, to: out, indent: indent, color: color)
            case let .quote(inner):
                append(inner, to: out, indent: indent + 14, color: secondary)
            case let .code(_, s):
                // Un solo blocco per tutte le righe (stesso NSTextBlock), spazio solo dopo l'ultima.
                let block = fullWidthBlock()
                block.backgroundColor = fill
                block.setWidth(6, type: .absoluteValueType, for: .padding)
                let lines = s.components(separatedBy: "\n")
                for (i, line) in lines.enumerated() {
                    let p = paragraph(indent: indent, after: i == lines.count - 1 ? 8 : 0)
                    p.textBlocks = [block]
                    p.lineSpacing = 1
                    out.append(NSAttributedString(string: line + "\n", attributes: [
                        .font: NSFont.monospacedSystemFont(ofSize: bodySize - 1.5, weight: .regular),
                        .foregroundColor: color, .paragraphStyle: p]))
                }
            case .rule:
                // Riga orizzontale: paragrafo vuoto con il solo bordo inferiore.
                let block = fullWidthBlock()
                block.setBorderColor(rule, for: .maxY)
                block.setWidth(0.5, type: .absoluteValueType, for: .border, edge: .maxY)
                let p = paragraph(indent: indent, before: 4, after: 10)
                p.textBlocks = [block]
                out.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 4), .paragraphStyle: p]))
            }
        }
    }

    /// Un NSTextBlock senza larghezza non disegna fondo né bordi: va fissata al 100%.
    private static func fullWidthBlock() -> NSTextBlock {
        let block = NSTextBlock()
        block.setValue(100, type: .percentageValueType, for: .width)
        return block
    }

    private static func table(header: [String], rows: [[String]], to out: NSMutableAttributedString, indent: CGFloat, color: NSColor) {
        let t = NSTextTable()
        t.numberOfColumns = max(header.count, 1)
        t.collapsesBorders = true
        t.layoutAlgorithm = .automaticLayoutAlgorithm
        for (r, row) in ([header] + rows).enumerated() {
            for c in 0..<t.numberOfColumns {
                let cell = NSTextTableBlock(table: t, startingRow: r, rowSpan: 1, startingColumn: c, columnSpan: 1)
                cell.setBorderColor(rule)
                cell.setWidth(0.5, type: .absoluteValueType, for: .border)
                cell.setWidth(4, type: .absoluteValueType, for: .padding)
                if r == 0 { cell.backgroundColor = fill }
                let p = paragraph(after: 0)
                p.textBlocks = [cell]
                let s = c < row.count ? row[c] : ""
                out.append(inline(s, size: bodySize - 1, weight: r == 0 ? .semibold : .regular, color: color, style: p))
            }
        }
        // Spazio dopo la tabella: un paragrafo vuoto fuori dalla tabella.
        out.append(NSAttributedString(string: "\n", attributes: [.font: NSFont.systemFont(ofSize: 4), .paragraphStyle: paragraph(indent: indent, after: 4)]))
    }

    /// Una riga con grassetto, corsivo, codice e link (solo http/https), chiusa da "\n".
    private static func inline(_ raw: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor, style: NSParagraphStyle) -> NSAttributedString {
        let base = NSFont.systemFont(ofSize: size, weight: weight)
        let out = NSMutableAttributedString()
        let parsed = renderInlineMarkdown(raw)
        for run in parsed.runs {
            let piece = String(parsed[run.range].characters)
            var font = base
            let intent = run.inlinePresentationIntent ?? []
            if intent.contains(.code) {
                font = NSFont.monospacedSystemFont(ofSize: size - 1, weight: weight)
            } else {
                var traits: NSFontTraitMask = []
                if intent.contains(.stronglyEmphasized) { traits.insert(.boldFontMask) }
                if intent.contains(.emphasized) { traits.insert(.italicFontMask) }
                if !traits.isEmpty { font = NSFontManager.shared.convert(base, toHaveTrait: traits) }
            }
            var attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color, .paragraphStyle: style]
            if intent.contains(.strikethrough) { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
            // Link già limitati a http/https da renderInlineMarkdown; sottolineati, come nella chat.
            if let url = run.link {
                attrs[.link] = url
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }
            out.append(NSAttributedString(string: piece, attributes: attrs))
        }
        out.append(NSAttributedString(string: "\n", attributes: [.font: base, .paragraphStyle: style]))
        return out
    }
}
