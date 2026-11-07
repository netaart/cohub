import Foundation

public struct AuthConfig: Sendable, Equatable {
    public let endpoint: URL
    public let appId: String
    public let redirectURI: URL
    public let apiResource: String

    public init(endpoint: URL, appId: String, redirectURI: URL, apiResource: String) {
        self.endpoint = endpoint
        self.appId = appId
        self.redirectURI = redirectURI
        self.apiResource = apiResource
    }

    var oidc: URL { endpoint.appendingPathComponent("oidc") }
}

public struct Credentials: Codable, Sendable, Equatable {
    public var refreshToken: String
    public var subject: String?
    public var accessToken: String?
    public var accessTokenExpiresAt: Date

    public init(refreshToken: String, subject: String?, accessToken: String?, accessTokenExpiresAt: Date) {
        self.refreshToken = refreshToken
        self.subject = subject
        self.accessToken = accessToken
        self.accessTokenExpiresAt = accessTokenExpiresAt
    }
}

public protocol CredentialStore: Sendable {
    func read() throws -> Credentials?
    func write(_ credentials: Credentials?) throws
}

public actor AuthSession {
    static let skew: TimeInterval = 30
    static let revokeTimeout: Duration = .seconds(5)

    private let store: any CredentialStore
    private let config: AuthConfig
    private let endpoint: any TokenEndpoint
    private let clock: @Sendable () -> Date
    private let onChange: @Sendable (_ signedIn: Bool) -> Void
    private let log: @Sendable (String) -> Void

    private var credentials: Credentials?
    private var loaded = false
    private var generation = 0
    private var refreshing: Task<String?, Never>?

    public init(
        store: any CredentialStore,
        config: AuthConfig,
        endpoint: (any TokenEndpoint)? = nil,
        clock: @escaping @Sendable () -> Date = Date.init,
        onChange: @escaping @Sendable (_ signedIn: Bool) -> Void = { _ in },
        log: @escaping @Sendable (String) -> Void = { _ in }
    ) {
        self.store = store
        self.config = config
        self.endpoint = endpoint ?? HTTPTokenEndpoint(oidc: config.oidc)
        self.clock = clock
        self.onChange = onChange
        self.log = log
    }

    public var signedIn: Bool {
        load()
        return credentials != nil
    }

    public var subject: String? {
        load()
        return credentials?.subject
    }

    public var version: Int {
        load()
        return generation
    }

    public func accessToken(forceRefresh: Bool = false) async -> String? {
        load()
        guard let current = credentials else { return nil }
        if !forceRefresh, let token = current.accessToken, current.accessTokenExpiresAt.timeIntervalSince(clock()) > Self.skew {
            return token
        }
        if let refreshing { return await refreshing.value }
        let task = Task { await refresh(current, generation: generation) }
        refreshing = task
        let token = await task.value
        if refreshing == task { refreshing = nil }
        return token
    }

    public func completeSignIn(code: String, verifier: String) async throws {
        let token = try await endpoint.exchange([
            "grant_type": "authorization_code",
            "code": code,
            "code_verifier": verifier,
            "redirect_uri": config.redirectURI.absoluteString,
            "client_id": config.appId,
            "resource": config.apiResource,
        ])
        guard let refreshToken = token.refreshToken else {
            throw OAuthFailure(status: 0, message: "Authorization response carried no refresh token; is offline_access granted?")
        }
        load()
        change(to: Credentials(refreshToken: refreshToken, subject: token.subject, accessToken: token.accessToken, accessTokenExpiresAt: expiry(token)), newSession: true)
    }

    public func signOut() async {
        load()
        guard let refreshToken = credentials?.refreshToken else { return change(to: nil, newSession: true) }
        change(to: nil, newSession: true)
        let fields = ["token": refreshToken, "token_type_hint": "refresh_token", "client_id": config.appId]
        let endpoint = endpoint
        await withTaskGroup(of: Void.self) { group in
            group.addTask { try? await endpoint.revoke(fields) }
            group.addTask { try? await Task.sleep(for: Self.revokeTimeout) }
            await group.next()
            group.cancelAll()
        }
    }

    private func refresh(_ stored: Credentials, generation started: Int) async -> String? {
        do {
            let token = try await endpoint.exchange([
                "grant_type": "refresh_token",
                "refresh_token": stored.refreshToken,
                "client_id": config.appId,
                "resource": config.apiResource,
            ])
            guard generation == started else { return nil }
            change(to: Credentials(
                refreshToken: token.refreshToken ?? stored.refreshToken,
                subject: token.subject ?? stored.subject,
                accessToken: token.accessToken,
                accessTokenExpiresAt: expiry(token)
            ), newSession: false)
            return token.accessToken
        } catch let failure as OAuthFailure where failure.status == 400 || failure.status == 401 {
            log("Refresh rejected (\(failure.status)); signing out")
            if generation == started { change(to: nil, newSession: true) }
            return nil
        } catch {
            log("Refresh failed: \(error)")
            return nil
        }
    }

    private func load() {
        guard !loaded else { return }
        do {
            credentials = try store.read()
            loaded = true
        } catch {
            log("Could not read credentials: \(error)")
        }
    }

    private func change(to next: Credentials?, newSession: Bool) {
        let wasSignedIn = credentials != nil
        do { try store.write(next) } catch { log("Could not persist credentials: \(error)") }
        credentials = next
        loaded = true
        if newSession {
            generation += 1
            refreshing = nil
        }
        if wasSignedIn != (next != nil) { onChange(next != nil) }
    }

    private func expiry(_ token: TokenResponse) -> Date {
        clock().addingTimeInterval(token.expiresIn)
    }
}
