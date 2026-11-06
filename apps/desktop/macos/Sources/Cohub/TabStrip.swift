import AppKit
import CohubCore

@MainActor
final class TabStrip: NSView {
    static let minimumHeight: CGFloat = 28
    private static let minTabWidth: CGFloat = 72
    private static let maxTabWidth: CGFloat = 240
    private static let tabTop: CGFloat = 4
    private static let buttonSize: CGFloat = 22

    weak var owner: ShellWindow?
    var leading: CGFloat = 78 {
        didSet { if leading != oldValue { needsLayout = true } }
    }

    private let row = FlippedView()
    private let add = StripButton(symbol: "plus", label: L("New Tab"))
    private var items: [TabItem] = []
    private var palette: EdgePalette?
    private var width: CGFloat = 0
    private var offset: CGFloat = 0
    private var revealsSelected = true
    private var drag: (item: TabItem, start: CGFloat, origin: CGFloat, moved: Bool)?

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        row.wantsLayer = true
        row.layer?.masksToBounds = true
        addSubview(row)
        addSubview(add)
        add.action = { [weak self] in self?.owner?.newTab() }
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func update(tabs: [ShellTab], selected: ShellTab?, palette: EdgePalette) {
        if palette != self.palette {
            self.palette = palette
            layer?.backgroundColor = NSColor(palette.strip).cgColor
            add.tint = NSColor(palette.text)
        }
        var reused = Dictionary(uniqueKeysWithValues: items.map { (ObjectIdentifier($0.tab), $0) })
        let next = tabs.map { tab in reused.removeValue(forKey: ObjectIdentifier(tab)) ?? TabItem(tab: tab, strip: self) }
        for gone in reused.values { gone.removeFromSuperview() }
        for item in next where item.superview == nil { row.addSubview(item) }
        if selected !== items.first(where: \.selected)?.tab || next.count != items.count { revealsSelected = true }
        let dragging = drag?.moved == true && reused.isEmpty && next.count == items.count
        items = dragging ? items : next
        for item in items { item.update(selected: item.tab === selected, palette: palette) }
        setAccessibilityChildren(items)
        needsLayout = true
    }

    override func layout() {
        super.layout()
        arrange(animated: false)
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) { arrange(animated: false) }

    private func arrange(animated: Bool) {
        let room = max(bounds.width - leading - Self.buttonSize - 12, 0)
        let width = items.isEmpty ? 0 : min(max(room / CGFloat(items.count), Self.minTabWidth), Self.maxTabWidth)
        let total = width * CGFloat(items.count)
        self.width = width
        row.frame = NSRect(x: leading, y: 0, width: min(total, room), height: bounds.height)
        if revealsSelected, let index = items.firstIndex(where: \.selected) {
            revealsSelected = false
            offset = min(max(offset, CGFloat(index + 1) * width - room), CGFloat(index) * width)
        }
        offset = min(max(offset, 0), max(total - room, 0))
        let frames = items.indices.map { NSRect(x: CGFloat($0) * width - offset, y: Self.tabTop, width: width, height: bounds.height - Self.tabTop) }
        let placed = zip(items, frames).filter { item, _ in item !== drag?.item || drag?.moved != true }
        if animated {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.15
                for (item, frame) in placed { item.animator().frame = frame }
            }
        } else {
            for (item, frame) in placed { item.frame = frame }
        }
        add.frame = NSRect(x: row.frame.maxX + 4, y: (bounds.height - Self.buttonSize) / 2, width: Self.buttonSize, height: Self.buttonSize)
    }

    fileprivate func beginDrag(_ item: TabItem, with event: NSEvent) {
        let x = convert(event.locationInWindow, from: nil).x
        drag = (item, x, item.frame.minX, false)
    }

    fileprivate func continueDrag(with event: NSEvent) {
        guard var drag, items.count > 1 else { return }
        let x = convert(event.locationInWindow, from: nil).x
        guard drag.moved || abs(x - drag.start) > 4 else { return }
        let item = drag.item
        if !drag.moved {
            drag.moved = true
            self.drag = drag
            item.layer?.zPosition = 1
        }
        item.frame.origin.x = min(max(drag.origin + x - drag.start, 0), row.bounds.width - width)
        let slot = min(max(Int(((item.frame.midX + offset) / width).rounded(.down)), 0), items.count - 1)
        guard let current = items.firstIndex(where: { $0 === item }), slot != current else { return }
        items.remove(at: current)
        items.insert(item, at: slot)
        arrange(animated: true)
    }

    fileprivate func endDrag() {
        guard let drag else { return }
        self.drag = nil
        drag.item.layer?.zPosition = 0
        if drag.moved, let index = items.firstIndex(where: { $0 === drag.item }) {
            owner?.move(drag.item.tab, to: index)
        }
        arrange(animated: drag.moved)
    }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        guard event.clickCount == 2 else { return window.performDrag(with: event) }
        switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
        case "Minimize": window.performMiniaturize(nil)
        case "None": break
        default: window.performZoom(nil)
        }
    }

    override func scrollWheel(with event: NSEvent) {
        let delta = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) ? event.scrollingDeltaX : event.scrollingDeltaY
        offset -= delta
        arrange(animated: false)
    }
}

