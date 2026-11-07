public struct HostShortcut: Codable, Equatable, Sendable {
    public let id: String
    public let label: String
    public let path: String

    public init(id: String, label: String, path: String) {
        self.id = id
        self.label = label
        self.path = path
    }

    public init?(_ params: JSON) {
        guard let id = params["id"]?.string, (1...128).contains(id.count),
              let label = params["label"]?.string, (1...64).contains(label.count),
              let path = params["path"]?.string, WebOrigin.isInAppPath(path)
        else { return nil }
        self.init(id: id, label: label, path: path)
    }

    public func pushed(onto recent: [HostShortcut], limit: Int) -> [HostShortcut] {
        Array(([self] + recent.filter { $0.id != id }).prefix(limit))
    }
}
