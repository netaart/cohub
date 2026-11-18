import Foundation
import XCTest
#if os(macOS)
import AppKit
#endif

@MainActor
final class StoreAcceptanceTests: XCTestCase {
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        #if os(macOS)
        let path = try XCTUnwrap(ProcessInfo.processInfo.environment["COHUB_MAC_APP_PATH"])
        app = XCUIApplication(url: URL(fileURLWithPath: path))
        #else
        app = XCUIApplication()
        #endif
        app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        #if os(macOS)
        app.launchArguments += ["-NSWindow Frame Cohub", "0 0 1280 800 0 0 1280 1024"]
        #endif
        app.launch()
    }

    func testLoginAndCapture() async throws {
        #if os(macOS)
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 45), "The review session did not load in the sandboxed screenshot copy")
        capture("02-new-chat")
        #else
        let start = app.buttons.matching(NSPredicate(format: "label IN %@", ["Start", "Start a Space", "Sign in", "登录", "开始"])).firstMatch
        XCTAssertTrue(start.waitForExistence(timeout: 45), "The first screen did not become interactive")
        capture("01-welcome")
        start.tap()
        let requestedAt = Date()
        let email = try XCTUnwrap(ProcessInfo.processInfo.environment["COHUB_REVIEW_EMAIL"])
        let mailbox = try XCTUnwrap(ProcessInfo.processInfo.environment["COHUB_REVIEW_MAILBOX_URL"])

        #if os(iOS)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        for host in [app!, springboard] {
            let permission = host.alerts.buttons.matching(NSPredicate(format: "label IN %@", ["Continue", "继续"])).firstMatch
            if permission.waitForExistence(timeout: 3) { permission.tap() }
        }
        let hosts = [app!, XCUIApplication(bundleIdentifier: "com.apple.SafariViewService"), XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")]
        var browser = app!
        for host in hosts where host.textFields.firstMatch.waitForExistence(timeout: 10) { browser = host; break }
        #else
        let browser = XCUIApplication(bundleIdentifier: "com.apple.Safari")
        #endif
        let field = browser.textFields.firstMatch
        guard field.waitForExistence(timeout: 20) else {
            capture("diagnostic-sign-in")
            print(app.debugDescription)
            throw NSError(domain: "Native sign-in page did not appear", code: 1)
        }
        field.tap()
        field.typeText(email)
        let signIn = browser.buttons.matching(NSPredicate(format: "label IN %@", ["Sign in", "Continue", "登录", "继续"])).firstMatch
        XCTAssertTrue(signIn.waitForExistence(timeout: 10), "The sign-in action is missing")
        signIn.tap()

        let code = try await verificationCode(mailbox: mailbox, after: requestedAt)
        print("::add-mask::\(code)")
        let codeFields = browser.textFields
        XCTAssertTrue(codeFields.firstMatch.waitForExistence(timeout: 20), "The verification-code input is missing")
        codeFields.firstMatch.tap()
        codeFields.firstMatch.typeText(code)
        let verify = browser.buttons.matching(NSPredicate(format: "label IN %@", ["Verify", "Continue", "Sign in", "验证", "继续", "登录"])).firstMatch
        if verify.waitForExistence(timeout: 3), verify.isHittable { verify.tap() }

        let composer = app.textViews.firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 45), "The HTTPS callback did not return to the authenticated app")
        capture("02-new-chat")
        #endif

        app.terminate()
        app.launch()
        XCTAssertTrue(app.textViews.firstMatch.waitForExistence(timeout: 45), "The signed-in session did not survive relaunch")
        capture("04-restored-session")

        if let space = ProcessInfo.processInfo.environment["COHUB_SCREENSHOT_SPACE"], !space.isEmpty {
            for language in ["en", "zh-Hans"] {
                for (name, path, heading) in [
                    ("05-launch-plan", "/spaces/\(space)/files/launch-plan.md", "A small idea"),
                    ("06-creative-brief", "/spaces/\(space)/files/creative-brief.md", "Welcome to the studio"),
                ] {
                    app.terminate()
                    app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "zh_CN", "-lastPage", path, "-lastPath", path, "-tabSession", ""]
                    #if os(macOS)
                    app.launchArguments += ["-NSWindow Frame Cohub", "0 0 1280 800 0 0 1280 1024"]
                    #endif
                    app.launch()
                    let content = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", heading)).firstMatch
                    XCTAssertTrue(content.waitForExistence(timeout: 45), "The sample document preview did not load")
                    capture(language + "-" + name)
                }
            }
        }
    }

    private func capture(_ name: String) {
        #if os(macOS)
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        #else
        let attachment = XCTAttachment(screenshot: app.screenshot())
        #endif
        attachment.name = "STORE_" + name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func verificationCode(mailbox: String, after: Date) async throws -> String {
        let source = try XCTUnwrap(URLComponents(string: mailbox))
        let jwt = try XCTUnwrap(source.queryItems?.first(where: { $0.name == "jwt" })?.value)
        var components = source
        components.path = "/api/mails"
        components.queryItems = [URLQueryItem(name: "limit", value: "10"), URLQueryItem(name: "offset", value: "0")]
        let url = try XCTUnwrap(components.url)
        let deadline = Date().addingTimeInterval(90)
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        let pattern = try NSRegularExpression(pattern: "(?<![0-9])[0-9]{6}(?![0-9])")
        while Date() < deadline {
            var request = URLRequest(url: url)
            request.setValue("Bearer " + jwt, forHTTPHeaderField: "Authorization")
            request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
            request.timeoutInterval = 15
            let (data, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "The review mailbox is unavailable")
            let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            for mail in object["results"] as? [[String: Any]] ?? [] {
                guard let timestamp = mail["created_at"] as? String,
                      let date = formatter.date(from: timestamp), date >= after.addingTimeInterval(-5),
                      let raw = mail["raw"] as? String, raw.localizedCaseInsensitiveContains("verification") else { continue }
                let body = raw.components(separatedBy: "\r\n\r\n").dropFirst().joined(separator: "\r\n\r\n")
                if let match = pattern.firstMatch(in: body, range: NSRange(body.startIndex..., in: body)), let range = Range(match.range, in: body) {
                    return String(body[range])
                }
            }
            try await Task.sleep(for: .seconds(3))
        }
        XCTFail("No new verification email arrived; check the sign-in flow and anti-bot challenge")
        throw NSError(domain: "CohubAcceptance", code: 1)
    }
}
