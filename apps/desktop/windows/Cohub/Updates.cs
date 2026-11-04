using System.IO;
using Velopack;
using Velopack.Sources;

namespace Cohub;

internal sealed class Updates(string feed, Action ready, Action<string> log, Updates.Gate? gate = null)
{
    /// Linux only: a lock in the data directory, whether the installed app already moved past this process,
    /// and how to start it again without the updater. Windows passes none and keeps Velopack's own flow.
    public sealed record Gate(string LockPath, Func<bool> Superseded, Action Relaunch);

    private enum Step { Apply, Restart, Skip }

    private static readonly TimeSpan Interval = TimeSpan.FromHours(6);
    private readonly UpdateManager manager = new(new SimpleWebSource(feed));
    private UpdateInfo? downloaded;
    private FileStream? held;

    public bool Ready => downloaded is not null;

    public async Task RunAsync(CancellationToken stopping)
    {
        if (!manager.IsInstalled) return;
        while (!stopping.IsCancellationRequested && downloaded is null)
        {
            try
            {
                if (await manager.CheckForUpdatesAsync() is { } update)
                {
                    await manager.DownloadUpdatesAsync(update, cancelToken: stopping);
                    downloaded = update;
                    ready();
                    return;
                }
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                log($"Update check failed: {error.Message}");
            }
            try { await Task.Delay(Interval, stopping); } catch (OperationCanceledException) { return; }
        }
    }

    public void RestartNow()
    {
        if (downloaded is null) return;
        switch (Claim())
        {
            case Step.Apply:
                manager.ApplyUpdatesAndRestart(downloaded.TargetFullRelease);
                break;
            case Step.Restart:
                gate!.Relaunch();
                Environment.Exit(0);
                break;
        }
    }

    public void ApplyOnExit()
    {
        if (downloaded is not null && Claim() == Step.Apply) manager.WaitExitThenApplyUpdates(downloaded.TargetFullRelease, silent: true, restart: false);
    }

    // Held from this decision until the process exits, which is what the updater waits for before applying;
    // the updater never inherits it (close-on-exec), so it cannot block an apply.
    private Step Claim()
    {
        if (gate is null) return Step.Apply;
        try { held ??= new FileStream(gate.LockPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            log($"Not applying {downloaded!.TargetFullRelease.Version}; another process holds {gate.LockPath}, the next launch applies it ({error.Message})");
            return Step.Skip;
        }
        if (!gate.Superseded()) return Step.Apply;
        log($"Not applying {downloaded!.TargetFullRelease.Version}; the installed app was already replaced");
        return Step.Restart;
    }
}
