import AppKit
import CohubCore

@MainActor
enum AboutPanel {
    static let repository = URL(string: "https://github.com/netaart/cohub")!

    static func show(service: HostService?, web: String? = nil) async {
        let about = await CliAbout.fetch(from: service)
        var options: [NSApplication.AboutPanelOptionKey: Any] = [.credits: credits(about, web: web)]
        if let commit = Bundle.main.object(forInfoDictionaryKey: "CohubCommit") as? String, !commit.isEmpty { options[.version] = commit }
        NSApp.orderFrontStandardAboutPanel(options: options)
        if #available(macOS 14, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    private static func credits(_ about: CliAbout?, web: String?) -> NSAttributedString {
        let text = NSMutableAttributedString()
        let center = NSMutableParagraphStyle()
        center.alignment = .center
        center.paragraphSpacing = 2
        func line(_ string: String, _ color: NSColor = .secondaryLabelColor, link: URL? = nil) {
            var attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: NSFont.smallSystemFontSize), .foregroundColor: color, .paragraphStyle: center]
            if let link { attributes[.link] = link }
            text.append(NSAttributedString(string: (text.length == 0 ? "" : "\n") + string, attributes: attributes))
        }
        if let web { line(L("Web \(web)"), .labelColor) }
        if let about {
            line(L("Command line \(about.label) · Node \(about.node)"), .labelColor)
            if let path = about.path {
                line(L("Terminal: \(about.pathVersion ?? L("unknown version")) at \((path as NSString).abbreviatingWithTildeInPath)"))
                if about.pathIsBehind { line(L("Older than this app. Choose Install Command Line Tool… to use this one."), .systemOrange) }
            } else {
                line(L("No cohub in the terminal. Choose Install Command Line Tool… to add it."), .systemOrange)
            }
            for runtime in about.runtimes {
                let folder = (runtime.root as NSString).abbreviatingWithTildeInPath
                if about.isBehind(runtime) {
                    line(L("\(folder): \(runtime.version ?? L("older version")) · reconnect to update"), .systemOrange)
                } else {
                    line(L("\(folder): \(runtime.version ?? "")"))
                }
            }
            line("")
        }
        line("github.com/netaart/cohub", link: repository)
        line(L("Open source under Apache-2.0"))
        return text
    }
}
