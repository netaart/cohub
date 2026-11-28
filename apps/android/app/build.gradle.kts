import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import javax.inject.Inject

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.serialization)
}

data class Deployment(
    val webOrigin: String,
    val apiOrigin: String,
    val gatewayOrigin: String,
    val logtoEndpoint: String,
    val logtoAppId: String,
    val appName: String,
    val applicationIdSuffix: String?,
)

val repoRoot: File = rootProject.layout.projectDirectory.dir("../..").asFile
val applicationIdBase = "live.cohub.android"

@Suppress("UNCHECKED_CAST")
val nativeApps = groovy.json.JsonSlurper().parse(repoRoot.resolve("packages/protocol/src/native-apps.json")) as Map<String, Any?>

@Suppress("UNCHECKED_CAST")
val deployments: Map<String, Deployment> = (nativeApps["deployments"] as Map<String, Map<String, Any?>>).mapValues { (_, it) ->
    val packageName = (it["android"] as Map<String, Any?>)["packageName"] as String
    check(packageName.startsWith(applicationIdBase)) { "Android package $packageName must extend $applicationIdBase" }
    Deployment(
        webOrigin = it["webOrigin"] as String,
        apiOrigin = it["apiOrigin"] as String,
        gatewayOrigin = it["gatewayOrigin"] as String,
        logtoEndpoint = it["logtoEndpoint"] as String,
        logtoAppId = it["logtoAppId"] as String,
        appName = it["appName"] as String,
        applicationIdSuffix = packageName.removePrefix(applicationIdBase).ifEmpty { null },
    )
}

fun prop(name: String): String? = providers.gradleProperty(name).orNull

val cohubEnv: String = prop("cohubEnv") ?: "prod"
val deployment = deployments[cohubEnv] ?: error("Unknown cohubEnv '$cohubEnv'; expected one of ${deployments.keys}")
val webOrigin: String = prop("cohubWebOrigin") ?: deployment.webOrigin
val apiOrigin: String = prop("cohubApiOrigin") ?: deployment.apiOrigin
val gatewayOrigin: String = prop("cohubGatewayOrigin") ?: deployment.gatewayOrigin
val logtoEndpoint: String = prop("cohubLogtoEndpoint") ?: deployment.logtoEndpoint
val logtoAppId: String = prop("cohubLogtoAppId") ?: deployment.logtoAppId
val logtoApiResource: String = prop("cohubLogtoApiResource") ?: nativeApps["logtoApiResource"] as String

@Suppress("UNCHECKED_CAST")
val oauthRedirectPath: String = prop("cohubOauthRedirectPath") ?: (nativeApps["paths"] as Map<String, Any?>)["authCallback"] as String

val cliVersion: String = Regex("\"version\"\\s*:\\s*\"([^\"]+)\"")
    .find(repoRoot.resolve("packages/cli/package.json").readText())?.groupValues?.get(1) ?: ""
val commit: String = runCatching {
    providers.exec {
        commandLine("git", "-C", repoRoot.path, "rev-parse", "--short=7", "HEAD")
        isIgnoreExitValue = true
    }.standardOutput.asText.get().trim()
}.getOrDefault("")

val signingKeystore: String? = providers.environmentVariable("COHUB_ANDROID_KEYSTORE").orNull
val signingPassword: String? = providers.environmentVariable("COHUB_ANDROID_KEYSTORE_PASSWORD").orNull

