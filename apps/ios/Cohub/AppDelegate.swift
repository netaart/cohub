import CohubCore
import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Shell.shared.launch()
        return true
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let shell = Shell.shared
        let link = options.userActivities.compactMap { self.path(ofActivity: $0) }.first
            ?? options.urlContexts.compactMap { self.path(ofLink: $0.url) }.first
            ?? options.shortcutItem.flatMap(QuickActions.path(of:))
        if let link { shell.open(link) }

        let window = UIWindow(windowScene: scene)
        let surface = ShellViewController(shell: shell, path: shell.takeStartPath(), dark: scene.traitCollection.userInterfaceStyle == .dark)
        shell.surface = surface
        window.rootViewController = surface
        window.makeKeyAndVisible()
        self.window = window
    }

    func scene(_ scene: UIScene, openURLContexts contexts: Set<UIOpenURLContext>) {
        if let path = contexts.compactMap({ self.path(ofLink: $0.url) }).first { Shell.shared.open(path) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        if let path = path(ofActivity: userActivity) { Shell.shared.open(path) }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem, completionHandler: @escaping (Bool) -> Void) {
        guard let path = QuickActions.path(of: shortcutItem) else { return completionHandler(false) }
        Shell.shared.open(path)
        completionHandler(true)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        Shell.shared.surface?.enteredForeground()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        Shell.shared.surface?.enteredBackground()
    }

    private func path(ofActivity activity: NSUserActivity) -> String? {
        guard activity.activityType == NSUserActivityTypeBrowsingWeb, let url = activity.webpageURL else { return nil }
        return Shell.shared.config.origin.path(of: url)
    }

    private func path(ofLink url: URL) -> String? {
        WebOrigin.path(fromDeepLink: url, scheme: Shell.shared.config.urlScheme)
    }
}
