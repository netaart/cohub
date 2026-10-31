using System.IO;
using System.IO.Pipes;
using Cohub.Core;
using Velopack;

namespace Cohub;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        var config = ShellConfig.Load();
        VelopackApp.Build()
            .OnAfterInstallFastCallback(_ => Registration.Register(config))
            .OnAfterUpdateFastCallback(_ => Registration.Register(config))
            .OnBeforeUninstallFastCallback(_ =>
            {
                Registration.Unregister(config);
                Toasts.Uninstall();
            })
            .Run();

        var argument = args is ["--folder", var folder] ? $"{ShellApp.FolderArgument}{WebOrigin.FolderFromShell(folder)}" : args.FirstOrDefault();
        using var instance = SingleInstance.Acquire(config.InstanceName);
        if (instance is null)
        {
            SingleInstance.Forward(config.InstanceName, argument ?? "");
            return 0;
        }
        return new ShellApp(config, instance, argument).Run();
    }
}

internal sealed class SingleInstance : IDisposable
{
    private readonly Mutex mutex;
    private readonly CancellationTokenSource stopping = new();

    private SingleInstance(Mutex mutex) => this.mutex = mutex;

    public static SingleInstance? Acquire(string name)
    {
        var mutex = new Mutex(initiallyOwned: true, $@"Local\{name}", out var created);
        if (created) return new SingleInstance(mutex);
        mutex.Dispose();
        return null;
    }

    public static void Forward(string name, string argument)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.CurrentUserOnly);
            client.Connect(3_000);
            using var writer = new StreamWriter(client);
            writer.WriteLine(argument);
        }
        catch (Exception error) when (error is IOException or TimeoutException or UnauthorizedAccessException)
        {
        }
    }

    public void Listen(string name, Action<string> received) => _ = Task.Run(async () =>
    {
        while (!stopping.IsCancellationRequested)
        {
            try
            {
                await using var server = new NamedPipeServerStream(name, PipeDirection.In, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await server.WaitForConnectionAsync(stopping.Token);
                using var reader = new StreamReader(server);
                received(await reader.ReadLineAsync(stopping.Token) ?? "");
            }
            catch (OperationCanceledException) { return; }
            catch (IOException) { await Task.Delay(500); }
        }
    });

    public void Dispose()
    {
        stopping.Cancel();
        stopping.Dispose();
        mutex.Dispose();
    }
}
