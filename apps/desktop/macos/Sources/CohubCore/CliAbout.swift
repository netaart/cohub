public struct CliAbout: Equatable, Sendable {
    public struct Runtime: Equatable, Sendable {
        public let root: String
        public let version: String?
    }

    public let version: String
    public let commit: String?
    public let node: String
    public let path: String?
    public let pathVersion: String?
    public let runtimes: [Runtime]

    public init?(_ json: JSON) {
        guard let version = json["version"]?.string, let node = json["node"]?.string else { return nil }
        self.version = version
        commit = json["commit"]?.string
        self.node = node
        path = json["path"]?["path"]?.string
        pathVersion = json["path"]?["version"]?.string
        runtimes = json["runtimes"]?.array?.compactMap { item in
            item["root"]?.string.map { Runtime(root: $0, version: item["version"]?.string) }
        } ?? []
    }

    public static func fetch(from service: HostService?) async -> CliAbout? {
        guard let service else { return nil }
        let answers = AsyncStream<CliAbout?> { continuation in
            Task {
                if case .result(let result) = await service.call(BridgeRequest(id: "about", method: HostProtocol.ServiceMethod.cliAbout)) {
                    continuation.yield(CliAbout(result))
                } else {
                    continuation.yield(nil)
                }
            }
            Task {
                try? await Task.sleep(for: .seconds(2))
                continuation.yield(nil)
            }
        }
        for await answer in answers { return answer }
        return nil
    }

    public var label: String { commit.map { "\(version) (\($0))" } ?? version }

    public var pathIsBehind: Bool { pathVersion.map { Self.isOlder($0, than: version) } ?? false }

    public func isBehind(_ runtime: Runtime) -> Bool { runtime.version.map { Self.isOlder($0, than: version) } ?? true }

    private static func isOlder(_ version: String, than other: String) -> Bool {
        let parts = { (value: String) in (value.split(separator: "-").first ?? "").split(separator: ".").map { Int($0) ?? 0 } }
        let (a, b) = (parts(version), parts(other))
        for index in 0..<max(a.count, b.count) {
            let (x, y) = (index < a.count ? a[index] : 0, index < b.count ? b[index] : 0)
            if x != y { return x < y }
        }
        return false
    }
}
