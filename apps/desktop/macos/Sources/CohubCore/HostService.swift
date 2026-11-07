import Foundation

public struct ServiceHello: Sendable, Equatable, Codable {
    public let capabilities: [String]
    public let methods: [String]

    public init(capabilities: [String], methods: [String]) {
        self.capabilities = capabilities
        self.methods = methods
    }
}

public protocol BridgeService: AnyObject, Sendable {
    var hello: ServiceHello? { get }
    func ready(timeout: Duration) async -> ServiceHello?
    func call(_ request: BridgeRequest) async -> BridgeReply
}

#if os(macOS) || os(Linux) || os(Windows)
public final class HostService: BridgeService, @unchecked Sendable {
    public struct Launch: Sendable {
        public let executable: URL
        public let arguments: [String]
        public let environment: [String: String]

        public init(executable: URL, arguments: [String], environment: [String: String]) {
            self.executable = executable
            self.arguments = arguments
            self.environment = environment
        }
    }

    public typealias EventHandler = @Sendable (_ name: String, _ payload: JSON?) -> Void

    private let launch: @Sendable () throws -> Launch
    private let onEvent: EventHandler
    private let onHello: @Sendable (ServiceHello) -> Void
    private let log: @Sendable (String) -> Void
    private let lock = NSLock()

    private var process: Process?
    private var input: FileHandle?
    private var output = Data()
    private var live: ServiceHello?
    private var known: ServiceHello?
    private var pending: [String: CheckedContinuation<BridgeReply, Never>] = [:]
    private var waiters: [UUID: CheckedContinuation<ServiceHello?, Never>] = [:]
    private var sequence = 0
    private var restarts = 0
    private var stopped = false

    public init(
        launch: @escaping @Sendable () throws -> Launch,
        known: ServiceHello? = nil,
        onEvent: @escaping EventHandler,
        onHello: @escaping @Sendable (ServiceHello) -> Void = { _ in },
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.launch = launch
        self.known = known
        self.onEvent = onEvent
        self.onHello = onHello
        self.log = log
    }

    public convenience init(
        launch: Launch,
        known: ServiceHello? = nil,
        onEvent: @escaping EventHandler,
        onHello: @escaping @Sendable (ServiceHello) -> Void = { _ in },
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.init(launch: { launch }, known: known, onEvent: onEvent, onHello: onHello, log: log)
    }

    public func start() {
        lock.withLock { stopped = false }
        DispatchQueue.global(qos: .userInitiated).async { self.spawn() }
    }

    public func stop() {
        let handle: FileHandle? = lock.withLock {
            stopped = true
            return input
        }
        try? handle?.close()
    }

    public var hello: ServiceHello? { lock.withLock { live ?? known } }

    public func ready(timeout: Duration) async -> ServiceHello? {
        let id = UUID()
        return await withCheckedContinuation { continuation in
            let hello: ServiceHello? = lock.withLock {
                if let live { return live }
                waiters[id] = continuation
                return nil
            }
            if let hello { return continuation.resume(returning: hello) }
            Task { [weak self] in
                try? await Task.sleep(for: timeout)
                self?.resolveWaiter(id, with: nil)
            }
        }
    }

    public func call(_ request: BridgeRequest) async -> BridgeReply {
        guard await ready(timeout: .seconds(20)) != nil else {
            return .failure(.failed("The Cohub CLI is not running"))
        }
        return await withCheckedContinuation { continuation in
            let sent: (FileHandle?, String) = lock.withLock {
                sequence += 1
                let id = "s\(sequence)"
                pending[id] = continuation
                return (input, id)
            }
            let (handle, id) = sent
            do {
                guard let handle else { throw BridgeFailure.failed("The Cohub CLI is not running") }
                try handle.write(contentsOf: Data((request.text(id: id) + "\n").utf8))
            } catch {
                resolve(id, with: .failure(.failed("The Cohub CLI is not reachable")))
            }
        }
    }

    private func spawn() {
        let launch: Launch
        do { launch = try self.launch() } catch {
            log("Cohub CLI is not ready: \(error.localizedDescription)")
            return scheduleRestart()
        }
        let process = Process()
        process.executableURL = launch.executable
        process.arguments = launch.arguments
        process.environment = launch.environment
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil } else { self?.receive(chunk) }
        }
        let log = self.log
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            if let text = String(data: chunk, encoding: .utf8) { log(text.trimmingCharacters(in: .whitespacesAndNewlines)) }
        }
        process.terminationHandler = { [weak self] process in
            self?.exited(process)
        }

        do {
            try process.run()
            lock.withLock {
                self.process = process
                self.input = stdin.fileHandleForWriting
                self.output = Data()
            }
        } catch {
            log("Cohub CLI did not start: \(error.localizedDescription)")
            scheduleRestart()
        }
    }

    private func exited(_ process: Process) {
        let failed: [CheckedContinuation<BridgeReply, Never>] = lock.withLock {
            guard self.process === process else { return [] }
            self.process = nil
            input = nil
            live = nil
            defer { pending.removeAll() }
            return Array(pending.values)
        }
        for continuation in failed { continuation.resume(returning: .failure(.failed("The Cohub CLI stopped"))) }
        log("Cohub CLI exited (\(process.terminationStatus))")
        scheduleRestart()
    }

    private func scheduleRestart() {
        let delay: Double? = lock.withLock {
            if stopped { return nil }
            restarts += 1
            return min(30, pow(2, Double(min(restarts, 5)) - 1))
        }
        guard let delay else { return }
        DispatchQueue.global().asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, !self.lock.withLock({ self.stopped }) else { return }
            self.spawn()
        }
    }

    private func receive(_ chunk: Data) {
        let lines: [Data] = lock.withLock {
            output.append(chunk)
            var lines: [Data] = []
            while let end = output.firstIndex(of: 0x0A) {
                lines.append(output[output.startIndex..<end])
                output.removeSubrange(output.startIndex...end)
            }
            if output.count > 64 * 1024 * 1024 { output.removeAll() }
            return lines
        }
        for line in lines {
            guard let message = JSON.parse(line) else { continue }
            handle(message)
        }
    }

    private func handle(_ message: JSON) {
        switch message["type"]?.string {
        case "hello":
            guard let methods = message["methods"]?.array?.compactMap(\.string),
                  let capabilities = message["capabilities"]?.array?.compactMap(\.string)
            else { return }
            let hello = ServiceHello(capabilities: capabilities, methods: methods)
            let resumed: [CheckedContinuation<ServiceHello?, Never>] = lock.withLock {
                live = hello
                known = hello
                restarts = 0
                defer { waiters.removeAll() }
                return Array(waiters.values)
            }
            for waiter in resumed { waiter.resume(returning: hello) }
            onHello(hello)
        case "response":
            guard let id = message["id"]?.string else { return }
            if let error = message["error"] {
                resolve(id, with: .failure(BridgeFailure(error["code"]?.string ?? HostProtocol.ErrorCode.failed, error["message"]?.string ?? "Host call failed")))
            } else {
                resolve(id, with: .result(message["result"] ?? .null))
            }
        case "event":
            guard let name = message["name"]?.string else { return }
            onEvent(name, message["payload"])
        default:
            return
        }
    }

    private func resolve(_ id: String, with reply: BridgeReply) {
        lock.withLock { pending.removeValue(forKey: id) }?.resume(returning: reply)
    }

    private func resolveWaiter(_ id: UUID, with hello: ServiceHello?) {
        lock.withLock { waiters.removeValue(forKey: id) }?.resume(returning: hello)
    }
}
#endif
