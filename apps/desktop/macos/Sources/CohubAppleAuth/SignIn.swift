import AuthenticationServices
import CohubCore
import CryptoKit
import Foundation
import os

private let signInDiagnostics = Logger(subsystem: "live.cohub.ios", category: "Acceptance")

@MainActor
@available(macOS 14.4, *)
public final class SignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    public struct Grant {
        public let code: String
        public let verifier: String
    }

    struct Failure: Error {
        let reason: String
    }

    private let anchor: ASPresentationAnchor
    private var session: ASWebAuthenticationSession?
    private var continuation: CheckedContinuation<URL?, Error>?

    public init(anchor: ASPresentationAnchor) {
        self.anchor = anchor
        signInDiagnostics.notice("[DEBUG-native-login] created")
    }

    deinit { signInDiagnostics.notice("[DEBUG-native-login] released") }

    public func run(_ config: AuthConfig, forceLogin: Bool) async throws -> Grant? {
        signInDiagnostics.notice("[DEBUG-native-login] run")
        let verifier = Self.random(bytes: 32), state = Self.random(bytes: 16)
        let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
        guard let url = AuthorizationRequest.url(config: config, challenge: challenge, state: state, forceLogin: forceLogin),
              let host = config.redirectURI.host()
        else { throw Failure(reason: "Malformed sign-in configuration") }

        let redirect: URL? = try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            let session = ASWebAuthenticationSession(url: url, callback: .https(host: host, path: config.redirectURI.path())) { [weak self] url, error in
                Task { @MainActor in self?.finish(url, error) }
            }
            session.presentationContextProvider = self
            self.session = session
            let started = session.start()
            signInDiagnostics.notice("[DEBUG-native-login] started=\(started)")
            if !started { finish(nil, Failure(reason: "The sign-in session did not start")) }
        }
        guard let redirect else { return nil }
        guard let code = AuthorizationRequest.code(from: redirect, state: state) else { throw Failure(reason: "The sign-in response did not answer this request") }
        return Grant(code: code, verifier: verifier)
    }

    private func finish(_ url: URL?, _ error: Error?) {
        let diagnostic = error as NSError?
        signInDiagnostics.notice("[DEBUG-native-login] finish domain=\(diagnostic?.domain ?? "none", privacy: .public) code=\(diagnostic?.code ?? 0)")
        guard let continuation else { return }
        self.continuation = nil
        session = nil
        if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
            continuation.resume(returning: nil)
        } else if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume(returning: url)
        }
    }

    nonisolated public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { anchor }
    }

    private static func random(bytes count: Int) -> String {
        var generator = SystemRandomNumberGenerator()
        return base64URL(Data((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &generator) }))
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}
