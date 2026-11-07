import Foundation

public struct SharedInbox: Sendable {
    public struct Share: Codable, Equatable, Sendable {
        public struct File: Codable, Equatable, Sendable {
            public let name: String
            public let mimeType: String
            public let size: Int
            let stored: String?
        }

        public let id: String
        public let text: String?
        public let files: [File]

        public var json: JSON {
            [
                "id": .string(id),
                "text": text.map(JSON.string) ?? .null,
                "files": .array(files.map { ["name": .string($0.name), "mimeType": .string($0.mimeType), "size": .number(Double($0.size))] }),
            ]
        }
    }

    public final class Draft: @unchecked Sendable {
        private let lock = NSLock()
        private let directory: URL
        private let committed: URL
        private var files: [Share.File] = []
        private var texts: [String] = []

        init(directory: URL, committed: URL) {
            self.directory = directory
            self.committed = committed
        }

        public var isEmpty: Bool { lock.withLock { files.isEmpty && texts.isEmpty } }

        public func add(text: String) {
            lock.withLock {
                guard !text.isEmpty, !texts.contains(text) else { return }
                texts.append(text)
            }
        }

        public func add(fileAt source: URL, name: String, mimeType: String) throws {
            try lock.withLock {
                guard files.count < SharedInbox.maxFiles else { return }
                let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                var stored: String?
                if size <= HostProtocol.shareFileMaxBytes {
                    stored = String(files.count)
                    try FileManager.default.copyItem(at: source, to: directory.appendingPathComponent(stored!))
                }
                files.append(Share.File(name: SharedInbox.fileName(name), mimeType: mimeType, size: size, stored: stored))
            }
        }

        public func commit() throws {
            try lock.withLock {
                let text = texts.isEmpty ? nil : SharedInbox.prefix(texts.joined(separator: "\n"), utf16: SharedInbox.maxText)
                let share = Share(id: UUID().uuidString.lowercased(), text: text, files: files)
                try JSONEncoder().encode(share).write(to: directory.appendingPathComponent(SharedInbox.manifest))
                try FileManager.default.createDirectory(at: committed.deletingLastPathComponent(), withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: directory, to: committed)
            }
        }
    }

    static let maxFiles = 16
    static let maxText = 100_000
    static let manifest = "share.json"
    static let staleDraft: TimeInterval = 10 * 60

    private let root: URL
    private let clock: @Sendable () -> Date

    public init(root: URL, clock: @escaping @Sendable () -> Date = Date.init) {
        self.root = root
        self.clock = clock
    }

    private var drafts: URL { root.appendingPathComponent("drafts", isDirectory: true) }
    private var pending: URL { root.appendingPathComponent("pending", isDirectory: true) }
    private var taken: URL { root.appendingPathComponent("taken", isDirectory: true) }

    public func draft() throws -> Draft {
        let millis = String(Int64(clock().timeIntervalSince1970 * 1_000))
        let name = String(repeating: "0", count: max(0, 13 - millis.count)) + millis + "-" + UUID().uuidString
        let directory = drafts.appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return Draft(directory: directory, committed: pending.appendingPathComponent(name, isDirectory: true))
    }

    public func take() -> Share? {
        let manager = FileManager.default
        let waiting = ((try? manager.contentsOfDirectory(atPath: pending.path)) ?? []).sorted()
        defer {
            for name in waiting.dropLast() { try? manager.removeItem(at: pending.appendingPathComponent(name)) }
            pruneDrafts()
        }
        guard let newest = waiting.last,
              let data = manager.contents(atPath: pending.appendingPathComponent(newest).appendingPathComponent(Self.manifest).path),
              let share = try? JSONDecoder().decode(Share.self, from: data)
        else { return nil }
        try? manager.removeItem(at: taken)
        try? manager.createDirectory(at: taken, withIntermediateDirectories: true)
        guard (try? manager.moveItem(at: pending.appendingPathComponent(newest), to: taken.appendingPathComponent(share.id))) != nil else { return nil }
        return share
    }

    public func read(id: String, index: Int) throws -> Data {
        let directory = taken.appendingPathComponent(Self.fileName(id))
        guard let data = FileManager.default.contents(atPath: directory.appendingPathComponent(Self.manifest).path),
              let share = try? JSONDecoder().decode(Share.self, from: data), share.id == id
        else { throw BridgeFailure.failed("That share is gone") }
        guard share.files.indices.contains(index) else { throw BridgeFailure.failed("No shared file at \(index)") }
        guard let stored = share.files[index].stored else { throw BridgeFailure.failed("This file is too large to share") }
        return try Data(contentsOf: directory.appendingPathComponent(stored))
    }

    private func pruneDrafts() {
        let manager = FileManager.default
        let cutoff = clock().addingTimeInterval(-Self.staleDraft).timeIntervalSince1970 * 1_000
        for name in (try? manager.contentsOfDirectory(atPath: drafts.path)) ?? [] {
            guard let started = Double(name.prefix { $0 != "-" }), started < cutoff else { continue }
            try? manager.removeItem(at: drafts.appendingPathComponent(name))
        }
    }

    static func fileName(_ name: String) -> String {
        let cleaned = String(name.split(whereSeparator: { $0 == "/" || $0 == ":" || $0 == "\\" }).last ?? "").trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned.hasPrefix(".") ? "shared" : prefix(cleaned, utf16: 255)
    }

    static func prefix(_ text: String, utf16 limit: Int) -> String {
        var count = 0
        return String(text.prefix { character in
            count += character.utf16.count
            return count <= limit
        })
    }
}
