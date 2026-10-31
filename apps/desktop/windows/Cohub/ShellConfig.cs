using System.Collections;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Cohub.Core;

namespace Cohub;

internal sealed record ShellConfig(
    WebOrigin Origin,
    string Environment,
    string UrlScheme,
    bool IsDevelopment,
    Func<HostService.Launch>? Service,
    string DataDirectory,
    string CommandLineTool)
{
    public string InstanceName => $"live.cohub.desktop.{Environment}";
    public string FeedUrl => $"https://public.cohub.live/desktop/windows/{Environment}/{System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant()}";

    public static ShellConfig Load()
    {
        var env = System.Environment.GetEnvironmentVariables().Cast<DictionaryEntry>().ToDictionary(entry => (string)entry.Key, entry => (string?)entry.Value ?? "", StringComparer.OrdinalIgnoreCase);
        var built = Assembly.GetExecutingAssembly().GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(attribute => attribute.Key == "CohubEnvironment")?.Value;
        var environment = env.GetValueOrDefault("COHUB_DESKTOP_ENV") ?? built ?? "prod";
        var origin = new WebOrigin(env.GetValueOrDefault("COHUB_DESKTOP_WEB_ORIGIN") ?? (environment == "dev" ? "https://dev.cohub.live" : "https://cohub.live"));

        var data = Path.Combine(System.Environment.GetFolderPath(System.Environment.SpecialFolder.LocalApplicationData), "Cohub", "Desktop", environment);
        var tool = Path.Combine(data, "bin");
        var childEnv = ChildEnvironment(env, environment);
        HostService.Launch Serve(string node, string cli, string? sandboxd = null)
        {
            var environment = new Dictionary<string, string>(childEnv, StringComparer.OrdinalIgnoreCase);
            if (sandboxd is not null && File.Exists(sandboxd)) environment["COHUB_SANDBOXD_BIN"] = sandboxd;
            return new(node, [cli, "host", "serve"], environment);
        }

        Func<HostService.Launch>? service = null;
        var bundled = Path.Combine(AppContext.BaseDirectory, "runtime");
        if (env.GetValueOrDefault("COHUB_DESKTOP_NODE") is { } node && env.GetValueOrDefault("COHUB_DESKTOP_CLI") is { } cli)
        {
            service = () => Serve(node, cli, env.GetValueOrDefault("COHUB_SANDBOXD_BIN"));
        }
        else if (File.Exists(Path.Combine(bundled, RuntimeInstall.CliEntry)))
        {
            var root = Path.Combine(data, "runtime");
            var version = Assembly.GetExecutingAssembly().GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? "0";
            service = () =>
            {
                var runtime = RuntimeInstall.Prepare(bundled, root, version);
                RuntimeInstall.WriteShim(Path.Combine(tool, "cohub.cmd"), runtime);
                RuntimeInstall.Prune(root, runtime, RunningNodes());
                return Serve(Path.Combine(runtime, "node.exe"), Path.Combine(runtime, RuntimeInstall.CliEntry), Path.Combine(runtime, RuntimeInstall.SandboxdEntry));
            };
        }

        return new ShellConfig(
            origin,
            environment,
            environment == "dev" ? "cohub-dev" : "cohub",
            environment == "dev" || Debugger.IsAttached,
            service,
            data,
            tool);
    }

    private static List<string> RunningNodes()
    {
        var paths = new List<string>();
        foreach (var process in Process.GetProcessesByName("node"))
        {
            try { if (process.MainModule?.FileName is { } path) paths.Add(path); }
            catch (Exception error) when (error is Win32Exception or InvalidOperationException) { }
            finally { process.Dispose(); }
        }
        return paths;
    }

    private static Dictionary<string, string> ChildEnvironment(Dictionary<string, string> env, string environment)
    {
        var child = env.Where(entry => !entry.Key.StartsWith("COHUB_", StringComparison.OrdinalIgnoreCase) && !entry.Key.Equals("ENV", StringComparison.OrdinalIgnoreCase))
            .ToDictionary(entry => entry.Key, entry => entry.Value, StringComparer.OrdinalIgnoreCase);
        child["COHUB_CLI_AUTO_UPDATE"] = "0";
        if (environment == "dev") child["ENV"] = "dev";
        return child;
    }
}

internal sealed class ShellState
{
    public sealed record Shortcut(string Id, string Label, string Path);

    public sealed record Placement(double Left, double Top, double Width, double Height, bool Maximized);

    public string HostId { get; set; } = Guid.NewGuid().ToString();
    public string? LastPath { get; set; }
    public string? EdgeColor { get; set; }
    public ServiceHello? ServiceHello { get; set; }
    public List<Shortcut> Shortcuts { get; set; } = [];
    public Placement? Window { get; set; }
    public bool GlobalShortcut { get; set; }

    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true, DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private string path = "";

    public static ShellState Load(string directory)
    {
        var path = Path.Combine(directory, "shell.json");
        ShellState? state = null;
        try { state = JsonSerializer.Deserialize<ShellState>(File.ReadAllText(path), Options); }
        catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) { }
        state ??= new ShellState();
        state.path = path;
        if (!WebOrigin.IsInAppPath(state.LastPath)) state.LastPath = null;
        return state;
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = $"{path}.{Guid.NewGuid():N}.tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Options));
        File.Move(temporary, path, overwrite: true);
    }

    public void PushShortcut(Shortcut shortcut)
    {
        Shortcuts = [shortcut, .. Shortcuts.Where(item => item.Id != shortcut.Id).Take(4)];
        Save();
    }
}
