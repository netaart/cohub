using System.Globalization;
using System.Reflection;
using System.Text.Json.Nodes;

namespace Cohub.Core;

public sealed record CliAbout(string Version, string? Commit, string Node, string? Path, string? PathVersion, IReadOnlyList<CliAbout.Runtime> Runtimes)
{
    public sealed record Runtime(string Root, string? Version);

    public static CliAbout? From(JsonNode? json)
    {
        if (JsonFields.Text(json, "version") is not { } version || JsonFields.Text(json, "node") is not { } node) return null;
        var path = json!["path"];
        var runtimes = json["runtimes"] is JsonArray items
            ? items.Where(item => JsonFields.Text(item, "root") is not null).Select(item => new Runtime(JsonFields.Text(item, "root")!, JsonFields.Text(item, "version"))).ToList()
            : [];
        return new CliAbout(version, JsonFields.Text(json, "commit"), node, JsonFields.Text(path, "path"), JsonFields.Text(path, "version"), runtimes);
    }

    public const string Repository = "https://github.com/netaart/cohub";

    public static async Task<CliAbout?> FetchAsync(HostService? service)
    {
        if (service is null) return null;
        try
        {
            return From((await service.CallAsync(new BridgeRequest("about", HostProtocol.ServiceMethods.CliAbout)).WaitAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false)).Result);
        }
        catch (TimeoutException)
        {
            return null;
        }
    }

    public IEnumerable<(string Text, bool Attention)> Describe(Func<string, string> localize)
    {
        string Format(string key, params object[] values) => string.Format(CultureInfo.CurrentCulture, localize(key), values);
        yield return (Format("Command line {0} · Node {1}", Commit is null ? Version : $"{Version} ({Commit})", Node), false);
        if (Path is null) yield return (localize("No cohub in the terminal. Choose Install Command Line Tool to add it."), true);
        else
        {
            yield return (Format("Terminal: {0} at {1}", PathVersion ?? localize("unknown version"), Path), false);
            if (PathIsBehind) yield return (localize("Older than this app. Choose Install Command Line Tool to use this one."), true);
        }
        foreach (var runtime in Runtimes)
        {
            yield return IsBehind(runtime)
                ? (Format("{0}: {1} · reconnect to update", runtime.Root, runtime.Version ?? localize("older version")), true)
                : (Format("{0}: {1}", runtime.Root, runtime.Version!), false);
        }
    }

    public bool PathIsBehind => PathVersion is { } path && IsOlder(path, Version);

    public bool IsBehind(Runtime runtime) => runtime.Version is not { } version || IsOlder(version, Version);

    private static bool IsOlder(string version, string than)
    {
        static int[] Parts(string value) => [.. value.Split('-')[0].Split('.').Select(part => int.TryParse(part, out var number) ? number : 0)];
        var (a, b) = (Parts(version), Parts(than));
        for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            var (x, y) = (i < a.Length ? a[i] : 0, i < b.Length ? b[i] : 0);
            if (x != y) return x < y;
        }
        return false;
    }

    public static (string Version, string? Commit) AppVersion(Assembly assembly)
    {
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0.0.0";
        var parts = informational.Split('+', 2);
        return (parts[0], parts.Length > 1 && parts[1].Length >= 7 ? parts[1][..7] : null);
    }
}
