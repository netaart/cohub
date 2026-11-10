package live.cohub.android.files

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.MediaStore.MediaColumns
import android.util.Log
import android.webkit.MimeTypeMap
import android.widget.Toast
import androidx.annotation.RequiresApi
import androidx.core.net.toUri
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import live.cohub.android.BuildConfig
import live.cohub.android.R
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.FilterInputStream
import java.io.IOException
import java.io.InputStream
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

class FileSaver(
    private val context: Context,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val accessToken: suspend () -> String?,
) {
    private val saved = ConcurrentHashMap<String, Uri>()

    class Saved(val location: String, val path: String, val uri: Uri)

    suspend fun save(id: String, name: String, mimeType: String?, url: String?, data: String?, progress: (Long, Long?) -> Unit): Saved {
        val result = withContext(Dispatchers.IO) {
            when {
                url != null && data == null -> download(url, name, mimeType, progress)
                data != null && url == null -> Base64.getDecoder().decode(data).inputStream().use { write(name, mimeType, it) }
                else -> throw IllegalArgumentException("files.save requires exactly one of url or data")
            }
        }
        saved[id] = result.uri
        return result
    }

    fun open(id: String): Boolean {
        val uri = saved[id] ?: return false
        val type = context.contentResolver.getType(uri)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, type)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return runCatching { context.startActivity(intent) }.isSuccess
    }

    /** Downloads the page navigated to; nothing on the page reports it, so the shell does. */
    fun saveUrl(url: String, name: String, mimeType: String?) {
        scope.launch {
            val saved = runCatching { withContext(Dispatchers.IO) { download(url, name, mimeType) { _, _ -> } } }
                .onFailure { Log.w(TAG, "Could not save $name", it) }
                .getOrNull()
            withContext(Dispatchers.Main) {
                val message = if (saved != null) {
                    context.getString(R.string.file_saved, saved.path)
                } else {
                    context.getString(R.string.file_save_failed)
                }
                Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private suspend fun download(url: String, name: String, mimeType: String?, progress: (Long, Long?) -> Unit): Saved {
        val request = Request.Builder().url(url).apply {
            // Only the API origin may see the session's token.
            if (sameOrigin(url, BuildConfig.API_ORIGIN)) accessToken()?.let { header("Authorization", "Bearer $it") }
        }.build()
        return http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code} for $url")
            val type = mimeType ?: response.body.contentType()?.let { "${it.type}/${it.subtype}" }
            val total = response.body.contentLength().takeIf { it > 0 }
            response.body.byteStream().use { write(name, type, Counting(it, total, progress)) }
        }
    }

    private fun write(name: String, mimeType: String?, source: InputStream): Saved {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw UnsupportedOperationException("Needs Android 10")
        val fileName = safeFileName(name)
        val type = mimeType?.lowercase()?.substringBefore(';')?.trim()?.takeIf { it.contains('/') }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase())
            ?: GENERIC_TYPE
        val folder = SavedFolder.of(type)
        val target = try {
            folder to insert(folder, fileName, type, source)
        } catch (error: IllegalArgumentException) {
            if (folder == SavedFolder.DOWNLOADS) throw error
            SavedFolder.DOWNLOADS to insert(SavedFolder.DOWNLOADS, fileName, type, source)
        }
        return Saved(target.first.location, target.first.path, target.second)
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun insert(folder: SavedFolder, name: String, mimeType: String, source: InputStream): Uri {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaColumns.DISPLAY_NAME, name)
            put(MediaColumns.MIME_TYPE, mimeType)
            put(MediaColumns.RELATIVE_PATH, folder.path)
            put(MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(folder.collection(), values) ?: throw IOException("MediaStore refused $name")
        try {
            val output = resolver.openOutputStream(uri) ?: throw IOException("Cannot open $uri")
            output.use { source.copyTo(it) }
            resolver.update(uri, ContentValues().apply { put(MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (error: Exception) {
            resolver.delete(uri, null, null)
            throw error
        }
        return uri
    }

    private companion object {
        const val TAG = "CohubFiles"
        const val GENERIC_TYPE = "application/octet-stream"

        fun sameOrigin(url: String, origin: String): Boolean {
            val a = url.toUri()
            val b = origin.toUri()
            return a.scheme == b.scheme && a.host == b.host && a.port == b.port
        }
    }
}

private enum class SavedFolder(directory: String, val location: String) {
    PICTURES(Environment.DIRECTORY_PICTURES, "pictures"),
    MOVIES(Environment.DIRECTORY_MOVIES, "movies"),
    MUSIC(Environment.DIRECTORY_MUSIC, "music"),
    DOWNLOADS(Environment.DIRECTORY_DOWNLOADS, "downloads"),
    ;

    val path = "$directory/Cohub"

    @RequiresApi(Build.VERSION_CODES.Q)
    fun collection(): Uri {
        val volume = MediaStore.VOLUME_EXTERNAL_PRIMARY
        return when (this) {
            PICTURES -> MediaStore.Images.Media.getContentUri(volume)
            MOVIES -> MediaStore.Video.Media.getContentUri(volume)
            MUSIC -> MediaStore.Audio.Media.getContentUri(volume)
            DOWNLOADS -> MediaStore.Downloads.getContentUri(volume)
        }
    }

    companion object {
        fun of(mimeType: String): SavedFolder = when (mimeType.substringBefore('/')) {
            "image" -> PICTURES
            "video" -> MOVIES
            "audio" -> MUSIC
            else -> DOWNLOADS
        }
    }
}

private class Counting(
    source: InputStream,
    private val total: Long?,
    private val progress: (Long, Long?) -> Unit,
) : FilterInputStream(source) {
    private var received = 0L
    private var reportedAt = 0L

    override fun read(): Int = super.read().also { if (it >= 0) count(1) }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
        super.read(buffer, offset, length).also { if (it > 0) count(it.toLong()) }

    private fun count(bytes: Long) {
        received += bytes
        val now = SystemClock.elapsedRealtime()
        if (now - reportedAt < PROGRESS_INTERVAL_MS) return
        reportedAt = now
        progress(received, total)
    }
}

private const val PROGRESS_INTERVAL_MS = 250L

private val UNSAFE_NAME = Regex("""[\\/:*?"<>|\u0000-\u001f]+""")

private fun safeFileName(name: String): String {
    val clean = name.replace(UNSAFE_NAME, "_").trim().trimStart('.').ifEmpty { "download" }
    if (clean.utf8Size() <= MAX_NAME_BYTES) return clean
    val suffix = clean.substringAfterLast('.', "").takeIf { it.length in 1..MAX_EXTENSION_LENGTH }?.let { ".$it" }.orEmpty()
    return clean.removeSuffix(suffix).fitUtf8(MAX_NAME_BYTES - suffix.utf8Size()) + suffix
}

private fun String.utf8Size(): Int = toByteArray(Charsets.UTF_8).size

private fun String.fitUtf8(bytes: Int): String {
    var used = 0
    var end = 0
    while (end < length) {
        val codePoint = codePointAt(end)
        used += when {
            codePoint < 0x80 -> 1
            codePoint < 0x800 -> 2
            codePoint < 0x10000 -> 3
            else -> 4
        }
        if (used > bytes) break
        end += Character.charCount(codePoint)
    }
    return substring(0, end)
}

private const val MAX_NAME_BYTES = 255
private const val MAX_EXTENSION_LENGTH = 16
