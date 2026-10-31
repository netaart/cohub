using System.Net;
using System.Net.Http.Headers;
using System.Text.Json.Nodes;

namespace Cohub.Core;

public sealed class WorkspaceFiles(HostService service)
{
    // Never a proxy: requests carry the Runtime's token.
    private static readonly HttpClient Http = new(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(30) };

    private static readonly string[] ForwardedHeaders = ["Range", "If-None-Match", "If-Modified-Since", "If-Range"];
    public static readonly string[] PassedHeaders = ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control", "Content-Security-Policy", "X-Content-Type-Options"];

    public static (string SpaceId, string Path)? Target(Uri url, WebOrigin origin)
    {
        if (!origin.Contains(url) || !url.AbsolutePath.StartsWith(HostProtocol.WorkspacePath, StringComparison.Ordinal)) return null;
        if (url.AbsolutePath[HostProtocol.WorkspacePath.Length..].Split('/') is not [var spaceId, "files"] || !Guid.TryParse(spaceId, out _)) return null;
        var path = url.Query.TrimStart('?').Split('&')
            .Select(pair => pair.Split('=', 2))
            .Where(pair => pair is ["path", _])
            .Select(pair => Uri.UnescapeDataString(pair[1].Replace('+', ' ')))
            .FirstOrDefault();
        return path is null ? null : (spaceId, path);
    }

    public async Task<HttpResponseMessage?> SendAsync(string spaceId, string path, IEnumerable<KeyValuePair<string, string>> headers, CancellationToken cancellation)
    {
        // Asked per request, so the account, readiness and token are always current.
        var reply = await service.CallAsync(new BridgeRequest("workspace", HostProtocol.ServiceMethods.WorkspaceEndpoint, new JsonObject { ["spaceId"] = spaceId })).ConfigureAwait(false);
        if (JsonFields.Text(reply.Result, "url") is not { } text || JsonFields.Text(reply.Result, "token") is not { } token
            || !Uri.TryCreate(text, UriKind.Absolute, out var url) || !url.IsLoopback) return null;
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(url, $"/files?path={Uri.EscapeDataString(path)}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        foreach (var (name, value) in headers.Where(header => ForwardedHeaders.Contains(header.Key, StringComparer.OrdinalIgnoreCase))) request.Headers.TryAddWithoutValidation(name, value);
        try
        {
            var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation).ConfigureAwait(false);
            if (response.StatusCode != HttpStatusCode.Unauthorized) return response;
            response.Dispose();
            return null;
        }
        catch (HttpRequestException error) when (error.HttpRequestError == HttpRequestError.ConnectionError)
        {
            return null;
        }
    }
}
