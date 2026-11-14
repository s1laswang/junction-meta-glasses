package app.holdup.bridge

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.Node

class StringsParityTest {

  private data class StringEntry(
      val name: String,
      val value: String,
      val translatable: Boolean,
  )

  private fun resolveResDir(dir: File = File(System.getProperty("user.dir") ?: ".")): File =
      listOf("src/main/res", "app/src/main/res", "android-dat/app/src/main/res")
          .map { File(dir, it) }
          .firstOrNull { File(it, "values/strings.xml").isFile }
          ?: error("res directory not found from ${dir.absolutePath}")

  private fun parseXml(file: File): Document =
      DocumentBuilderFactory.newInstance()
          .apply {
            isNamespaceAware = true
            isIgnoringComments = false
          }
          .newDocumentBuilder()
          .parse(file)

  private fun readEntries(file: File): List<StringEntry> {
    assertTrue("Missing strings resource file: ${file.path}", file.isFile)
    val doc = parseXml(file)
    val root = doc.documentElement
    assertEquals("resources", root.tagName)
    val nodes = root.childNodes
    val entries = mutableListOf<StringEntry>()
    for (i in 0 until nodes.length) {
      val node = nodes.item(i)
      if (node.nodeType == Node.ELEMENT_NODE && node is Element && node.tagName == "string") {
        val name = node.getAttribute("name")
        val translatableAttr = node.getAttribute("translatable")
        val translatable = !translatableAttr.equals("false", ignoreCase = true)
        entries.add(StringEntry(name = name, value = node.textContent, translatable = translatable))
      }
    }
    return entries
  }

  private fun readMap(file: File): Map<String, StringEntry> {
    val entries = readEntries(file)
    val seen = mutableSetOf<String>()
    for (entry in entries) {
      assertTrue("Blank string resource name in ${file.path}", entry.name.isNotBlank())
      assertTrue("Blank string resource value for ${entry.name} in ${file.path}", entry.value.isNotBlank())
      assertTrue("Duplicate string resource ${entry.name} in ${file.path}", seen.add(entry.name))
    }
    return entries.associateBy { it.name }
  }

  private fun hasCommentNode(node: Node): Boolean {
    if (node.nodeType == Node.COMMENT_NODE) return true
    val children = node.childNodes
    for (i in 0 until children.length) {
      if (hasCommentNode(children.item(i))) return true
    }
    return false
  }

  private fun formatPlaceholders(text: String): List<String> =
      Regex("%(\\d+\\x24)?[-#+ 0,]*\\d*(\\.\\d+)?[a-zA-Z]")
          .findAll(text)
          .map { it.value }
          .toList()

  @Test
  fun resolvesResDirFromModuleProjectAndRepoRoot() {
    val resDir = resolveResDir().canonicalFile
    val appDir = checkNotNull(resDir.parentFile?.parentFile?.parentFile)
    val projectDir = checkNotNull(appDir.parentFile)
    val repoDir = checkNotNull(projectDir.parentFile)
    assertEquals(resDir, resolveResDir(appDir).canonicalFile)
    assertEquals(resDir, resolveResDir(projectDir).canonicalFile)
    assertEquals(resDir, resolveResDir(repoDir).canonicalFile)
  }

  @Test
  fun defaultFinnishAndSwedishFilesExistWithExactKeyParity() {
    val resDir = resolveResDir()
    val enMap = readMap(File(resDir, "values/strings.xml"))
    val fiMap = readMap(File(resDir, "values-fi/strings.xml"))
    val svMap = readMap(File(resDir, "values-sv/strings.xml"))

    val requiredKeys = enMap.values.filter { it.translatable }.map { it.name }.toSet()
    val expectedCoreKeys =
        setOf(
            "app_name",
            "notification_channel_name",
            "notification_title",
            "notification_body",
        )
    assertTrue("Default strings missing core keys", enMap.keys.containsAll(expectedCoreKeys))
    assertTrue("Finnish missing keys: ${requiredKeys - fiMap.keys}", fiMap.keys.containsAll(requiredKeys))
    assertTrue("Swedish missing keys: ${requiredKeys - svMap.keys}", svMap.keys.containsAll(requiredKeys))
    assertTrue("Finnish has extra keys: ${fiMap.keys - enMap.keys}", enMap.keys.containsAll(fiMap.keys))
    assertTrue("Swedish has extra keys: ${svMap.keys - enMap.keys}", enMap.keys.containsAll(svMap.keys))
  }

