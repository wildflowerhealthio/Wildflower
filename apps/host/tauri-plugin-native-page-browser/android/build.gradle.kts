plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.wildflowerhealth.nativepagebrowser"
    compileSdk = 36

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
    // AppCompatActivity, which `Plugin`'s lifecycle hooks take: subclassing
    // `Plugin` needs it on the compile classpath.
    implementation("androidx.appcompat:appcompat:1.7.0")
    // CustomTabsIntent, CustomTabsClient.getPackageName (the provider), the
    // per-scheme colour params, and ephemeral browsing (1.9.0+, which needs
    // compileSdk 36).
    implementation("androidx.browser:browser:1.9.0")
    // The Tauri Android library, injected by the host app's generated project.
    implementation(project(":tauri-android"))
}
