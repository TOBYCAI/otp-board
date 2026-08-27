plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.otpforward"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.example.otpforward"
        minSdk = 29
        targetSdk = 35
        versionCode = 6
        versionName = "3.2.1"
    }

    buildFeatures {
        resValues = true
    }

    signingConfigs {
        create("release") {
            val keyPath = System.getenv("KEYSTORE_PATH")
                ?: providers.gradleProperty("KEYSTORE_PATH").orNull
            if (keyPath != null) {
                storeFile = file(keyPath)
                storePassword = System.getenv("KEYSTORE_PASSWORD")
                    ?: providers.gradleProperty("KEYSTORE_PASSWORD").orNull
                    ?: ""
                keyAlias = System.getenv("KEY_ALIAS")
                    ?: providers.gradleProperty("KEY_ALIAS").orNull
                    ?: ""
                keyPassword = System.getenv("KEY_PASSWORD")
                    ?: providers.gradleProperty("KEY_PASSWORD").orNull
                    ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 生产签名：设置 KEYSTORE_PATH(或 -PKEYSTORE_PATH=...) 时用生产 keystore 签名；
            // 未配置时回退 debug 签名（保持本地开发可构建）。
            val hasKey = System.getenv("KEYSTORE_PATH") != null
                || providers.gradleProperty("KEYSTORE_PATH").isPresent
            signingConfig = if (hasKey) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
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
    implementation(project(":otp-core"))

    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")

    testImplementation("junit:junit:4.13.2")
}
