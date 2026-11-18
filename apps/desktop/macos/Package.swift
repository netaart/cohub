// swift-tools-version: 6.0
import PackageDescription
import Foundation

let appStore = ProcessInfo.processInfo.environment["COHUB_DISTRIBUTION"] == "app-store"

var products: [Product] = [.library(name: "CohubCore", targets: ["CohubCore"])]
var dependencies: [Package.Dependency] = []
var targets: [Target] = [
    .target(name: "CohubCore"),
    .testTarget(name: "CohubCoreTests", dependencies: ["CohubCore"]),
]

#if os(macOS)
products.append(.executable(name: "Cohub", targets: ["Cohub"]))
var appDependencies: [Target.Dependency] = ["CohubCore"]
if appStore {
    targets.append(.target(name: "CohubAppleAuth", dependencies: ["CohubCore"]))
    appDependencies.append("CohubAppleAuth")
} else {
    dependencies.append(.package(url: "https://github.com/sparkle-project/Sparkle", from: "2.10.1"))
    appDependencies.append(.product(name: "Sparkle", package: "Sparkle"))
}
targets.append(
    .executableTarget(
        name: "Cohub",
        dependencies: appDependencies,
        swiftSettings: appStore ? [.define("APP_STORE")] : [],
        linkerSettings: [.unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"])]
    )
)
#endif

let package = Package(
    name: "Cohub",
    platforms: [.macOS(appStore ? "14.4" : "13.0")],
    products: products,
    dependencies: dependencies,
    targets: targets
)
