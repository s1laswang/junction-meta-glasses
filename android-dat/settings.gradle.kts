// HoldUp Bridge: structure and repositories adapted from Meta's DAT CameraAccess sample
// (github.com/facebook/meta-wearables-dat-android/tree/main/samples/CameraAccess).
// The DAT SDK is on Maven Central, so no GitHub Packages token is needed.

pluginManagement {
  repositories {
    google {
      content {
        includeGroupByRegex("com\\.android.*")
        includeGroupByRegex("com\\.google.*")
        includeGroupByRegex("androidx.*")
      }
    }
    mavenCentral()
    gradlePluginPortal()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    google()
    mavenCentral()
  }
}

rootProject.name = "HoldUpBridge"

include(":app")
