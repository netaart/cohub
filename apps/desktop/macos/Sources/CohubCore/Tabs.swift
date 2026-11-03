import Foundation

public struct TabSession: Codable, Equatable, Sendable {
    public struct Tab: Codable, Equatable, Sendable {
        public var path: String
        public var title: String?
        public var edge: String?

        public init(path: String, title: String? = nil, edge: String? = nil) {
            self.path = path
            self.title = title
            self.edge = edge
        }
    }

    public struct Window: Codable, Equatable, Sendable {
        public var tabs: [Tab]
        public var selected: Int
        public var frame: String?

        public init(tabs: [Tab], selected: Int = 0, frame: String? = nil) {
            self.tabs = tabs
            self.selected = selected
            self.frame = frame
        }
    }

    public static let maxWindows = 16
    public static let maxTabs = 64

    public var windows: [Window]

    public init(windows: [Window]) {
        self.windows = windows
    }

    public func sanitized() -> TabSession {
        TabSession(windows: windows.suffix(Self.maxWindows).compactMap { window in
            let kept = window.tabs.enumerated().filter { WebOrigin.isInAppPath($0.element.path) }.suffix(Self.maxTabs)
            guard !kept.isEmpty else { return nil }
            let selected = kept.lastIndex { $0.offset <= window.selected } ?? kept.startIndex
            return Window(tabs: kept.map(\.element), selected: selected - kept.startIndex, frame: window.frame)
        })
    }

    public static func decode(_ data: Data?) -> TabSession? {
        guard let data, let session = try? JSONDecoder().decode(TabSession.self, from: data).sanitized(), !session.windows.isEmpty else { return nil }
        return session
    }

    public func encoded() -> Data? {
        try? JSONEncoder().encode(self)
    }

    public static func title(_ documentTitle: String?) -> String? {
        var title = documentTitle?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        for suffix in [" — Cohub", " - Cohub", " · Cohub", " | Cohub"] where title.hasSuffix(suffix) {
            title = String(title.dropLast(suffix.count)).trimmingCharacters(in: .whitespaces)
        }
        return title.isEmpty || title == "Cohub" ? nil : title
    }

    public static func samePage(_ a: String, _ b: String) -> Bool {
        let page = { (path: String) in path.prefix { $0 != "?" && $0 != "#" } }
        return page(a) == page(b)
    }
}

public enum TabOrder {
    public static func numbered(_ number: Int, count: Int) -> Int? {
        if number == 9 { return count > 0 ? count - 1 : nil }
        return (1...8).contains(number) && number <= count ? number - 1 : nil
    }

    public static func insertion<ID: Equatable>(after opener: ID, in tabs: [(id: ID, opener: ID?)]) -> Int {
        guard var index = tabs.firstIndex(where: { $0.id == opener }) else { return tabs.count }
        index += 1
        while index < tabs.count, tabs[index].opener == opener { index += 1 }
        return index
    }

    public static func successor<ID: Equatable>(of closing: ID, selected: ID?, in tabs: [(id: ID, opener: ID?)]) -> ID? {
        guard closing == selected, let index = tabs.firstIndex(where: { $0.id == closing }) else { return nil }
        if let opener = tabs[index].opener, tabs.contains(where: { $0.id == opener }) { return opener }
        if index + 1 < tabs.count { return tabs[index + 1].id }
        return index > 0 ? tabs[index - 1].id : nil
    }
}

public struct ClosedTabs: Sendable {
    public static let limit = 25

    public struct Entry: Equatable, Sendable {
        public let tab: TabSession.Tab
        public let index: Int
    }

    private var entries: [Entry] = []

    public init() {}

    public var isEmpty: Bool { entries.isEmpty }

    public mutating func push(_ tab: TabSession.Tab, index: Int) {
        guard WebOrigin.isInAppPath(tab.path) else { return }
        entries.append(Entry(tab: tab, index: index))
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
    }

    public mutating func pop() -> Entry? { entries.popLast() }

    public mutating func removeAll() { entries.removeAll() }
}

public struct RepeatFilter: Sendable {
    private let window: Duration
    private var seen: [String: ContinuousClock.Instant] = [:]

    public init(window: Duration = .seconds(30)) {
        self.window = window
    }

    public mutating func admits(_ key: String, at now: ContinuousClock.Instant = .now) -> Bool {
        seen = seen.filter { now - $0.value < window }
        guard seen[key] == nil else { return false }
        seen[key] = now
        return true
    }
}
