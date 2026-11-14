import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) {
        file.inputStream().use { load(it) }
    }
}

val mwdatApplicationId =
    localProperties.getProperty("mwdat_application_id")?.trim()?.takeIf { it.isNotEmpty() } ?: "0"
val mwdatClientToken =
    localProperties.getProperty("mwdat_client_token")?.trim()?.takeIf { it.isNotEmpty() } ?: "0"

fun quoteForBuildConfig(value: String): String {
    val escaped = value.replace("\\", "\\\\").replace("\"", "\\\"")
    return "\"$escaped\""
}

android {
    namespace = "app.holdup.bridge"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.holdup.bridge"
        minSdk = 31
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"

        manifestPlaceholders["mwdatApplicationId"] = mwdatApplicationId
        manifestPlaceholders["mwdatClientToken"] = mwdatClientToken
        manifestPlaceholders["mwdat_application_id"] = mwdatApplicationId
        manifestPlaceholders["mwdat_client_token"] = mwdatClientToken

        buildConfigField("String", "MWDAT_APP_ID", quoteForBuildConfig(mwdatApplicationId))
        buildConfigField("String", "MWDAT_CLIENT_TOKEN", quoteForBuildConfig(mwdatClientToken))
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.fromTarget("17"))
    }
}

dependencies {
    implementation(libs.mwdat.core)
    implementation(libs.mwdat.camera)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.androidx.core.ktx)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
