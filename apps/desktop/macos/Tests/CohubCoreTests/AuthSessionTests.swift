import Foundation
import Testing
@testable import CohubCore

private final class MemoryStore: CredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Credentials?

    init(_ credentials: Credentials? = nil) { stored = credentials }

    func read() throws -> Credentials? { lock.withLock { stored } }
    func write(_ credentials: Credentials?) throws { lock.withLock { stored = credentials } }
    var current: Credentials? { lock.withLock { stored } }
}

private actor FakeEndpoint: TokenEndpoint {
    var exchanges: [[String: String]] = []
    var gate: CheckedContinuation<Void, Never>?
    var holds = false

    func hold() { holds = true }

    func release() {
        holds = false
        gate?.resume()
        gate = nil
    }

    func exchange(_ fields: [String: String]) async throws -> TokenResponse {
        exchanges.append(fields)
        if holds { await withCheckedContinuation { gate = $0 } }
        return TokenResponse(accessToken: "access-\(exchanges.count)", refreshToken: "refresh-\(exchanges.count)", subject: nil, expiresIn: 3_600)
    }

    func revoke(_ fields: [String: String]) async throws {}
}

private let config = AuthConfig(
    endpoint: URL(string: "https://auth.example")!,
    appId: "app",
    redirectURI: URL(string: "https://cohub.example/mobile/auth/callback")!,
    apiResource: "https://api.example"
)
private let now = Date(timeIntervalSince1970: 1_000_000)
private let expired = Credentials(refreshToken: "refresh-0", subject: "user", accessToken: "stale", accessTokenExpiresAt: now)

@Suite struct AuthSessionTests {
    @Test func concurrentCallersShareOneRefreshAndItsRotationIsPersisted() async throws {
        let endpoint = FakeEndpoint()
        await endpoint.hold()
        let store = MemoryStore(expired)
        let session = AuthSession(store: store, config: config, endpoint: endpoint, clock: { now })
        async let first = session.accessToken()
        async let second = session.accessToken()
        while await endpoint.exchanges.isEmpty { await Task.yield() }
        await endpoint.release()
        #expect(await [first, second] == ["access-1", "access-1"])
        #expect(await endpoint.exchanges.count == 1)
        #expect(await endpoint.exchanges.first?["refresh_token"] == "refresh-0")
        #expect(store.current?.refreshToken == "refresh-1")
        #expect(store.current?.subject == "user")
        #expect(await session.version == 0)
    }
}