@MainActor
private final class TabItem: NSView {
    private static let font = NSFont.systemFont(ofSize: 12)
    private static let paragraph: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        return style
    }()

    let tab: ShellTab
    private unowned let strip: TabStrip
    private let close = StripButton(symbol: "xmark", label: L("Close Tab"))
    private(set) var selected = false
    private var hovered = false
    private var title = ""
    private var attention = false
    private var palette: EdgePalette?

    init(tab: ShellTab, strip: TabStrip) {
        self.tab = tab
        self.strip = strip
        super.init(frame: .zero)
        close.action = { [weak self] in
            guard let self else { return }
            self.strip.owner?.close(self.tab)
        }
        addSubview(close)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(.radioButton)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    func update(selected: Bool, palette: EdgePalette) {
        let title = tab.title ?? "Cohub"
        guard selected != self.selected || palette != self.palette || title != self.title || tab.attention != attention else { return }
        self.selected = selected
        self.palette = palette
        self.title = title
        attention = tab.attention
        toolTip = title
        close.tint = NSColor(palette.text)
        setAccessibilityLabel(title)
        setAccessibilityValue(selected)
        refresh()
    }

    private func refresh() {
        close.isHidden = !(selected || (hovered && bounds.width >= 96))
        needsDisplay = true
    }

    override func resizeSubviews(withOldSize oldSize: NSSize) {
        close.frame = NSRect(x: bounds.width - 6 - 16, y: (bounds.height - 16) / 2, width: 16, height: 16)
        refresh()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let palette else { return }
        if selected {
            NSColor(palette.edge).setFill()
            // Taller than the tab, so only the top corners round and the bottom runs into the page.
            NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: bounds.width, height: bounds.height + 8), xRadius: 7, yRadius: 7).fill()
        } else if hovered {
            NSColor(palette.hover).setFill()
            NSBezierPath(roundedRect: NSRect(x: 2, y: 0, width: bounds.width - 4, height: bounds.height - 4), xRadius: 6, yRadius: 6).fill()
        }
        var x: CGFloat = 12
        if attention, !selected {
            NSColor(palette.accent).setFill()
            NSBezierPath(ovalIn: NSRect(x: x, y: bounds.midY - 3, width: 6, height: 6)).fill()
            x += 12
        }
        let height = ceil(Self.font.ascender - Self.font.descender)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: Self.font,
            .foregroundColor: NSColor(selected ? palette.text : palette.muted),
            .paragraphStyle: Self.paragraph,
        ]
        (title as NSString).draw(in: NSRect(x: x, y: (bounds.height - height) / 2, width: max(bounds.width - 28 - x, 0), height: height), withAttributes: attributes)
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        refresh()
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        refresh()
    }

    override func mouseDown(with event: NSEvent) {
        if !selected { strip.owner?.select(tab) }
        strip.beginDrag(self, with: event)
    }

    override func mouseDragged(with event: NSEvent) { strip.continueDrag(with: event) }
    override func mouseUp(with event: NSEvent) { strip.endDrag() }

    override func otherMouseDown(with event: NSEvent) {}

    override func otherMouseUp(with event: NSEvent) {
        if event.buttonNumber == 2 { strip.owner?.close(tab) }
    }

    override func menu(for event: NSEvent) -> NSMenu? { strip.owner?.menu(for: tab) }

    override func accessibilityPerformPress() -> Bool {
        strip.owner?.select(tab)
        return true
    }
}

@MainActor
private final class StripButton: NSView {
    var action: (@MainActor () -> Void)?
    var tint = NSColor.labelColor {
        didSet {
            image.contentTintColor = tint
            needsDisplay = true
        }
    }

    private let image = NSImageView()
    private var hovered = false
    private var pressed = false

    init(symbol: String, label: String) {
        super.init(frame: .zero)
        image.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 10, weight: .semibold))
        image.imageScaling = .scaleNone
        image.autoresizingMask = [.width, .height]
        image.setAccessibilityElement(false)
        addSubview(image)
        toolTip = label
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self, userInfo: nil))
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(label)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { super.hitTest(point) == nil ? nil : self }

    override func draw(_ dirtyRect: NSRect) {
        guard hovered || pressed else { return }
        tint.withAlphaComponent(pressed ? 0.18 : 0.1).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        needsDisplay = true
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        needsDisplay = true
    }

    override func mouseDown(with event: NSEvent) {
        pressed = true
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        pressed = false
        needsDisplay = true
        if bounds.contains(convert(event.locationInWindow, from: nil)) { action?() }
    }

    override func accessibilityPerformPress() -> Bool {
        action?()
        return true
    }
}

private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
    override var mouseDownCanMoveWindow: Bool { false }
}