android {
    namespace = "live.cohub.android"
    compileSdk = 37
    ndkVersion = "29.0.14206865"

    defaultConfig {
        applicationId = applicationIdBase
        applicationIdSuffix = deployment.applicationIdSuffix
        minSdk = 26
        targetSdk = 37
        versionCode = prop("cohubVersionCode")?.toInt() ?: 1
        versionName = (prop("cohubVersionName") ?: "0.1.0") + (prop("cohubVersionSuffix") ?: "")

        // HTTPS App Link (verified via assetlinks.json), not a claimable custom scheme.
        manifestPlaceholders["oauthHost"] = webOrigin.removePrefix("https://").removePrefix("http://")
        manifestPlaceholders["oauthPathPrefix"] = oauthRedirectPath.trimEnd('/')
        manifestPlaceholders["appName"] = deployment.appName

        buildConfigField("String", "COHUB_ENV", "\"$cohubEnv\"")
        buildConfigField("String", "API_ORIGIN", "\"$apiOrigin\"")
        buildConfigField("String", "WEB_ORIGIN", "\"$webOrigin\"")
        buildConfigField("String", "GATEWAY_ORIGIN", "\"$gatewayOrigin\"")
        buildConfigField("String", "LOGTO_ENDPOINT", "\"$logtoEndpoint\"")
        buildConfigField("String", "LOGTO_APP_ID", "\"$logtoAppId\"")
        buildConfigField("String", "LOGTO_API_RESOURCE", "\"$logtoApiResource\"")
        buildConfigField("String", "OAUTH_REDIRECT_URI", "\"$webOrigin$oauthRedirectPath\"")
        buildConfigField("boolean", "WEB_DEBUGGING", "${cohubEnv == "dev"}")
        buildConfigField("boolean", "PLAY_BUILD", "false")
        buildConfigField("String", "CLI_VERSION", "\"$cliVersion\"")
        buildConfigField("String", "COMMIT", "\"$commit\"")
    }

    buildFeatures {
        aidl = true
        buildConfig = true
    }

    signingConfigs {
        if (signingKeystore != null) {
            create("ci") {
                storeFile = file(signingKeystore)
                storeType = "pkcs12"
                storePassword = signingPassword ?: error("COHUB_ANDROID_KEYSTORE_PASSWORD is required with COHUB_ANDROID_KEYSTORE")
                keyAlias = "cohub"
                keyPassword = storePassword
            }
        }
    }

    buildTypes {
        val ciSigning = signingConfigs.findByName("ci")
        debug {
            if (ciSigning != null) signingConfig = ciSigning
            buildConfigField("boolean", "WEB_DEBUGGING", "true")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = ciSigning
        }
        create("playRelease") {
            initWith(getByName("release"))
            matchingFallbacks += "release"
            buildConfigField("boolean", "PLAY_BUILD", "true")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
            allWarningsAsErrors.set(true)
        }
    }

    lint {
        warningsAsErrors = true
        abortOnError = true
        informational += setOf("AndroidGradlePluginVersion", "GradleDependency", "NewerVersionAvailable", "OldTargetApi")
    }

    bundle {
        language { enableSplit = false }
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
        // sandboxd is executed, not loaded, so it must be extracted to nativeLibraryDir.
        jniLibs.useLegacyPackaging = true
    }
}

// cgo links bionic's resolver: Go's own DNS client cannot work on Android.
abstract class BuildSandboxd : DefaultTask() {
    @get:Internal
    abstract val module: DirectoryProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:Internal
    abstract val ndkDirectory: DirectoryProperty

    @get:Input
    abstract val apiLevel: Property<Int>

    @get:Input
    abstract val version: Property<String>

    @get:OutputDirectory
    abstract val outputDirectory: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun build() {
        val host = when {
            System.getProperty("os.name").startsWith("Linux") -> "linux-x86_64"
            System.getProperty("os.name").startsWith("Mac") -> "darwin-x86_64"
            else -> throw GradleException("Building sandboxd needs a Linux or macOS host")
        }
        val ndk = ndkDirectory.get().asFile
        if (!ndk.isDirectory) throw GradleException("NDK ${ndk.name} is missing; install it with: sdkmanager \"ndk;${ndk.name}\"")
        val toolchain = ndk.resolve("toolchains/llvm/prebuilt/$host/bin")
        val output = outputDirectory.get().asFile.apply { deleteRecursively() }
        for ((abi, goArch, target) in ABIS) {
            exec.exec {
                workingDir = module.get().asFile
                environment("GOOS", "android")
                environment("GOARCH", goArch)
                environment("CGO_ENABLED", "1")
                environment("CC", toolchain.resolve("$target${apiLevel.get()}-clang").path)
                commandLine(
                    "go", "build", "-trimpath", "-buildvcs=false",
                    // pion's ICE enumerates interfaces through wlynxg/anet, which works
                    // around Android 11's netlink ban by linking net's private zone
                    // cache; Go 1.23+ refuses that link unless the check is off.
                    "-ldflags", "-s -w -checklinkname=0 -X main.buildVersion=${version.get()}",
                    "-o", output.resolve("$abi/libcohub_sandboxd.so").path, ".",
                )
            }
        }
    }

    private companion object {
        val ABIS = listOf(
            Triple("arm64-v8a", "arm64", "aarch64-linux-android"),
            Triple("x86_64", "amd64", "x86_64-linux-android"),
        )
    }
}

