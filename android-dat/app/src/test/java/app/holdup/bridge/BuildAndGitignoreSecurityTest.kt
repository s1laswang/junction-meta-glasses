package app.holdup.bridge

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BuildAndGitignoreSecurityTest {

  private fun resolveRepoFile(relFromRepoRoot: String, dir: File = File(System.getProperty("user.dir") ?: ".")): File {
    var cur: File? = dir.canonicalFile
    repeat(5) {
      val candidate = cur?.let { File(it, relFromRepoRoot) }
      if (candidate != null && candidate.isFile) return candidate
      cur = cur?.parentFile
    }
    error("Repo file $relFromRepoRoot not found from ${dir.absolutePath}")
  }

  @Test
  fun appBuildGradleEnforcesNamespaceSdkLevelsAndZeroDefaultDatTokens() {
    val src = resolveRepoFile("android-dat/app/build.gradle.kts").readText()
    assertTrue(src.contains("namespace = \"app.holdup.bridge\""))
    assertTrue(src.contains("applicationId = \"app.holdup.bridge\""))
    assertTrue(src.contains("minSdk = 31"))
    assertTrue(src.contains("targetSdk = 36"))
    assertTrue(src.contains("compileSdk = 36"))
    assertTrue(src.contains("JvmTarget.JVM_17"))
    assertTrue(src.contains("localProperties.getProperty(\"mwdat_application_id\", \"0\")"))
    assertTrue(src.contains("localProperties.getProperty(\"mwdat_client_token\", \"0\")"))
    assertTrue(src.contains("libs.mwdat.core"))
    assertTrue(src.contains("libs.mwdat.camera"))
  }

  @Test
  fun versionCatalogPinsDatSdkOneZeroOneAndKotlinTwoTwo() {
    val toml = resolveRepoFile("android-dat/gradle/libs.versions.toml").readText()
    assertTrue(toml.contains("mwdat = \"1.0.1\""))
    assertTrue(toml.contains("kotlin = \"2.2.21\""))
    assertTrue(toml.contains("group = \"com.meta.wearable\""))
    assertTrue(toml.contains("name = \"mwdat-core\""))
    assertTrue(toml.contains("name = \"mwdat-camera\""))
  }

  @Test
  fun settingsGradleUsesMavenCentralWithoutHardcodedCredentials() {
    val settings = resolveRepoFile("android-dat/settings.gradle.kts").readText()
    assertTrue(settings.contains("mavenCentral()"))
    assertTrue(settings.contains("google()"))
    assertFalse(settings.contains("ghp_"))
    assertFalse(settings.contains("github_pat_"))
    assertFalse(settings.contains("AIza"))
  }

  @Test
  fun rootGitignoreProtectsSecretsAndLocalAndroidProperties() {
    val gitignore = resolveRepoFile(".gitignore").readText().lines().map { it.trim() }.toSet()
    assertTrue(gitignore.contains(".env"))
    assertTrue(gitignore.contains(".env.*"))
    assertTrue(gitignore.contains("android-dat/local.properties"))
    assertTrue(gitignore.contains("android-dat/.gradle/"))
    assertTrue(gitignore.contains("android-dat/**/build/"))
  }
}
