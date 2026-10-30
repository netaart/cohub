using System.Text.Json.Nodes;

namespace Cohub.Core;

public sealed class BridgeRouter(
    string platform,
    string hostId,
    IReadOnlyList<string> capabilities,
    IReadOnlyDictionary<string, BridgeRouter.Handler> handlers,
    HostService? service,
    BridgeRouter.Consent consent,
    Action<string> send)
{
    public delegate Task<JsonNode?> Handler(JsonNode? parameters);

    public delegate Task<bool> Consent(string root, string spaceId);

    private static readonly TimeSpan DescribeWait = TimeSpan.FromMilliseconds(1_500);

    public bool DescribedWithoutService { get; private set; }

    public async void Receive(string text)
    {
        if (BridgeRequest.Parse(text) is not { } request) return;
        var reply = await ReplyAsync(request);
        try { send(reply.ToJson(request.Id)); }
        catch (Exception error) when (error is ObjectDisposedException or InvalidOperationException)
        {
        }
    }

    public void Emit(string name, JsonNode? payload) => send(BridgeEvent.ToJson(name, payload));

    private async Task<BridgeReply> ReplyAsync(BridgeRequest request)
    {
        if (request.Method == HostProtocol.Methods.Describe) return BridgeReply.Success(await DescribeAsync());
        if (handlers.TryGetValue(request.Method, out var handler))
        {
            try { return BridgeReply.Success(await handler(request.Params)); }
            catch (BridgeException failure) { return BridgeReply.Fail(failure); }
            catch (Exception error) when (error is not OutOfMemoryException) { return BridgeReply.Fail(BridgeException.Failed(error.Message)); }
        }
        if (service is null || (await ServiceHelloAsync())?.Methods.Contains(request.Method) != true)
            return BridgeReply.Fail(BridgeException.Unsupported(request.Method));
        if (request.Method == HostProtocol.Methods.RuntimeStart && !await ConsentedAsync(request, service))
            return BridgeReply.Fail(BridgeException.Canceled("Not connected"));
        return await service.CallAsync(request);
    }

    private async Task<ServiceHello?> ServiceHelloAsync() =>
        service is null ? null : service.Hello ?? await service.ReadyAsync(DescribeWait);

    private async Task<JsonNode> DescribeAsync()
    {
        var hello = await ServiceHelloAsync();
        DescribedWithoutService = service is not null && hello is null;
        var advertised = capabilities.Concat(hello?.Capabilities ?? []).Distinct();
        return new JsonObject
        {
            ["version"] = HostProtocol.Version,
            ["platform"] = platform,
            ["hostId"] = hostId,
            ["capabilities"] = new JsonArray([.. advertised.Select(name => (JsonNode)name)]),
        };
    }

    private async Task<bool> ConsentedAsync(BridgeRequest request, HostService host)
    {
        if (request.Param("root") is not { } root || request.Param("spaceId") is not { } spaceId) return true;
        var listed = await host.CallAsync(new BridgeRequest("list", HostProtocol.Methods.RuntimeList));
        if (listed.Failure is null && RuntimeOverview.From(listed.Result) is { } runtime
            && runtime.Folders.Any(folder => folder.SpaceId == spaceId && string.Equals(folder.Root, root, RuntimeInstall.PathComparison)))
            return true;
        return await consent(root, spaceId);
    }
}
