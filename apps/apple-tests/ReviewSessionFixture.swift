import Foundation
import Security
import XCTest

final class ReviewSessionFixture: XCTestCase {
    func testInstallAuthenticatedReviewSession() throws {
        guard let json = ProcessInfo.processInfo.environment["COHUB_SCREENSHOT_SESSION"], !json.isEmpty else {
            throw XCTSkip("Live-login mode does not install a session fixture")
        }
        let data = try XCTUnwrap(json.data(using: .utf8))
        let credentials = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertNotNil(credentials["refreshToken"])
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "live.cohub.ios", kSecAttrAccount as String: "session"]
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            XCTAssertEqual(SecItemAdd(item as CFDictionary, nil), errSecSuccess)
        } else {
            XCTAssertEqual(status, errSecSuccess)
        }
        UserDefaults.standard.set(true, forKey: "installed")
        print("Installed a real authenticated review-session fixture in the test-host keychain")
    }
}
