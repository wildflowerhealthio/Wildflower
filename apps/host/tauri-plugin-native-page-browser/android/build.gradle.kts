plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.wildflowerhealth.nativepagebrowser"
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
    // ContextCompat + Drawable.toBitmap for the close icon.
    implementation("androidx.core:core-ktx:1.13.1")
    // AppCompatActivity in the Plugin lifecycle hooks.
    implementation("androidx.appcompat:appcompat:1.7.0")
    // CustomTabsIntent, CustomTabsClient / CustomTabsCallback (the TAB_HIDDEN
    // close report), and the per-scheme colour params.
    implementation("androidx.browser:browser:1.8.0")
    // The Tauri Android library, injected by the host app's generated project.
    implementation(project(":tauri-android"))
}
