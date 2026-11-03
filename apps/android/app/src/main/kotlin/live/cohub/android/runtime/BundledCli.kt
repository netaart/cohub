package live.cohub.android.runtime

import android.content.Context
import android.system.Os
import java.io.File
import java.util.zip.ZipInputStream

/** The APK's CLI as `cohub` for what a Runtime runs, installed once per app update. */
class BundledCli(private val context: Context) {
    private val libs = File(context.applicationInfo.nativeLibraryDir)
    private val root = File(context.noBackupFilesDir, "cli")

    private val node = File(libs, "libcohub_node.so")
    private val launcher = File(libs, "libcohub_cli.so")

    val bundled: Boolean
        get() = node.canExecute() && launcher.canExecute()

    /** The directory to put on PATH, or null where the APK carries no Node (x86_64). */
    @Synchronized
    fun bin(): File? {
        if (!bundled) return null
        val stamp = context.packageManager.getPackageInfo(context.packageName, 0).lastUpdateTime.toString()
        val marker = File(root, ".installed")
        if (!marker.isFile || marker.readText() != stamp) install(node, launcher, marker, stamp)
        return File(root, "bin")
    }

    private fun install(node: File, launcher: File, marker: File, stamp: String) {
        root.deleteRecursively()
        val cli = File(root, "cli")
        val base = cli.canonicalPath + File.separator
        ZipInputStream(context.assets.open("cli.zip")).use { zip ->
            generateSequence { zip.nextEntry }.filterNot { it.isDirectory }.forEach { entry ->
                val target = File(cli, entry.name).canonicalFile
                require(target.path.startsWith(base)) { "bad entry ${entry.name}" }
                target.parentFile?.mkdirs()
                target.outputStream().use { zip.copyTo(it) }
            }
        }
        // Apps may not execute their data files; links into nativeLibraryDir they may.
        val bin = File(root, "bin").apply { mkdirs() }
        Os.symlink(launcher.path, File(bin, "cohub").path)
        Os.symlink(node.path, File(bin, "node").path)
        marker.writeText(stamp)
    }
}
