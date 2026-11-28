import Foundation
import Testing

@testable import CohubCore

@Suite struct BridgeEnvelopeTests {
    // swift-format-ignore: NeverForceUnwrap, NeverUseForceTry
    static let fixture = JSON.parse(
        try! Data(
            contentsOf: URL(fileURLWithPath: #filePath)
                .appendingPathComponent("../../../../../../packages/protocol/fixtures/host-bridge.json").standardizedFileURL))!

    static func cases(_ key: String) -> [JSON] { fixture[key]?.array ?? [] }

    @Test(arguments: cases("requests"))
    func parsesRequests(_ item: JSON) throws {
        let text = try #require(item["text"]?.string)
        let parsed = BridgeRequest.parse(text)
        guard let expected = item["request"], expected != .null else {
            #expect(parsed == nil, "\(item["name"]?.string ?? "")")
            return
        }
        #expect(parsed?.id == expected["id"]?.string)
        #expect(parsed?.method == expected["method"]?.string)
        #expect(parsed?.params == expected["params"])
    }

    @Test(arguments: cases("replies"))
    func serialisesReplies(_ item: JSON) throws {
        let id = try #require(item["id"]?.string)
        let reply: BridgeReply =
            if let error = item["error"] {
                .failure(BridgeFailure(error["code"]?.string ?? "", error["message"]?.string ?? ""))
            } else {
                .result(item["result"] ?? .null)
            }
        #expect(JSON.parse(reply.text(id: id)) == item["json"])
    }

    @Test(arguments: cases("events"))
    func serialisesEvents(_ item: JSON) throws {
        let name = try #require(item["event"]?.string)
        #expect(JSON.parse(BridgeEvent.text(name: name, payload: item["payload"])) == item["json"])
    }
}
