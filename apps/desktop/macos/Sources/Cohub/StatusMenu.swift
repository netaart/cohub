import AppKit
import CohubCore

@MainActor
final class StatusMenu {
    struct Actions {
        let openSpace: @MainActor (String) -> Void
        let disconnect: @MainActor (String) -> Void
        let newSpace: @MainActor () -> Void
        let stopSharing: @MainActor () -> Void
        let showCohub: @MainActor () -> Void
    }

    private let actions: Actions
    private var item: NSStatusItem?
    private var overview = RuntimeOverview()
    private var sharing = false

    init(actions: Actions) {
        self.actions = actions
    }

    func update(_ next: RuntimeOverview) {
        guard next != overview else { return }
        overview = next
        rebuild()
    }

    func update(sharing next: Bool) {
        guard next != sharing else { return }
        sharing = next
        rebuild()
    }

    private func rebuild() {
        guard let summary = overview.summary else {
            if let item { NSStatusBar.system.removeStatusItem(item) }
            item = nil
            return
        }
        let item = self.item ?? NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        self.item = item
        item.button?.image = Self.icon(summary, sharing: sharing)
        item.button?.toolTip = sharing ? L("Sharing this screen") : Self.describe(summary)
        item.menu = menu()
    }

    private func menu() -> NSMenu {
        let menu = NSMenu()
        if sharing {
            menu.addItem(.disabled(L("Sharing this screen")))
            menu.addItem(ActionMenuItem(L("Stop Sharing")) { [actions] in actions.stopSharing() })
            menu.addItem(.separator())
        }
        menu.addItem(.disabled(L("Connected Folders")))
        for folder in overview.connected {
            let entry = NSMenuItem(title: folder.name, action: nil, keyEquivalent: "")
            entry.image = Self.dot(folder.state)
            entry.toolTip = folder.label
            let submenu = NSMenu()
            submenu.addItem(.disabled(folder.label))
            submenu.addItem(.disabled(Self.describe(folder.state)))
            submenu.addItem(.separator())
            submenu.addItem(ActionMenuItem(L("Open Space")) { [actions] in actions.openSpace(folder.spaceId) })
            submenu.addItem(ActionMenuItem(L("Show in Finder")) {
                NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: folder.root)])
            })
            submenu.addItem(.separator())
            submenu.addItem(ActionMenuItem(L("Disconnect")) { [actions] in actions.disconnect(folder.spaceId) })
            entry.submenu = submenu
            menu.addItem(entry)
        }
        menu.addItem(.separator())
        menu.addItem(ActionMenuItem(L("New Space…")) { [actions] in actions.newSpace() })
        menu.addItem(ActionMenuItem(L("Open Cohub")) { [actions] in actions.showCohub() })
        menu.addItem(NSMenuItem(title: L("Quit Cohub"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        return menu
    }

    static func describe(_ state: RuntimeOverview.State) -> String {
        switch state {
        case .ready: L("Connected")
        case .connecting: L("Connecting…")
        case .error: L("Needs attention")
        case .stopped: L("Not connected")
        }
    }

    private static func icon(_ state: RuntimeOverview.State, sharing: Bool) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
            let ring = NSBezierPath()
            ring.appendArc(withCenter: NSPoint(x: rect.midX, y: rect.midY), radius: 6.5, startAngle: 40, endAngle: 320)
            ring.lineWidth = 2.6
            if state == .connecting { ring.setLineDash([2.4, 2.2], count: 2, phase: 0) }
            NSColor.black.setStroke()
            ring.stroke()
            if sharing {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: rect.midX - 2.5, y: rect.midY - 2.5, width: 5, height: 5)).fill()
            }
            if state == .error {
                NSColor.black.setFill()
                NSBezierPath(ovalIn: NSRect(x: rect.maxX - 6, y: rect.maxY - 6, width: 5, height: 5)).fill()
            }
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func dot(_ state: RuntimeOverview.State) -> NSImage {
        NSImage(size: NSSize(width: 8, height: 8), flipped: false) { rect in
            let color: NSColor = switch state {
            case .ready: .systemGreen
            case .connecting: .systemYellow
            case .error: .systemRed
            case .stopped: .tertiaryLabelColor
            }
            color.setFill()
            NSBezierPath(ovalIn: rect).fill()
            return true
        }
    }
}

@MainActor
final class ActionMenuItem: NSMenuItem {
    private let handler: @MainActor () -> Void

    init(_ title: String, key: String = "", handler: @escaping @MainActor () -> Void) {
        self.handler = handler
        super.init(title: title, action: #selector(run), keyEquivalent: key)
        target = self
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    @objc private func run() { handler() }
}

extension NSMenuItem {
    static func disabled(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }
}