val buildSandboxd = tasks.register<BuildSandboxd>("buildSandboxd") {
    module.set(rootProject.layout.projectDirectory.dir("../sandbox"))
    sources.from(
        module.map { dir ->
            dir.asFileTree.matching {
                include("**/*.go", "go.mod", "go.sum")
                exclude("**/*_test.go")
            }
        },
    )
    ndkDirectory.set(androidComponents.sdkComponents.sdkDirectory.map { it.dir("ndk/${android.ndkVersion}") })
    apiLevel.set(android.defaultConfig.minSdk ?: 26)
    version.set("android-${android.defaultConfig.versionName}")
    outputDirectory.set(layout.buildDirectory.dir("generated/sandboxd"))
}

// `cohub` for what a Runtime runs, as on computers: this commit's CLI under Node built for Android
// (arm64; scripts/stage-runtime.mjs). Both executables live in nativeLibraryDir, the CLI is an asset.
@CacheableTask
abstract class StageCli : DefaultTask() {
    @get:InputFile
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val script: RegularFileProperty

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sources: ConfigurableFileCollection

    @get:InputFile
    @get:PathSensitive(PathSensitivity.NONE)
    abstract val launcher: RegularFileProperty

    @get:OutputDirectory
    abstract val jniLibs: DirectoryProperty

    @get:OutputDirectory
    abstract val assets: DirectoryProperty

    @get:Inject
    abstract val exec: ExecOperations

    @TaskAction
    fun stage() {
        val staged = temporaryDir.apply { deleteRecursively() }
        exec.exec { commandLine("node", script.get().asFile.path, "--platform", "android", "--arch", "arm64", "--out", staged.path) }
        val libs = jniLibs.get().asFile.apply { deleteRecursively() }.resolve("arm64-v8a").apply { mkdirs() }
        staged.resolve("node").copyTo(libs.resolve("libcohub_node.so"))
        launcher.get().asFile.copyTo(libs.resolve("libcohub_cli.so"))
        val cli = staged.resolve("cli")
        val zip = assets.get().asFile.apply {
            deleteRecursively()
            mkdirs()
        }.resolve("cli.zip")
        ZipOutputStream(zip.outputStream()).use { out ->
            cli.walkTopDown().onEnter { it.name != ".bin" }.filter { it.isFile }.sortedBy { it.path }.forEach { file ->
                out.putNextEntry(ZipEntry(file.relativeTo(cli).invariantSeparatorsPath))
                file.inputStream().use { it.copyTo(out) }
                out.closeEntry()
            }
        }
    }
}

val stageCli = tasks.register<StageCli>("stageCli") {
    val repo = rootProject.layout.projectDirectory.dir("../..")
    script.set(repo.file("scripts/stage-runtime.mjs"))
    sources.from(repo.dir("packages/cli/dist"), repo.file("packages/cli/package.json"))
    launcher.set(layout.projectDirectory.file("src/main/cli/cohub"))
    jniLibs.set(layout.buildDirectory.dir("generated/cli/jniLibs"))
    assets.set(layout.buildDirectory.dir("generated/cli/assets"))
}

androidComponents {
    onVariants { variant ->
        if (variant.buildType == "playRelease") return@onVariants
        variant.sources.jniLibs?.addGeneratedSourceDirectory(buildSandboxd, BuildSandboxd::outputDirectory)
        variant.sources.jniLibs?.addGeneratedSourceDirectory(stageCli, StageCli::jniLibs)
        variant.sources.assets?.addGeneratedSourceDirectory(stageCli, StageCli::assets)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.datastore)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)
    implementation(libs.androidx.fragment)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}

val ktlint: Configuration = configurations.create("ktlint") {
    isCanBeConsumed = false
    attributes {
        attribute(Bundling.BUNDLING_ATTRIBUTE, objects.named(Bundling.EXTERNAL))
        attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
        attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
        attribute(LibraryElements.LIBRARY_ELEMENTS_ATTRIBUTE, objects.named(LibraryElements.JAR))
    }
}

dependencies { ktlint(libs.ktlint.cli) }

fun JavaExec.runKtlint(vararg options: String) {
    classpath = ktlint
    mainClass.set("com.pinterest.ktlint.Main")
    workingDir = rootProject.projectDir
    jvmArgs("--add-opens=java.base/java.lang=ALL-UNNAMED")
    args(*options, "--relative", "app/src/**/*.kt", "*.gradle.kts", "app/*.gradle.kts")
}

val ktlintCheck = tasks.register<JavaExec>("ktlintCheck") {
    group = LifecycleBasePlugin.VERIFICATION_GROUP
    description = "Checks the Kotlin style of sources and build scripts."
    runKtlint()
}

tasks.register<JavaExec>("ktlintFormat") {
    group = "formatting"
    description = "Formats sources and build scripts in the Kotlin style."
    runKtlint("--format")
}

tasks.named("check") { dependsOn(ktlintCheck) }
