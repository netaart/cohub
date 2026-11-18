import Foundation
import XCTest
#if os(macOS)
import AppKit
import ApplicationServices
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
        app.launchArguments += ["-NSWindow Frame Cohub", "0 0 1440 900 0 0 1920 1080"]
        #endif
        app.launch()
        #if os(macOS)
        resizeWindow()
        #endif
    }

    func testLoginAndCapture() async throws {
        #if os(macOS)
        let security = XCUIApplication(bundleIdentifier: "com.apple.SecurityAgent")
        let password = security.secureTextFields.firstMatch
        if password.waitForExistence(timeout: 8) {
            password.tap()
            password.typeText(try XCTUnwrap(ProcessInfo.processInfo.environment["COHUB_TEST_KEYCHAIN_PASSWORD"]))
            security.buttons["Always Allow"].tap()
        }
        guard app.textViews.firstMatch.waitForExistence(timeout: 45) else {
            capture("diagnostic-session")
            throw NSError(domain: "The review session did not load", code: 1)
        }
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
        guard app.textViews.firstMatch.waitForExistence(timeout: 45) else { throw NSError(domain: "The session did not survive relaunch", code: 1) }
        capture("04-restored-session")

        if let space = ProcessInfo.processInfo.environment["COHUB_SCREENSHOT_SPACE"], !space.isEmpty {
            for language in ["en", "zh-Hans"] {
                app.terminate()
                app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "zh_CN", "-lastPage", "/settings/general", "-lastPath", "/settings/general", "-tabSession", ""]
                app.launch()
                let languageButton = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", language == "en" ? "English" : "简体中文")).firstMatch
                if languageButton.waitForExistence(timeout: 25), languageButton.isHittable { languageButton.tap() }
                var pages = [
                    ("05-launch-plan", "/spaces/\(space)/files/\(language == "en" ? "launch-plan.md" : "launch-plan-zh.md")"),
                    ("06-creative-brief", "/spaces/\(space)/files/\(language == "en" ? "creative-brief.md" : "creative-brief-zh.md")"),
                ]
                if let chat = ProcessInfo.processInfo.environment[language == "en" ? "COHUB_CHAT_EN" : "COHUB_CHAT_ZH"], !chat.isEmpty { pages.insert(("04-agent-review", "/sessions/\(chat)"), at: 0) }
                for (name, path) in pages {
                    app.terminate()
                    app.launchArguments = ["-AppleLanguages", "(\(language))", "-AppleLocale", language == "en" ? "en_US" : "zh_CN", "-lastPage", path, "-lastPath", path, "-tabSession", ""]
                    #if os(macOS)
                    app.launchArguments += ["-NSWindow Frame Cohub", "0 0 1440 900 0 0 1920 1080"]
                    #endif
                    app.launch()
                    #if os(macOS)
                    resizeWindow()
                    #endif
                    guard app.webViews.firstMatch.waitForExistence(timeout: 25) else {
                        capture("diagnostic-" + name)
                        throw NSError(domain: "The sample document preview did not load", code: 1)
                    }
                    try await Task.sleep(for: .seconds(4))
                    capture(language + "-" + name)
                }
            }
        }
    }

    private func capture(_ name: String) {
        #if os(macOS)
        let screenshot = app.windows.firstMatch.screenshot()
        #else
        let screenshot = app.screenshot()
        #endif
        let attachment = XCTAttachment(data: screenshot.pngRepresentation, uniformTypeIdentifier: "public.png")
        attachment.name = "STORE_" + name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    #if os(macOS)
    private func resizeWindow() {
        let window = app.windows.firstMatch
        guard window.waitForExistence(timeout: 10) else { return }
        let display = CGMainDisplayID()
        let modes = CGDisplayCopyAllDisplayModes(display, [kCGDisplayShowDuplicateLowResolutionModes: true] as CFDictionary) as? [CGDisplayMode] ?? []
        if let mode = modes.filter({ $0.width >= 1440 && $0.height >= 900 }).min(by: { $0.width * $0.height < $1.width * $1.height }) { CGDisplaySetDisplayMode(display, mode, nil) }
        if let process = NSRunningApplication.runningApplications(withBundleIdentifier: "live.cohub.ios").first {
            let target = AXUIElementCreateApplication(process.processIdentifier)
            var windows: CFTypeRef?
            if AXUIElementCopyAttributeValue(target, kAXWindowsAttribute as CFString, &windows) == .success,
               let first = (windows as? [AXUIElement])?.first {
                var size = CGSize(width: 1280, height: 800)
                var point = CGPoint(x: 30, y: 30)
                if let value = AXValueCreate(.cgPoint, &point) { AXUIElementSetAttributeValue(first, kAXPositionAttribute as CFString, value) }
                if let value = AXValueCreate(.cgSize, &size) { AXUIElementSetAttributeValue(first, kAXSizeAttribute as CFString, value) }
            }
        }
        print("Window size: \(window.frame.width)x\(window.frame.height)")
    }
    #endif

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
