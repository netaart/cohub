using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Cohub.Core;
using Xunit;

namespace Cohub.Core.Tests;

public sealed class BridgeEnvelopeTests
{
    private static readonly JsonNode Fixture = JsonNode.Parse(File.ReadAllText(Path.Combine(Root(), "packages/protocol/fixtures/host-bridge.json")))!;

    private static string Root([CallerFilePath] string file = "") => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(file)!, "../../../.."));

    private static TheoryData<string> Names(string key) => [.. Fixture[key]!.AsArray().Select(item => (string)item!["name"]!)];

    private static JsonNode Case(string key, string name) => Fixture[key]!.AsArray().Single(item => (string?)item!["name"] == name)!;

    public static TheoryData<string> Requests => Names("requests");
    public static TheoryData<string> Replies => Names("replies");
    public static TheoryData<string> Events => Names("events");

    [Theory]
    [MemberData(nameof(Requests))]
    public void Parses_requests(string name)
    {
        var item = Case("requests", name);
        var parsed = BridgeRequest.Parse((string)item["text"]!);
        if (item["request"] is not JsonObject expected)
        {
            Assert.Null(parsed);
            return;
        }
        Assert.NotNull(parsed);
        Assert.Equal((string?)expected["id"], parsed.Id);
        Assert.Equal((string?)expected["method"], parsed.Method);
        Assert.True(JsonNode.DeepEquals(expected["params"], parsed.Params));
    }

    [Theory]
    [MemberData(nameof(Replies))]
    public void Serialises_replies(string name)
    {
        var item = Case("replies", name);
        var reply = item["error"] is JsonObject error
            ? BridgeReply.Fail(new BridgeException((string)error["code"]!, (string)error["message"]!))
            : BridgeReply.Success(item["result"]?.DeepClone());
        Assert.True(JsonNode.DeepEquals(item["json"], JsonNode.Parse(reply.ToJson((string)item["id"]!))));
    }

    [Theory]
    [MemberData(nameof(Events))]
    public void Serialises_events(string name)
    {
        var item = Case("events", name);
        Assert.True(JsonNode.DeepEquals(item["json"], JsonNode.Parse(BridgeEvent.ToJson((string)item["event"]!, item["payload"]?.DeepClone()))));
    }
}
