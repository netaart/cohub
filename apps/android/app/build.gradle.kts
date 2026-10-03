plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Injected at build time so one binary can target dev or prod; defaults to prod.
val cohubEnv: String = providers.gradleProperty("cohubEnv").getOrElse("prod")
val apiOrigin: String = providers.gradleProperty("cohubApiOrigin").getOrElse("https://api.cohub.live")
val webOrigin: String = providers.gradleProperty("cohubWebOrigin").getOrElse("https://cohub.live")
val logtoEndpoint: String = providers.gradleProperty("cohubLogtoEndpoint").getOrElse("https://auth.neta.art/")
val logtoAppId: String = providers.gradleProperty("cohubLogtoAppId").getOrElse("")
val logtoApiResource: String = providers.gradleProperty("cohubLogtoApiResource").getOrElse("https://api.talesofai")
val oauthRedirectPath: String = providers.gradleProperty("cohubOauthRedirectPath").getOrElse("/mobile/auth/callback")

android {
    namespace = "live.cohub.android"
    compileSdk = 37

    defaultConfig {
        applicationId = "live.cohub.android"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"

        // HTTPS App Link (verified via assetlinks.json), not a claimable custom scheme.
        manifestPlaceholders["oauthHost"] = webOrigin.removePrefix("https://").removePrefix("http://")
        manifestPlaceholders["oauthPathPrefix"] = oauthRedirectPath.trimEnd('/')
        manifestPlaceholders["webOrigin"] = webOrigin

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

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
