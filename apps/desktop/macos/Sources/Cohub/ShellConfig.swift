import AppKit
import CohubCore

struct ShellConfig {
    let origin: WebOrigin
    let environment: String
    let urlScheme: String
    let isDevelopment: Bool
    let service: (@Sendable () throws -> HostService.Launch)?
    let commandLineTool: URL?

    static func load(bundle: Bundle = .main, env: [String: String] = ProcessInfo.processInfo.environment) -> ShellConfig {
        let info = { (key: String) in bundle.object(forInfoDictionaryKey: key) as? String }
        let environment = env["COHUB_DESKTOP_ENV"] ?? info("CohubEnvironment") ?? "prod"
        let fallbackOrigin = environment == "dev" ? "https://dev.cohub.live" : "https://cohub.live"
        let origin = WebOrigin(env["COHUB_DESKTOP_WEB_ORIGIN"] ?? info("CohubWebOrigin") ?? fallbackOrigin) ?? WebOrigin(fallbackOrigin)!
        let childEnv = childEnvironment(env, environment: environment)
        let serve: @Sendable (URL, URL, URL?) -> HostService.Launch = { node, cli, sandboxd in
            var environment = childEnv
            if let sandboxd, FileManager.default.fileExists(atPath: sandboxd.path) { environment["COHUB_SANDBOXD_BIN"] = sandboxd.path }
            return HostService.Launch(executable: node, arguments: [cli.path, "host", "serve"], environment: environment)
        }

        var service: (@Sendable () throws -> HostService.Launch)?
        var tool: URL?
        if let node = env["COHUB_DESKTOP_NODE"].map(URL.init(fileURLWithPath:)), let cli = env["COHUB_DESKTOP_CLI"].map(URL.init(fileURLWithPath:)) {
            service = { serve(node, cli, env["COHUB_SANDBOXD_BIN"].map(URL.init(fileURLWithPath:))) }
        } else if let bundled = bundle.resourceURL?.appendingPathComponent("runtime"), let id = bundle.bundleIdentifier,
                  FileManager.default.fileExists(atPath: bundled.appendingPathComponent(RuntimeInstall.cliEntry).path),
                  let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let data = support.appendingPathComponent(id, isDirectory: true)
            let root = data.appendingPathComponent("runtime", isDirectory: true)
            let shim = data.appendingPathComponent("bin/cohub")
            let version = "\(info("CFBundleShortVersionString") ?? "0")-\(info("CFBundleVersion") ?? "0")"
            service = {
                let runtime = try RuntimeInstall.prepare(bundled: bundled, root: root, version: version, finish: Processes.clearQuarantine)
                try RuntimeInstall.writeShim(shim, runtime: runtime)
                RuntimeInstall.prune(root: root, keep: runtime, running: Processes.executables())
                return serve(runtime.appendingPathComponent("node"), runtime.appendingPathComponent(RuntimeInstall.cliEntry), runtime.appendingPathComponent(RuntimeInstall.sandboxdEntry))
            }
            tool = shim
        }

        return ShellConfig(
            origin: origin,
            environment: environment,
            urlScheme: info("CohubURLScheme") ?? (environment == "dev" ? "cohub-dev" : "cohub"),
            isDevelopment: environment == "dev" || bundle.bundleIdentifier == nil,
            service: service,
            commandLineTool: tool
        )
    }

    private static func childEnvironment(_ env: [String: String], environment: String) -> [String: String] {
        var child = env.filter { !$0.key.hasPrefix("COHUB_") && $0.key != "ENV" }
        child["COHUB_CLI_AUTO_UPDATE"] = "0"
        if environment == "dev" { child["ENV"] = "dev" }
        return child
    }
}

enum Processes {
    static func clearQuarantine(_ directory: URL) {
        let files = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
        while let file = files?.nextObject() as? URL {
            removexattr(file.path, "com.apple.quarantine", XATTR_NOFOLLOW)
        }
        removexattr(directory.path, "com.apple.quarantine", XATTR_NOFOLLOW)
    }

    static func executables() -> [String] {
        let count = proc_listallpids(nil, 0)
        guard count > 0 else { return [] }
        var pids = [pid_t](repeating: 0, count: Int(count) * 2)
        let filled = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        return pids.prefix(Int(max(filled, 0))).compactMap { pid in
            guard pid > 0 else { return nil }
            let length = proc_pidpath(pid, &path, UInt32(path.count))
            guard length > 0 else { return nil }
            let executable = String(decoding: path.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
            return URL(fileURLWithPath: executable).standardizedFileURL.path
        }
    }
}

@MainActor
enum ShellState {
    private static let defaults = UserDefaults.standard

    static var hostId: String {
        if let id = defaults.string(forKey: "hostId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "hostId")
        return id
    }

    static var session: TabSession? {
        get {
            TabSession.decode(defaults.data(forKey: "tabSession"))
                ?? defaults.string(forKey: "lastPath").flatMap { WebOrigin.isInAppPath($0) ? TabSession(windows: [.init(tabs: [.init(path: $0)])]) : nil }
        }
        set {
            defaults.set(newValue?.encoded(), forKey: "tabSession")
            defaults.removeObject(forKey: "lastPath")
        }
    }

    static var globalShortcut: Bool {
        get { defaults.bool(forKey: "globalShortcut") }
        set { defaults.set(newValue, forKey: "globalShortcut") }
    }

    static var edgeColor: RGB? {
        get { defaults.string(forKey: "edgeColor").flatMap(RGB.init(hex:)) }
        set { defaults.set(newValue?.hex, forKey: "edgeColor") }
    }

    static var serviceHello: ServiceHello? {
        get { defaults.data(forKey: "serviceHello").flatMap { try? JSONDecoder().decode(ServiceHello.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "serviceHello") }
    }

    static var shortcuts: [HostShortcut] {
        get { defaults.data(forKey: "shortcuts").flatMap { try? JSONDecoder().decode([HostShortcut].self, from: $0) } ?? [] }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "shortcuts") }
    }
}

extension NSColor {
    convenience init(_ rgb: RGB) {
        self.init(srgbRed: CGFloat(rgb.red) / 255, green: CGFloat(rgb.green) / 255, blue: CGFloat(rgb.blue) / 255, alpha: 1)
    }
}

extension RGB {
    @MainActor static var window: RGB {
        var rgb = RGB(0xFF, 0xFF, 0xFF)
        NSApp.effectiveAppearance.performAsCurrentDrawingAppearance {
            guard let color = NSColor.windowBackgroundColor.usingColorSpace(.sRGB) else { return }
            let channel = { (value: CGFloat) in UInt8((min(max(value, 0), 1) * 255).rounded()) }
            rgb = RGB(channel(color.redComponent), channel(color.greenComponent), channel(color.blueComponent))
        }
        return rgb
    }
}

func L(_ key: String.LocalizationValue) -> String {
    String(localized: key)
}
