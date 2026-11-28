using System.Text.Json;
using System.Text.Json.Nodes;

namespace Cohub.Core;

public sealed record BridgeRequest(string Id, string Method, JsonNode? Params = null)
{
    public static BridgeRequest? Parse(string text)
    {
        if (text.Length > 32 * 1024 * 1024) return null;
        try
        {
            if (JsonNode.Parse(text) is not JsonObject message || message["type"]?.GetValueKind() != JsonValueKind.String || (string?)message["type"] != "request") return null;
            var id = message["id"]?.GetValueKind() == JsonValueKind.String ? (string?)message["id"] : null;
            var method = message["method"]?.GetValueKind() == JsonValueKind.String ? (string?)message["method"] : null;
            if (id is not { Length: >= 1 and <= 128 } || method is not { Length: >= 1 and <= 64 }) return null;
            return new BridgeRequest(id, method, message["params"]?.DeepClone());
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public string ToJson(string id)
    {
        var message = new JsonObject { ["type"] = "request", ["id"] = id, ["method"] = Method };
        if (Params is not null) message["params"] = Params.DeepClone();
        return message.ToJsonString();
    }

    public string? Param(string key) => Params is JsonObject fields && fields[key]?.GetValueKind() == JsonValueKind.String ? (string?)fields[key] : null;
}

public sealed record BridgeReply(JsonNode? Result, BridgeException? Failure = null)
{
    public static BridgeReply Success(JsonNode? result) => new(result);
    public static BridgeReply Fail(BridgeException failure) => new(null, failure);

    public string ToJson(string id)
    {
        var message = new JsonObject { ["type"] = "response", ["id"] = id };
        if (Failure is null)
        {
            message["result"] = Result?.DeepClone();
        }
        else
        {
            var text = string.IsNullOrEmpty(Failure.Message) ? "Host call failed" : Failure.Message[..Math.Min(Failure.Message.Length, 2_000)];
            message["error"] = new JsonObject { ["code"] = Failure.Code, ["message"] = text };
        }
        return message.ToJsonString();
    }
}

public static class BridgeEvent
{
    public static string ToJson(string name, JsonNode? payload)
    {
        var message = new JsonObject { ["type"] = "event", ["name"] = name };
        if (payload is not null) message["payload"] = payload.DeepClone();
        return message.ToJsonString();
    }
}

public sealed class BridgeException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;

    public static BridgeException Canceled(string message = "Canceled") => new(HostProtocol.ErrorCodes.Canceled, message);
    public static BridgeException Failed(string message) => new(HostProtocol.ErrorCodes.Failed, message);
    public static BridgeException Unsupported(string method) => new(HostProtocol.ErrorCodes.Unsupported, $"Unsupported method: {method}");
}
