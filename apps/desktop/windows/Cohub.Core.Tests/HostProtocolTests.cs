using System.Runtime.CompilerServices;
using System.Text.Json.Nodes;
using Cohub.Core;
using Xunit;

namespace Cohub.Core.Tests;

public sealed class HostProtocolTests
{
    private static readonly JsonNode Manifest = JsonNode.Parse(File.ReadAllText(Path.Combine(Root(), "packages/protocol/host-bridge.json")))!;

    private static string Root([CallerFilePath] string file = "") => Path.GetFullPath(Path.Combine(Path.GetDirectoryName(file)!, "../../../.."));

    private static HashSet<string> Names(string key) => [.. Manifest[key]!.AsArray().Select(node => (string)node!)];

    [Fact]
    public void Constants_match_the_protocol_package()
    {
        Assert.Equal(HostProtocol.Global, (string?)Manifest["global"]);
        Assert.Equal(HostProtocol.Version, (int)Manifest["version"]!);
        Assert.Equal(HostProtocol.ServiceVersion, (int)Manifest["service"]!["version"]!);
        Assert.Equal([HostProtocol.ShellEvents.Open], Manifest["service"]!["shellEvents"]!.AsArray().Select(node => (string)node!));
        Assert.Equal(HostProtocol.ServiceMethods.WorkspaceEndpoint, (string?)Manifest["service"]!["workspaceEndpoint"]);
        Assert.Equal(HostProtocol.WorkspacePath, (string?)Manifest["workspace"]!["path"]);
    }

    [Fact]
    public void Every_name_is_known_to_the_web_side()
    {
        static HashSet<string> Constants(Type type) => [.. type.GetFields().Select(field => (string)field.GetRawConstantValue()!)];
        Assert.Subset(Names("capabilities"), Constants(typeof(HostProtocol.Capabilities)));
        Assert.Subset(Names("methods"), Constants(typeof(HostProtocol.Methods)));
        Assert.Subset(Names("events"), Constants(typeof(HostProtocol.Events)));
        Assert.Subset(Names("errors"), Constants(typeof(HostProtocol.ErrorCodes)));
    }
}
