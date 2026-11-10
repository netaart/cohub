using Cohub.Core;

namespace Cohub;

/// WebKitGTK downloads without asking; files land in the XDG download directory under a free name.
internal static class Downloads
{
    public static string Folder => GLib.Functions.GetUserSpecialDir(GLib.UserDirectory.DirectoryDownload)
        ?? Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile), "Downloads");

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
        Directory.CreateDirectory(Folder);
        return FileDownloads.Unique(Folder, suggested);
    }
}
