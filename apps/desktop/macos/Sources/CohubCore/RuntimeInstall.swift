import Foundation

/// Runtimes outlive the app, so they run from a per-version copy outside it that updates never touch.
public enum RuntimeInstall {
    public static func prepare(bundled: URL, root: URL, version: String, finish: (URL) throws -> Void = { _ in }) throws -> URL {
        let manager = FileManager.default
        let target = root.appendingPathComponent(directoryName(version), isDirectory: true)
        if manager.fileExists(atPath: target.path) { return target }
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        let staging = root.appendingPathComponent(".\(UUID().uuidString)", isDirectory: true)
        try manager.copyItem(at: bundled, to: staging)
        try finish(staging)
        do {
            try manager.moveItem(at: staging, to: target)
        } catch where manager.fileExists(atPath: target.path) {
            try? manager.removeItem(at: staging)
        }
        return target
    }

    public static func prune(root: URL, keep: URL, running: [String]) {
        let manager = FileManager.default
        guard let entries = try? manager.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) else { return }
        for entry in entries where entry.standardizedFileURL != keep.standardizedFileURL {
            let prefix = entry.standardizedFileURL.path + "/"
            if running.contains(where: { $0.hasPrefix(prefix) }) { continue }
            try? manager.removeItem(at: entry)
        }
    }

    public static func writeShim(_ shim: URL, runtime: URL) throws {
        let quote = { (path: String) in "'\(path.replacingOccurrences(of: "'", with: "'\\''"))'" }
        let cli = runtime.appendingPathComponent(cliEntry).path
        let script = """
        #!/bin/sh
        # Written by Cohub on launch: the CLI it ships, updated with the app.
        COHUB_CLI_AUTO_UPDATE=0 COHUB_SANDBOXD_BIN=${COHUB_SANDBOXD_BIN:-\(quote(runtime.appendingPathComponent(sandboxdEntry).path))} exec \(quote(runtime.appendingPathComponent("node").path)) \(quote(cli)) "$@"

        """
        try FileManager.default.createDirectory(at: shim.deletingLastPathComponent(), withIntermediateDirectories: true)
        let temporary = shim.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString)")
        try Data(script.utf8).write(to: temporary)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: temporary.path)
        guard rename(temporary.path, shim.path) == 0 else {
            try? FileManager.default.removeItem(at: temporary)
            throw CocoaError(.fileWriteUnknown)
        }
    }

    public static let cliEntry = "cli/node_modules/@neta-art/cohub-cli/bin/cohub.js"
    public static let sandboxdEntry = "sandboxd/cohub-sandboxd"

    static func directoryName(_ version: String) -> String {
        let name = String(version.map { $0.isLetter || $0.isNumber || "._-".contains($0) ? $0 : "-" })
        return name.isEmpty || name.hasPrefix(".") ? "v\(name)" : name
    }
}
