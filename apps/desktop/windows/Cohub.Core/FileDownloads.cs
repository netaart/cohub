using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace Cohub.Core;

public sealed class FileDownloads(string directory)
{
    private static readonly HttpClient Http = new();
    private static readonly TimeSpan ProgressInterval = TimeSpan.FromMilliseconds(250);

    private readonly ConcurrentDictionary<string, string> saved = new();

    public async Task<JsonNode> SaveAsync(JsonNode? parameters, Action<JsonNode> progress)
    {
        if (JsonFields.Text(parameters, "name") is not { } name) throw BridgeException.Failed("files.save requires a name");
        // Pages older than files.progress send no id.
        var id = JsonFields.Text(parameters, "id") ?? Guid.NewGuid().ToString("N");
        var url = JsonFields.Text(parameters, "url");
        var data = JsonFields.Text(parameters, "data");
        Directory.CreateDirectory(directory);
        var partial = Path.Combine(directory, $".cohub-{Guid.NewGuid():N}.part");
        try
        {
            if (url is not null && data is null) await DownloadAsync(id, url, partial, progress);
            else if (data is not null && url is null) await File.WriteAllBytesAsync(partial, Decode(data));
            else throw BridgeException.Failed("files.save requires exactly one of url or data");
            var destination = Unique(directory, name);
            File.Move(partial, destination);
            saved[id] = destination;
        }
        finally
        {
            try { File.Delete(partial); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return new JsonObject { ["location"] = "downloads", ["revealable"] = true };
    }

    public string? Saved(string? id) => id is not null && saved.TryGetValue(id, out var path) && File.Exists(path) ? path : null;

    public static string Unique(string directory, string? suggested)
    {
        var name = Path.GetFileName(suggested ?? "").Replace(':', '-');
        if (name.Length == 0 || name[0] == '.') name = $"download{name}";
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        var candidate = Path.Combine(directory, name);
        for (var index = 2; File.Exists(candidate) || Directory.Exists(candidate); index++) candidate = Path.Combine(directory, $"{stem} ({index}){extension}");
        return candidate;
    }

    private static async Task DownloadAsync(string id, string url, string partial, Action<JsonNode> progress)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) throw BridgeException.Failed("files.save only downloads https URLs");
        using var response = await Http.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead);
        if (!response.IsSuccessStatusCode) throw BridgeException.Failed($"Download failed: HTTP {(int)response.StatusCode}");
        var total = response.Content.Headers.ContentLength is > 0 ? response.Content.Headers.ContentLength : null;
        await using var source = await response.Content.ReadAsStreamAsync();
        await using var target = File.Create(partial);
        var buffer = new byte[81_920];
        long received = 0;
        var reportedAt = DateTime.MinValue;
        int read;
        while ((read = await source.ReadAsync(buffer)) > 0)
        {
            await target.WriteAsync(buffer.AsMemory(0, read));
            received += read;
            if (DateTime.UtcNow - reportedAt < ProgressInterval) continue;
            reportedAt = DateTime.UtcNow;
            progress(new JsonObject { ["id"] = id, ["received"] = received, ["total"] = total });
        }
    }

    private static byte[] Decode(string data)
    {
        try { return Convert.FromBase64String(data); }
        catch (FormatException) { throw BridgeException.Failed("files.save data is not base64"); }
    }
}
