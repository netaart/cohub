package live.cohub.android.files

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
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
import java.io.IOException
import java.io.InputStream
import java.util.Base64

class FileSaver(
    private val context: Context,
    private val http: OkHttpClient,
    private val scope: CoroutineScope,
    private val accessToken: suspend () -> String?,
) {
    fun saveUrl(url: String, name: String, mimeType: String?) = save(name) {
        val request = Request.Builder().url(url).apply {
            // Only the API origin may see the session's token.
            if (sameOrigin(url, BuildConfig.API_ORIGIN)) accessToken()?.let { header("Authorization", "Bearer $it") }
        }.build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code} for $url")
            val type = mimeType ?: response.body.contentType()?.let { "${it.type}/${it.subtype}" }
            response.body.byteStream().use { write(name, type, it) }
        }
    }

    fun saveBase64(data: String, name: String, mimeType: String?) = save(name) {
        Base64.getDecoder().decode(data).inputStream().use { write(name, mimeType, it) }
    }

    private fun save(name: String, block: suspend () -> SavedFolder) {
        scope.launch {
            val folder = runCatching { withContext(Dispatchers.IO) { block() } }
                .onFailure { Log.w(TAG, "Could not save $name", it) }
                .getOrNull()
            withContext(Dispatchers.Main) {
                val message = if (folder != null) {
                    context.getString(R.string.file_saved, folder.path)
                } else {
                    context.getString(R.string.file_save_failed)
                }
                Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
            }
        }
    }

    private fun write(name: String, mimeType: String?, source: InputStream): SavedFolder {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw UnsupportedOperationException("Needs Android 10")
        val fileName = safeFileName(name)
        val type = mimeType?.lowercase()?.substringBefore(';')?.trim()?.takeIf { it.contains('/') }
            ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(fileName.substringAfterLast('.', "").lowercase())
            ?: GENERIC_TYPE
        val folder = SavedFolder.of(type)
        return try {
            insert(folder, fileName, type, source)
        } catch (error: IllegalArgumentException) {
            if (folder == SavedFolder.DOWNLOADS) throw error
            insert(SavedFolder.DOWNLOADS, fileName, type, source)
        }
    }

    @RequiresApi(Build.VERSION_CODES.Q)
    private fun insert(folder: SavedFolder, name: String, mimeType: String, source: InputStream): SavedFolder {
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
        return folder
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

private enum class SavedFolder(directory: String) {
    PICTURES(Environment.DIRECTORY_PICTURES),
    MOVIES(Environment.DIRECTORY_MOVIES),
    MUSIC(Environment.DIRECTORY_MUSIC),
    DOWNLOADS(Environment.DIRECTORY_DOWNLOADS),
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
