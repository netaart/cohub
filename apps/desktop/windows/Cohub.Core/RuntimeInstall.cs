namespace Cohub.Core;

// Runtimes outlive the app, so they run from a per-version copy outside it that updates never touch.
public static class RuntimeInstall
{
    public static readonly string CliEntry = Path.Combine("cli", "node_modules", "@neta-art", "cohub-cli", "bin", "cohub.js");

    public static StringComparison PathComparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public static string Node(string runtime) => Path.Combine(runtime, OperatingSystem.IsWindows() ? "node.exe" : "node");

    public static string Prepare(string bundled, string root, string version)
    {
        var target = Path.Combine(root, DirectoryName(version));
        if (Directory.Exists(target)) return target;
        Directory.CreateDirectory(root);
        var staging = Path.Combine(root, $".{Guid.NewGuid():N}");
        Copy(new DirectoryInfo(bundled), Directory.CreateDirectory(staging));
        try
        {
            Directory.Move(staging, target);
        }
        catch (IOException) when (Directory.Exists(target))
        {
            Directory.Delete(staging, recursive: true);
        }
        return target;
    }

    public static void Prune(string root, string keep, IEnumerable<string> running)
    {
        if (!Directory.Exists(root)) return;
        var executables = running.ToList();
        foreach (var entry in Directory.EnumerateDirectories(root))
        {
            if (string.Equals(Path.GetFullPath(entry), Path.GetFullPath(keep), PathComparison)) continue;
            var prefix = Path.GetFullPath(entry) + Path.DirectorySeparatorChar;
            if (executables.Any(path => path.StartsWith(prefix, PathComparison))) continue;
            var trash = Path.Combine(root, $".{Guid.NewGuid():N}");
            try
            {
                Directory.Move(entry, trash);
                Directory.Delete(trash, recursive: true);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
    }

    public static void WriteShim(string shim, string runtime)
    {
        var cli = Path.Combine(runtime, CliEntry);
        var script = OperatingSystem.IsWindows()
            ? string.Join("\r\n",
                "@echo off",
                "rem Written by Cohub on launch: the CLI it ships, updated with the app.",
                "setlocal",
                "set COHUB_CLI_AUTO_UPDATE=0",
                $"\"{Node(runtime)}\" \"{cli}\" %*",
                "")
            : string.Join("\n",
                "#!/bin/sh",
                "# Written by Cohub on launch: the CLI it ships, updated with the app.",
                $"COHUB_CLI_AUTO_UPDATE=0 exec {ShellQuote(Node(runtime))} {ShellQuote(cli)} \"$@\"",
                "");
        Directory.CreateDirectory(Path.GetDirectoryName(shim)!);
        var temporary = $"{shim}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, script);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(temporary, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        File.Move(temporary, shim, overwrite: true);
    }

    private static string ShellQuote(string text) => $"'{text.Replace("'", "'\\''", StringComparison.Ordinal)}'";

    internal static string DirectoryName(string version)
    {
        var name = new string([.. version.Select(c => char.IsAsciiLetterOrDigit(c) || "._-".Contains(c, StringComparison.Ordinal) ? c : '-')]);
        return name.Length == 0 || name[0] == '.' ? $"v{name}" : name;
    }

    private static void Copy(DirectoryInfo source, DirectoryInfo target)
    {
        foreach (var file in source.EnumerateFiles()) file.CopyTo(Path.Combine(target.FullName, file.Name));
        foreach (var directory in source.EnumerateDirectories()) Copy(directory, target.CreateSubdirectory(directory.Name));
    }
}
