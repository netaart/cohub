import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Streams files of a Space this Mac serves to the page from the Runtime's
/// loopback API, so media plays with ranges and never crosses the network.
/// WebKit cannot intercept https, so the page asks for
/// `cohub-workspace://<spaceId>/files?path=…`. The CLI hands out the endpoint;
/// the page never sees its token.
public final class WorkspaceFiles: Sendable {
    public static let scheme = "cohub-workspace"
    public static let forwardedHeaders = ["Range", "If-None-Match", "If-Modified-Since", "If-Range"]
    public static let passedHeaders = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Content-Security-Policy", "X-Content-Type-Options"]

    /// `+` and `&` stay escaped, so a path never reads as a space or a second field.
    private static let queryValue = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "+&=?#"))

    private let service: HostService

    public init(service: HostService) {
        self.service = service
    }

    public static func target(of url: URL) -> (spaceId: String, path: String)? {
        guard url.scheme?.lowercased() == scheme, let host = url.host, UUID(uuidString: host) != nil, url.path == "/files",
              let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedQuery
        else { return nil }
        for field in query.split(separator: "&") {
            let pair = field.split(separator: "=", maxSplits: 1).map(String.init)
            if pair.count == 2, pair[0] == "path", let path = pair[1].replacingOccurrences(of: "+", with: " ").removingPercentEncoding {
                return (host.lowercased(), path)
            }
        }
        return nil
    }

    /// The loopback request for a file, or nil when no Runtime here serves the Space.
    /// Asked per request, so the account, readiness and token are always current.
    public func request(spaceId: String, path: String, headers: [String: String]) async -> URLRequest? {
        let params: JSON = ["spaceId": .string(spaceId)]
        guard case .result(let result) = await service.call(BridgeRequest(id: "workspace", method: HostProtocol.ServiceMethod.workspaceEndpoint, params: params)),
              let text = result["url"]?.string, let endpoint = URL(string: text), endpoint.host == "127.0.0.1",
              let token = result["token"]?.string,
              let encoded = path.addingPercentEncoding(withAllowedCharacters: Self.queryValue),
              var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
        else { return nil }
        components.path = "/files"
        components.percentEncodedQuery = "path=\(encoded)"
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        for (name, value) in headers where Self.forwardedHeaders.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
            request.setValue(value, forHTTPHeaderField: name)
        }
        return request
    }
}
