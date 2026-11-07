import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct TokenResponse: Sendable, Equatable {
    public let accessToken: String
    public let refreshToken: String?
    public let subject: String?
    public let expiresIn: TimeInterval

    public init(accessToken: String, refreshToken: String?, subject: String?, expiresIn: TimeInterval) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.subject = subject
        self.expiresIn = expiresIn
    }

    init(json: JSON, status: Int) throws {
        guard let accessToken = json["access_token"]?.string else { throw OAuthFailure(status: status, message: "Token response had no access_token") }
        self.init(
            accessToken: accessToken,
            refreshToken: json["refresh_token"]?.string,
            subject: json["id_token"]?.string.flatMap(Self.subject(ofIdToken:)),
            expiresIn: json["expires_in"]?.number ?? 3_600
        )
    }

    static func subject(ofIdToken token: String) -> String? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = parts[1].replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        payload += String(repeating: "=", count: (4 - payload.count % 4) % 4)
        return Data(base64Encoded: payload).flatMap(JSON.parse)?["sub"]?.string
    }
}

public struct OAuthFailure: Error, Sendable, Equatable {
    public let status: Int
    public let message: String

    public init(status: Int, message: String) {
        self.status = status
        self.message = message
    }
}

public protocol TokenEndpoint: Sendable {
    func exchange(_ fields: [String: String]) async throws -> TokenResponse
    func revoke(_ fields: [String: String]) async throws
}

public struct HTTPTokenEndpoint: TokenEndpoint {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 20
        return URLSession(configuration: configuration)
    }()

    private static let formValue = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))

    let oidc: URL

    public init(oidc: URL) {
        self.oidc = oidc
    }

    public func exchange(_ fields: [String: String]) async throws -> TokenResponse {
        let (status, body) = try await post("token", fields)
        guard let json = JSON.parse(body) else { throw OAuthFailure(status: status, message: "Malformed token response") }
        return try TokenResponse(json: json, status: status)
    }

    public func revoke(_ fields: [String: String]) async throws {
        _ = try await post("token/revocation", fields)
    }

    static func form(_ fields: [String: String]) -> Data {
        let encode = { (text: String) in text.addingPercentEncoding(withAllowedCharacters: formValue) ?? "" }
        return Data(fields.sorted { $0.key < $1.key }.map { "\(encode($0.key))=\(encode($0.value))" }.joined(separator: "&").utf8)
    }

    private func post(_ path: String, _ fields: [String: String]) async throws -> (Int, Data) {
        var request = URLRequest(url: oidc.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = Self.form(fields)
        let data: Data, response: URLResponse
        do { (data, response) = try await Self.session.data(for: request) }
        catch { throw OAuthFailure(status: 0, message: error.localizedDescription) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw OAuthFailure(status: status, message: String(decoding: data.prefix(2_000), as: UTF8.self)) }
        return (status, data)
    }
}
