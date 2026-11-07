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
    val applicationIdSuffix: String? = null,
)

val deployments = mapOf(
    "prod" to Deployment(
        webOrigin = "https://cohub.live",
        apiOrigin = "https://api.cohub.live",
        gatewayOrigin = "wss://gateway.cohub.live",
        logtoEndpoint = "https://auth.neta.art/",
        logtoAppId = "kpwepos08jz70jy20d3hg",
        appName = "Cohub",
    ),
    "dev" to Deployment(
        webOrigin = "https://dev.cohub.live",
        apiOrigin = "https://api-dev.cohub.live",
        gatewayOrigin = "wss://gateway-dev.cohub.live",
        logtoEndpoint = "https://dev-auth.neta.art/",
        logtoAppId = "grxctv83gvvo2wcmcb8xp",
        appName = "Cohub Dev",
        applicationIdSuffix = ".dev",
    ),
)

fun prop(name: String): String? = providers.gradleProperty(name).orNull

val cohubEnv: String = prop("cohubEnv") ?: "prod"
val deployment = deployments[cohubEnv] ?: error("Unknown cohubEnv '$cohubEnv'; expected one of ${deployments.keys}")
val webOrigin: String = prop("cohubWebOrigin") ?: deployment.webOrigin
val apiOrigin: String = prop("cohubApiOrigin") ?: deployment.apiOrigin
val gatewayOrigin: String = prop("cohubGatewayOrigin") ?: deployment.gatewayOrigin
val logtoEndpoint: String = prop("cohubLogtoEndpoint") ?: deployment.logtoEndpoint
val logtoAppId: String = prop("cohubLogtoAppId") ?: deployment.logtoAppId
val logtoApiResource: String = prop("cohubLogtoApiResource") ?: "https://api.talesofai"
val oauthRedirectPath: String = prop("cohubOauthRedirectPath") ?: "/mobile/auth/callback"

val repoRoot: File = rootProject.layout.projectDirectory.dir("../..").asFile
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
        applicationId = "live.cohub.android"
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
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
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
        val zip = assets.get().asFile.apply { deleteRecursively(); mkdirs() }.resolve("cli.zip")
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

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
