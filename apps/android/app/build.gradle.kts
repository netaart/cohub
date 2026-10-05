plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

data class Deployment(
    val webOrigin: String,
    val apiOrigin: String,
    val logtoEndpoint: String,
    val logtoAppId: String,
    val appName: String,
    val applicationIdSuffix: String? = null,
)

val deployments = mapOf(
    "prod" to Deployment(
        webOrigin = "https://cohub.live",
        apiOrigin = "https://api.cohub.live",
        logtoEndpoint = "https://auth.neta.art/",
        logtoAppId = "kpwepos08jz70jy20d3hg",
        appName = "Cohub",
    ),
    "dev" to Deployment(
        webOrigin = "https://dev.cohub.live",
        apiOrigin = "https://api-dev.cohub.live",
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
val logtoEndpoint: String = prop("cohubLogtoEndpoint") ?: deployment.logtoEndpoint
val logtoAppId: String = prop("cohubLogtoAppId") ?: deployment.logtoAppId
val logtoApiResource: String = prop("cohubLogtoApiResource") ?: "https://api.talesofai"
val oauthRedirectPath: String = prop("cohubOauthRedirectPath") ?: "/mobile/auth/callback"

val signingKeystore: String? = providers.environmentVariable("COHUB_ANDROID_KEYSTORE").orNull
val signingPassword: String? = providers.environmentVariable("COHUB_ANDROID_KEYSTORE_PASSWORD").orNull

android {
    namespace = "live.cohub.android"
    compileSdk = 37

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
        buildConfigField("String", "LOGTO_ENDPOINT", "\"$logtoEndpoint\"")
        buildConfigField("String", "LOGTO_APP_ID", "\"$logtoAppId\"")
        buildConfigField("String", "LOGTO_API_RESOURCE", "\"$logtoApiResource\"")
        buildConfigField("String", "OAUTH_REDIRECT_URI", "\"$webOrigin$oauthRedirectPath\"")
    }

    buildFeatures {
        compose = true
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
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.browser)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.security.crypto)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)

    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.espresso.core)
}
