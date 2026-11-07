import CohubCore
import os
import UIKit

let logger = Logger(subsystem: "live.cohub.ios", category: "Shell")

func L(_ key: String.LocalizationValue) -> String {
    String(localized: key)
}

@MainActor
final class Shell {
    static let shared = Shell()

    let config: ShellConfig
    let auth: AuthSession
    let inbox: SharedInbox?

    weak var surface: ShellViewController?
    private var pendingPath: String?
    private var signingIn = false

    private init() {
        let config = ShellConfig.load()
        let store = KeychainStore(service: Bundle.main.bundleIdentifier ?? "live.cohub.ios")
        if ShellState.claimFirstLaunch() { try? store.write(nil) }
        self.config = config
        auth = AuthSession(
            store: store,
            config: config.auth,
            onChange: { signedIn in Task { @MainActor in Shell.shared.sessionChanged(signedIn: signedIn) } },
            log: { message in logger.info("\(message, privacy: .public)") }
        )
        inbox = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: config.appGroup)
            .map { SharedInbox(root: $0.appendingPathComponent("Inbox", isDirectory: true)) }
    }

    func launch() {
        Task { [auth] in _ = await auth.signedIn }
        Task.detached(priority: .utility) { FileSaver.removeLeftovers() }
    }

    func open(_ path: String) {
        guard WebOrigin.isInAppPath(path) else { return }
        if let surface { surface.load(path) } else { pendingPath = path }
    }

    func takeStartPath() -> String {
        defer { pendingPath = nil }
        return pendingPath ?? ShellState.lastPage ?? "/"
    }

    func signIn(redirectPath: String?) {
        guard !signingIn, let window = surface?.view.window else { return }
        signingIn = true
        let destination = redirectPath.flatMap { WebOrigin.isInAppPath($0) ? $0 : nil } ?? "/"
        Task {
            defer { signingIn = false }
            do {
                guard let grant = try await SignIn(anchor: window).run(config.auth, forceLogin: ShellState.forceLogin) else { return }
                try await auth.completeSignIn(code: grant.code, verifier: grant.verifier)
                ShellState.forceLogin = false
                open(destination)
            } catch {
                logger.error("Sign-in failed: \(error.localizedDescription, privacy: .public)")
                Toast.show(L("Couldn't complete sign-in. Please try again."), in: surface?.view)
            }
        }
    }

    func signOut() async {
        ShellState.forceLogin = true
        await auth.signOut()
    }

    private func sessionChanged(signedIn: Bool) {
        if !signedIn {
            ShellState.lastPage = nil
            ShellState.shortcuts = []
        }
        QuickActions.refresh(signedIn: signedIn)
    }
}
