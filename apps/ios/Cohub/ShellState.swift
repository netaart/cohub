import CohubCore
import Foundation

@MainActor
enum ShellState {
    private static let defaults = UserDefaults.standard

    static var hostId: String {
        if let id = defaults.string(forKey: "hostId") { return id }
        let id = UUID().uuidString.lowercased()
        defaults.set(id, forKey: "hostId")
        return id
    }

    static func claimFirstLaunch() -> Bool {
        guard !defaults.bool(forKey: "installed") else { return false }
        defaults.set(true, forKey: "installed")
        return true
    }

    static var lastPage: String? {
        get { defaults.string(forKey: "lastPage").flatMap { WebOrigin.isResumable($0) ? $0 : nil } }
        set { defaults.set(newValue, forKey: "lastPage") }
    }

    static func edge(dark: Bool) -> RGB? {
        defaults.string(forKey: dark ? "edgeDark" : "edgeLight").flatMap(RGB.init(hex:))
    }

    static func setEdge(_ edge: RGB, dark: Bool) {
        defaults.set(edge.hex, forKey: dark ? "edgeDark" : "edgeLight")
    }

    static var forceLogin: Bool {
        get { defaults.bool(forKey: "forceLogin") }
        set { defaults.set(newValue, forKey: "forceLogin") }
    }

    static var shortcuts: [HostShortcut] {
        get { defaults.data(forKey: "shortcuts").flatMap { try? JSONDecoder().decode([HostShortcut].self, from: $0) } ?? [] }
        set { defaults.set(try? JSONEncoder().encode(newValue), forKey: "shortcuts") }
    }
}
