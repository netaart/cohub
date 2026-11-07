import Foundation

public enum AuthorizationRequest {
    static let scopes = "openid offline_access profile email"

    public static func url(config: AuthConfig, challenge: String, state: String, forceLogin: Bool) -> URL? {
        var components = URLComponents(url: config.oidc.appendingPathComponent("auth"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "client_id", value: config.appId),
            URLQueryItem(name: "redirect_uri", value: config.redirectURI.absoluteString),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: scopes),
            URLQueryItem(name: "prompt", value: forceLogin ? "login consent" : "consent"),
            URLQueryItem(name: "resource", value: config.apiResource),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        return components?.url
    }

    public static func code(from redirect: URL, state: String) -> String? {
        let items = URLComponents(url: redirect, resolvingAgainstBaseURL: false)?.queryItems ?? []
        guard items.first(where: { $0.name == "state" })?.value == state else { return nil }
        return items.first { $0.name == "code" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }
}
