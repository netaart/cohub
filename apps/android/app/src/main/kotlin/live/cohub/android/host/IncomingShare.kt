package live.cohub.android.host

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.IntentCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream
import java.util.UUID

class IncomingShare private constructor(
    val id: String,
    private val text: String?,
    private val files: List<SharedFile>,
) {
    private class SharedFile(val uri: Uri, val name: String, val mimeType: String, val size: Long)

    fun toJson(): JsonObject = buildJsonObject {
        put("id", id)
        put("text", text)
        put(
            "files",
            buildJsonArray {
                files.forEach { file ->
                    add(
                        buildJsonObject {
                            put("name", file.name)
                            put("mimeType", file.mimeType)
                            put("size", file.size)
                        },
                    )
                }
            },
        )
    }

    fun readBase64(resolver: ContentResolver, index: Int): String {
        val file = files.getOrNull(index) ?: throw IllegalArgumentException("No shared file at $index")
        require(file.size <= MAX_FILE_BYTES) { "This file is too large to share" }
        val bytes = ByteArrayOutputStream()
        val stream = resolver.openInputStream(file.uri) ?: throw IllegalStateException("The shared file is no longer available")
        stream.use {
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val count = it.read(chunk)
                if (count < 0) break
                bytes.write(chunk, 0, count)
                require(bytes.size() <= MAX_FILE_BYTES) { "This file is too large to share" }
            }
        }
        return Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        const val MAX_FILE_BYTES = 12 * 1024 * 1024
        private const val MAX_FILES = 16

        fun isShare(intent: Intent?): Boolean = intent?.action == Intent.ACTION_SEND || intent?.action == Intent.ACTION_SEND_MULTIPLE

        fun from(intent: Intent, resolver: ContentResolver): IncomingShare? {
            val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
                IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
            } else {
                listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
            }
            val files = uris.filter { it.scheme == ContentResolver.SCHEME_CONTENT }.take(MAX_FILES).map { describe(it, resolver) }
            val text = listOfNotNull(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getStringExtra(Intent.EXTRA_TEXT))
                .filter { it.isNotBlank() }.joinToString("\n").take(MAX_TEXT).ifEmpty { null }
            if (text == null && files.isEmpty()) return null
            return IncomingShare(UUID.randomUUID().toString(), text, files)
        }

        private const val MAX_TEXT = 100_000

        private fun describe(uri: Uri, resolver: ContentResolver): SharedFile {
            var name: String? = null
            var size = 0L
            runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { row ->
                    if (row.moveToFirst()) {
                        name = row.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let(row::getString)
                        size = row.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 }?.let(row::getLong) ?: 0L
                    }
                }
            }
            return SharedFile(uri, name?.take(255)?.ifBlank { null } ?: "shared", resolver.getType(uri) ?: "application/octet-stream", size)
        }
    }
}
