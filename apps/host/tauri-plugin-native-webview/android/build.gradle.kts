plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.wildflowerhealth.nativewebview"
    compileSdk = 34

    defaultConfig {
        minSdk = 24
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    kotlinOptions {
        jvmTarget = "1.8"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    // WebViewCompat.addDocumentStartJavaScript — at-document-start injection on
    // any origin via setOf("*").
    implementation("androidx.webkit:webkit:1.12.1")
    // The Tauri Android library, injected by the host app's generated project.
    implementation(project(":tauri-android"))
}
