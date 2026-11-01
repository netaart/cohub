using System.Collections;
using System.Reflection;
using Cohub.Core;

namespace Cohub;

internal sealed record ShellConfig(
    WebOrigin Origin,
    string Environment,
    string UrlScheme,
    bool IsDevelopment,
    Func<HostService.Launch>? Service,
    string DataDirectory,
    string CacheDirectory,
    string CommandLineTool)
{
    public string AppId => Environment == "dev" ? "live.cohub.desktop.dev" : "live.cohub.desktop";
    public string Title => Environment == "dev" ? "Cohub Dev" : "Cohub";
    public string FeedUrl => $"https://public.cohub.live/desktop/linux/{Environment}/{System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant()}";

    /// The AppImage path when packaged; the process itself when run from a build.
    public static string Executable => System.Environment.GetEnvironmentVariable("APPIMAGE") is { Length: > 0 } image ? image : System.Environment.ProcessPath ?? "cohub-desktop";

    public static ShellConfig Load()
    {
        var env = System.Environment.GetEnvironmentVariables().Cast<DictionaryEntry>().ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value ?? "", StringComparer.Ordinal);
        var built = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(attribute => attribute.Key == "CohubEnvironment")?.Value;
        var environment = env.GetValueOrDefault("COHUB_DESKTOP_ENV") ?? built ?? "prod";
        var origin = new WebOrigin(env.GetValueOrDefault("COHUB_DESKTOP_WEB_ORIGIN") ?? (environment == "dev" ? "https://dev.cohub.live" : "https://cohub.live"));

        var home = System.Environment.GetFolderPath(System.Environment.SpecialFolder.UserProfile);
        string Xdg(string name, string fallback) => env.GetValueOrDefault(name) is { Length: > 0 } value && Path.IsPathRooted(value) ? value : Path.Combine(home, fallback);
        var data = Path.Combine(Xdg("XDG_DATA_HOME", ".local/share"), "cohub", "desktop", environment);
        var cache = Path.Combine(Xdg("XDG_CACHE_HOME", ".cache"), "cohub", "desktop", environment);
        var tool = Path.Combine(data, "bin", "cohub");
        var childEnv = ShellState.ChildEnvironment(env, environment, StringComparer.Ordinal);
        HostService.Launch Serve(string node, string cli) => new(node, [cli, "host", "serve"], childEnv);

        Func<HostService.Launch>? service = null;
        var bundled = Path.Combine(AppContext.BaseDirectory, "runtime");
        if (env.GetValueOrDefault("COHUB_DESKTOP_NODE") is { } node && env.GetValueOrDefault("COHUB_DESKTOP_CLI") is { } cli)
        {
            service = () => Serve(node, cli);
        }
        else if (File.Exists(Path.Combine(bundled, RuntimeInstall.CliEntry)))
        {
            var root = Path.Combine(data, "runtime");
            var version = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0";
            service = () =>
            {
                var runtime = RuntimeInstall.Prepare(bundled, root, version);
                RuntimeInstall.WriteShim(tool, runtime);
                RuntimeInstall.Prune(root, runtime, RunningExecutables());
                return Serve(RuntimeInstall.Node(runtime), Path.Combine(runtime, RuntimeInstall.CliEntry));
            };
        }

        return new ShellConfig(
            origin,
            environment,
            environment == "dev" ? "cohub-dev" : "cohub",
            environment == "dev" || System.Diagnostics.Debugger.IsAttached,
            service,
            data,
            cache,
            tool);
    }

    private static List<string> RunningExecutables()
    {
        var paths = new List<string>();
        foreach (var entry in Directory.EnumerateDirectories("/proc"))
        {
            if (!int.TryParse(Path.GetFileName(entry), out _)) continue;
            try { if (new FileInfo(Path.Combine(entry, "exe")).LinkTarget is { } target) paths.Add(target); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return paths;
    }
}
