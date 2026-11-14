package app.holdup.bridge

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element

class ManifestContractTest {

  private fun resolveManifest(dir: File = File(System.getProperty("user.dir") ?: ".")): File =
      listOf("src/main/AndroidManifest.xml", "app/src/main/AndroidManifest.xml", "android-dat/app/src/main/AndroidManifest.xml")
          .map { File(dir, it) }
          .firstOrNull { it.isFile } ?: error("Manifest not found from ${dir.absolutePath}")

  private fun parseManifest(): Document =
      DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(resolveManifest())

  private fun Element.children(tag: String): List<Element> =
      getElementsByTagName(tag).let { list -> (0 until list.length).mapNotNull { list.item(it) as? Element } }

  private fun Element.androidAttr(localName: String): String =
      getAttributeNS(lookupNamespaceURI("android"), localName)

  @Test
  fun resolvesManifestFromModuleProjectAndRepoRoot() {
    val manifest = resolveManifest().canonicalFile
    val appDir = checkNotNull(manifest.parentFile?.parentFile?.parentFile)
    val projectDir = checkNotNull(appDir.parentFile)
    val repoDir = checkNotNull(projectDir.parentFile)
    assertEquals(manifest, resolveManifest(appDir).canonicalFile)
    assertEquals(manifest, resolveManifest(projectDir).canonicalFile)
    assertEquals(manifest, resolveManifest(repoDir).canonicalFile)
  }

  @Test
  fun declaresRequiredPermissionsWithoutPhoneCamera() {
    val declared = parseManifest().documentElement.children("uses-permission").map { it.androidAttr("name") }.toSet()
    val required =
        setOf(
            "android.permission.BLUETOOTH",
            "android.permission.BLUETOOTH_CONNECT",
            "android.permission.INTERNET",
            "android.permission.FOREGROUND_SERVICE",
            "android.permission.FOREGROUND_SERVICE_CONNECTED_DEVICE",
            "android.permission.WAKE_LOCK",
            "android.permission.POST_NOTIFICATIONS",
        )
    assertTrue("Missing permissions: ${required - declared}", declared.containsAll(required))
    assertFalse(declared.contains("android.permission.CAMERA"))
  }

  @Test
  fun applicationDisablesBackupAndUsesDatPlaceholders() {
    val app = parseManifest().documentElement.children("application").single()
    assertEquals("false", app.androidAttr("allowBackup"))
    val meta = app.children("meta-data").associate { it.androidAttr("name") to it.androidAttr("value") }
    assertEquals("\${mwdat_application_id}", meta["com.meta.wearable.mwdat.APPLICATION_ID"])
    assertEquals("\${mwdat_client_token}", meta["com.meta.wearable.mwdat.CLIENT_TOKEN"])
    assertEquals("true", meta["com.meta.wearable.mwdat.ANALYTICS_OPT_OUT"])
  }

  @Test
  fun mainActivityDeclaresHoldUpBridgeDeepLink() {
    val activity = parseManifest().documentElement.children("activity").firstOrNull { it.androidAttr("name") == ".MainActivity" }
    assertNotNull(activity)
    val deepLinkFound =
        activity!!.children("intent-filter").any { filter ->
          val actions = filter.children("action").map { it.androidAttr("name") }
          val cats = filter.children("category").map { it.androidAttr("name") }
          val schemes = filter.children("data").map { it.androidAttr("scheme") }
          "android.intent.action.VIEW" in actions &&
              "android.intent.category.BROWSABLE" in cats &&
              "android.intent.category.DEFAULT" in cats &&
              "holdupbridge" in schemes
        }
    assertTrue(deepLinkFound)
  }

  @Test
  fun streamingServiceIsUnexportedConnectedDeviceForegroundService() {
    val service = parseManifest().documentElement.children("service").firstOrNull { it.androidAttr("name") == ".StreamingService" }
    assertNotNull(service)
    assertEquals("false", service!!.androidAttr("exported"))
    assertEquals("connectedDevice", service.androidAttr("foregroundServiceType"))
  }
}
