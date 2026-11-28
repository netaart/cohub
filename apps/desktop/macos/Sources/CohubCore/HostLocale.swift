import Foundation

public final class HostLocale: @unchecked Sendable {
    public static let shared = HostLocale(defaults: .standard, resources: Bundle.main.resourceURL, fallback: .main)

    static let key = "hostLocale"

    private let defaults: UserDefaults
    private let resources: URL?
    private let fallback: Bundle
    private let lock = NSLock()
    private var resolved: Bundle?

    init(defaults: UserDefaults, resources: URL?, fallback: Bundle) {
        self.defaults = defaults
        self.resources = resources
        self.fallback = fallback
    }

    static func localization(for locale: String?) -> String? {
        switch locale {
        case HostProtocol.Locale.en: "en"
        case HostProtocol.Locale.zhCn: "zh-Hans"
        default: nil
        }
    }

    @discardableResult
    public func set(_ locale: String?) -> Bool {
        let known = Self.localization(for: locale) == nil ? nil : locale
        return lock.withLock {
            guard defaults.string(forKey: Self.key) != known else { return false }
            defaults.set(known, forKey: Self.key)
            resolved = nil
            return true
        }
    }

    public var bundle: Bundle {
        lock.withLock {
            if let resolved { return resolved }
            let chosen = Self.localization(for: defaults.string(forKey: Self.key))
                .flatMap { resources?.appendingPathComponent("\($0).lproj", isDirectory: true) }
                .flatMap { FileManager.default.fileExists(atPath: $0.path) ? Bundle(url: $0) : nil }
            let bundle = chosen ?? fallback
            resolved = bundle
            return bundle
        }
    }
}
