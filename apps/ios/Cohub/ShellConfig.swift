import CohubCore
import Foundation

struct ShellConfig: Sendable {
    static let redirectPath = "/mobile/auth/callback"
    static let repository = URL(string: "https://github.com/netaart/cohub")!

    let environment: String
    let origin: WebOrigin
    let api: WebOrigin
    let auth: AuthConfig
    let urlScheme: String
    let appGroup: String
    let version: String
    let commit: String

    var isDevelopment: Bool { environment == "dev" }

    static func load(bundle: Bundle = .main) -> ShellConfig {
        func value(_ key: String) -> String {
            guard let text = bundle.object(forInfoDictionaryKey: key) as? String, !text.isEmpty else { preconditionFailure("Info.plist lacks \(key)") }
            return text
        }
        func url(_ key: String) -> URL {
            guard let url = URL(string: value(key)) else { preconditionFailure("Info.plist has a malformed \(key)") }
            return url
        }
        guard let origin = WebOrigin(value("CohubWebOrigin")), let api = WebOrigin(value("CohubApiOrigin")),
              let redirect = URL(string: origin.origin + redirectPath)
        else { preconditionFailure("Info.plist has a malformed origin") }
        return ShellConfig(
            environment: value("CohubEnvironment"),
            origin: origin,
            api: api,
            auth: AuthConfig(endpoint: url("CohubLogtoEndpoint"), appId: value("CohubLogtoAppId"), redirectURI: redirect, apiResource: value("CohubLogtoApiResource")),
            urlScheme: value("CohubURLScheme"),
            appGroup: value("CohubAppGroup"),
            version: "\(value("CFBundleShortVersionString")) (\(value("CFBundleVersion")))",
            commit: bundle.object(forInfoDictionaryKey: "CohubCommit") as? String ?? ""
        )
    }
}
