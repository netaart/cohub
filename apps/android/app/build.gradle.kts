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
    }

    buildFeatures {
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
                    "-ldflags", "-s -w -X main.buildVersion=${version.get()}",
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

androidComponents {
    onVariants { variant ->
        variant.sources.jniLibs?.addGeneratedSourceDirectory(buildSandboxd, BuildSandboxd::outputDirectory)
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
