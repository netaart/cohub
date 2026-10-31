namespace Cohub.Core;

public sealed class WebOrigin
{
    public enum Navigation { Allow, External, Deny }

    private readonly Uri url;

    public WebOrigin(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var parsed) || (parsed.Scheme != Uri.UriSchemeHttps && parsed.Scheme != Uri.UriSchemeHttp))
            throw new ArgumentException($"Not a web origin: {text}", nameof(text));
        url = parsed;
    }

    public string Origin => url.GetLeftPart(UriPartial.Authority).ToLowerInvariant();

    public bool Contains(Uri other) =>
        other.IsAbsoluteUri
        && string.Equals(other.Scheme, url.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(other.Host, url.Host, StringComparison.OrdinalIgnoreCase)
        && other.Port == url.Port;

    public string? PathOf(Uri other) => Contains(other) ? other.PathAndQuery + other.Fragment : null;

    public Uri? UrlFor(string path) => IsInAppPath(path) ? new Uri(Origin + path) : null;

    public static bool IsInAppPath(string? path) =>
        path is { Length: > 0 and <= 2_048 } && path[0] == '/' && !path.StartsWith("//", StringComparison.Ordinal) && !path.Contains('\\', StringComparison.Ordinal);

    public static string FolderFromShell(string argument) => argument.EndsWith('"') ? $"{argument[..^1]}\\" : argument;

    public static string? NewSpacePath(string folder)
    {
        var path = $"/spaces/new#folder={Uri.EscapeDataString(folder)}";
        return IsInAppPath(path) ? path : null;
    }

    public Navigation NavigationTo(Uri target)
    {
        if (Contains(target)) return Navigation.Allow;
        return target.Scheme.ToLowerInvariant() switch
        {
            "https" or "http" or "mailto" or "tel" => Navigation.External,
            _ => Navigation.Deny,
        };
    }

    public static string? PathFromDeepLink(string link, string scheme = "cohub")
    {
        if (!Uri.TryCreate(link, UriKind.Absolute, out var uri) || !string.Equals(uri.Scheme, scheme, StringComparison.OrdinalIgnoreCase) || !string.Equals(uri.Host, "open", StringComparison.OrdinalIgnoreCase)) return null;
        var path = uri.AbsolutePath.Length == 0 ? "/" : uri.AbsolutePath;
        path += uri.Query + uri.Fragment;
        return IsInAppPath(path) ? path : null;
    }
}
