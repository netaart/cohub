import Foundation

public struct WebOrigin: Sendable, Equatable {
    public enum Navigation: Equatable, Sendable {
        case allow
        case external(URL)
        case deny
    }

    public let url: URL

    public init?(_ text: String) {
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil else { return nil }
        self.url = url
    }

    public var origin: String {
        var text = "\(url.scheme!.lowercased())://\(url.host!.lowercased())"
        if let port = url.port { text += ":\(port)" }
        return text
    }

    public func contains(_ other: URL) -> Bool {
        other.scheme?.lowercased() == url.scheme?.lowercased()
            && other.host?.lowercased() == url.host?.lowercased()
            && other.port == url.port
    }

    public func path(of other: URL) -> String? {
        guard contains(other), let components = URLComponents(url: other, resolvingAgainstBaseURL: false) else { return nil }
        var text = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { text += "?\(query)" }
        if let fragment = components.percentEncodedFragment { text += "#\(fragment)" }
        return text
    }

    public func url(for path: String) -> URL? {
        guard WebOrigin.isInAppPath(path) else { return nil }
        return URL(string: origin + path)
    }

    public static func isInAppPath(_ path: String) -> Bool {
        path.hasPrefix("/") && !path.hasPrefix("//") && !path.contains("\\") && path.count <= 2_048
    }

    public static func newSpacePath(folder: String) -> String? {
        var components = URLComponents()
        components.queryItems = [URLQueryItem(name: "folder", value: folder)]
        guard let encoded = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B") else { return nil }
        let path = "/spaces/new#\(encoded)"
        return isInAppPath(path) ? path : nil
    }

    public func navigation(to target: URL) -> Navigation {
        if contains(target) { return .allow }
        switch target.scheme?.lowercased() {
        case "https", "http", "mailto", "tel": return .external(target)
        default: return .deny
        }
    }

    public static func path(fromDeepLink link: URL, scheme: String = "cohub") -> String? {
        guard link.scheme?.lowercased() == scheme, link.host?.lowercased() == "open",
              let components = URLComponents(url: link, resolvingAgainstBaseURL: false)
        else { return nil }
        var path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { path += "?\(query)" }
        if let fragment = components.percentEncodedFragment { path += "#\(fragment)" }
        return isInAppPath(path) ? path : nil
    }
}
