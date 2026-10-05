plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// CI signs with one fixed key (GitHub secrets), so a new APK installs over the old one.
val keystoreFile = System.getenv("WIDGET_KEYSTORE_FILE")

android {
    namespace = "com.vidsum.widget"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.vidsum.widget"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()
        versionName = "1.0.${System.getenv("GITHUB_RUN_NUMBER") ?: "0"}"
    }

    signingConfigs {
        if (keystoreFile != null) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("WIDGET_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("WIDGET_KEY_ALIAS")
                keyPassword = System.getenv("WIDGET_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (keystoreFile != null) signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("org.unifiedpush.android:connector:2.5.0")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
}