  @Test
  fun localizedNotificationCopyTranslatesEnglishAndPreservesBrand() {
    val resDir = resolveResDir()
    val enMap = readMap(File(resDir, "values/strings.xml"))
    val fiMap = readMap(File(resDir, "values-fi/strings.xml"))
    val svMap = readMap(File(resDir, "values-sv/strings.xml"))

    assertEquals("HoldUp Bridge", enMap.getValue("app_name").value)
    assertEquals("HoldUp Bridge", fiMap.getValue("app_name").value)
    assertEquals("HoldUp Bridge", svMap.getValue("app_name").value)

    val notificationKeys =
        listOf(
            "notification_channel_name",
            "notification_title",
            "notification_body",
        )
    for (key in notificationKeys) {
      val enVal = enMap.getValue(key).value
      val fiVal = fiMap.getValue(key).value
      val svVal = svMap.getValue(key).value
      assertNotEquals("Finnish $key should differ from English", enVal, fiVal)
      assertNotEquals("Swedish $key should differ from English", enVal, svVal)
      assertNotEquals("Finnish and Swedish $key should differ", fiVal, svVal)
    }

    assertTrue(fiMap.getValue("notification_title").value.contains("HoldUp"))
    assertTrue(svMap.getValue("notification_title").value.contains("HoldUp"))
    assertTrue(fiMap.getValue("notification_body").value.contains("HoldUp"))
    assertTrue(svMap.getValue("notification_body").value.contains("HoldUp"))
  }

  @Test
  fun placeholdersFormattingAndLocaleXmlHygieneAreConsistent() {
    val resDir = resolveResDir()
    val enFile = File(resDir, "values/strings.xml")
    val fiFile = File(resDir, "values-fi/strings.xml")
    val svFile = File(resDir, "values-sv/strings.xml")

    assertFalse(hasCommentNode(parseXml(fiFile)))
    assertFalse(hasCommentNode(parseXml(svFile)))

    val enMap = readMap(enFile)
    val fiMap = readMap(fiFile)
    val svMap = readMap(svFile)

    for ((key, enEntry) in enMap) {
      val enPlaceholders = formatPlaceholders(enEntry.value)
      fiMap[key]?.let { fiEntry ->
        assertEquals("Placeholder mismatch in fi for $key", enPlaceholders, formatPlaceholders(fiEntry.value))
        assertEquals(fiEntry.value.trim(), fiEntry.value)
        assertFalse(fiEntry.value.contains('\u2014'))
      }
      svMap[key]?.let { svEntry ->
        assertEquals("Placeholder mismatch in sv for $key", enPlaceholders, formatPlaceholders(svEntry.value))
        assertEquals(svEntry.value.trim(), svEntry.value)
        assertFalse(svEntry.value.contains('\u2014'))
      }
    }
  }

  @Test
  fun allManifestAndKotlinStringReferencesExistInEveryLocale() {
    val resDir = resolveResDir().canonicalFile
    val mainDir = checkNotNull(resDir.parentFile)
    val enKeys = readMap(File(resDir, "values/strings.xml")).keys
    val fiKeys = readMap(File(resDir, "values-fi/strings.xml")).keys
    val svKeys = readMap(File(resDir, "values-sv/strings.xml")).keys

    val referenced = mutableSetOf<String>()
    val xmlRefRegex = Regex("@string/([A-Za-z0-9_]+)")
    val ktRefRegex = Regex("R\\.string\\.([A-Za-z0-9_]+)")

    mainDir.walkTopDown().filter { it.isFile }.forEach { file ->
      when (file.extension) {
        "xml" -> {
          val text = file.readText(Charsets.UTF_8)
          xmlRefRegex.findAll(text).forEach { referenced.add(it.groupValues[1]) }
        }
        "kt" -> {
          val text = file.readText(Charsets.UTF_8)
          ktRefRegex.findAll(text).forEach { referenced.add(it.groupValues[1]) }
        }
      }
    }

    assertTrue(referenced.isNotEmpty())
    assertTrue("Undeclared string refs in default: ${referenced - enKeys}", enKeys.containsAll(referenced))
    assertTrue("Missing Finnish translations for referenced keys: ${referenced - fiKeys}", fiKeys.containsAll(referenced))
    assertTrue("Missing Swedish translations for referenced keys: ${referenced - svKeys}", svKeys.containsAll(referenced))
  }
}
