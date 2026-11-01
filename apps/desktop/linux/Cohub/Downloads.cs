namespace Cohub;

/// WebKitGTK downloads without asking; files land in the XDG download directory under a free name.
internal static class Downloads
{
    public delegate void Notify(string id, string title, string? body, string action, string target);

    public static void Track(WebKit.Download download, Notify notify)
    {
        download.OnDecideDestination += (_, args) =>
        {
            download.SetDestination(Unique(args.SuggestedFilename));
            return true;
        };
        download.OnFinished += (_, _) =>
        {
            if (download.GetDestination() is not { } destination) return;
            var path = destination.StartsWith("file://", StringComparison.Ordinal) ? new Uri(destination).LocalPath : destination;
            if (!File.Exists(path)) return;
            notify($"download-{path}", Path.GetFileName(path), Strings.L("Saved to Downloads"), "app.show-folder", Path.GetDirectoryName(path)!);
        };
    }

    private static string Unique(string? suggested)
    {
        var directory = GLib.Functions.GetUserSpecialDir(GLib.UserDirectory.DirectoryDownload)
            ?? Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile), "Downloads");
        Directory.CreateDirectory(directory);
        var name = Path.GetFileName(suggested ?? "").Replace(':', '-');
        if (name.Length == 0 || name[0] == '.') name = $"download{name}";
        var stem = Path.GetFileNameWithoutExtension(name);
        var extension = Path.GetExtension(name);
        var candidate = Path.Combine(directory, name);
        for (var index = 2; File.Exists(candidate) || Directory.Exists(candidate); index++) candidate = Path.Combine(directory, $"{stem} ({index}){extension}");
        return candidate;
    }
}
