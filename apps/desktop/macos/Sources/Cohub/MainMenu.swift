import AppKit

@MainActor
enum MainMenu {
    static func build(updater: NSMenuItem?) -> NSMenu {
        let bar = NSMenu()

        let app = submenu(bar, "Cohub")
        app.addItem(withTitle: L("About Cohub"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        if let updater { app.addItem(updater) }
        app.addItem(.separator())
        app.addItem(withTitle: L("Settings…"), action: #selector(Shell.openSettings(_:)), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: L("Install Command Line Tool…"), action: #selector(Shell.installCommandLineTool(_:)), keyEquivalent: "")
        app.addItem(.separator())
        let services = app.addItem(withTitle: L("Services"), action: nil, keyEquivalent: "")
        services.submenu = NSMenu()
        NSApp.servicesMenu = services.submenu
        app.addItem(.separator())
        app.addItem(withTitle: L("Hide Cohub"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: L("Hide Others"), action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: L("Show All"), action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: L("Quit Cohub"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        let file = submenu(bar, L("File"))
        file.addItem(withTitle: L("New Window"), action: #selector(Shell.newWindow(_:)), keyEquivalent: "n")
        file.addItem(withTitle: L("New Space…"), action: #selector(Shell.newSpace(_:)), keyEquivalent: "n").keyEquivalentModifierMask = [.command, .shift]
        file.addItem(withTitle: L("Close Window"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")

        let edit = submenu(bar, L("Edit"))
        edit.addItem(withTitle: L("Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: L("Redo"), action: Selector(("redo:")), keyEquivalent: "z").keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: L("Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: L("Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: L("Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: L("Paste and Match Style"), action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "v").keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: L("Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")

        let view = submenu(bar, L("View"))
        view.addItem(withTitle: L("Reload Page"), action: #selector(ShellWindow.reloadPage(_:)), keyEquivalent: "r")
        view.addItem(.separator())
        view.addItem(withTitle: L("Actual Size"), action: #selector(ShellWindow.actualSize(_:)), keyEquivalent: "0")
        view.addItem(withTitle: L("Zoom In"), action: #selector(ShellWindow.zoomIn(_:)), keyEquivalent: "+")
        view.addItem(withTitle: L("Zoom Out"), action: #selector(ShellWindow.zoomOut(_:)), keyEquivalent: "-")
        view.addItem(.separator())
        view.addItem(withTitle: L("Enter Full Screen"), action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]

        let history = submenu(bar, L("History"))
        history.addItem(withTitle: L("Back"), action: #selector(ShellWindow.navigateBack(_:)), keyEquivalent: "[")
        history.addItem(withTitle: L("Forward"), action: #selector(ShellWindow.navigateForward(_:)), keyEquivalent: "]")

        let window = submenu(bar, L("Window"))
        window.addItem(withTitle: L("Minimize"), action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: L("Zoom"), action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: L("Bring All to Front"), action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        NSApp.windowsMenu = window

        let help = submenu(bar, L("Help"))
        help.addItem(withTitle: L("Cohub Help"), action: #selector(Shell.openHelp(_:)), keyEquivalent: "?")
        NSApp.helpMenu = help

        return bar
    }

    private static func submenu(_ bar: NSMenu, _ title: String) -> NSMenu {
        let menu = NSMenu(title: title)
        bar.addItem(withTitle: title, action: nil, keyEquivalent: "").submenu = menu
        return menu
    }
}
