package live.cohub.android.files

import android.content.ActivityNotFoundException
import android.net.Uri
import android.util.Log
import android.webkit.MimeTypeMap
import android.webkit.ValueCallback
import android.webkit.WebChromeClient.FileChooserParams
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.OpenDocument
import androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia

class FileChooser(activity: ComponentActivity) {
    private var pending: ValueCallback<Array<Uri>>? = null

    private val pickMedia = activity.registerForActivityResult(PickVisualMedia()) { deliver(listOfNotNull(it)) }
    private val pickMultipleMedia = activity.registerForActivityResult(PickMultipleVisualMedia()) { deliver(it) }
    private val openDocument = activity.registerForActivityResult(OpenDocument()) { deliver(listOfNotNull(it)) }
    private val openDocuments = activity.registerForActivityResult(OpenMultipleDocuments()) { deliver(it) }

    fun show(callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
        pending?.onReceiveValue(null)
        pending = callback
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        val types = acceptedTypes(params.acceptTypes.orEmpty())
        try {
            when (val media = visualMediaOf(types)) {
                null -> if (multiple) openDocuments.launch(types.toTypedArray()) else openDocument.launch(types.toTypedArray())
                else -> {
                    val request = PickVisualMediaRequest(media)
                    if (multiple) pickMultipleMedia.launch(request) else pickMedia.launch(request)
                }
            }
        } catch (error: ActivityNotFoundException) {
            Log.w(TAG, "No picker for $types", error)
            deliver(emptyList())
        }
        return true
    }

    private fun deliver(uris: List<Uri>) {
        val callback = pending ?: return
        pending = null
        callback.onReceiveValue(uris.takeIf { it.isNotEmpty() }?.toTypedArray())
    }

    private companion object {
        const val TAG = "CohubFiles"
    }
}

private fun acceptedTypes(accept: Array<out String?>): List<String> =
    accept.asSequence()
        .flatMap { it.orEmpty().split(',') }
        .map { it.trim().lowercase() }
        .filter { it.isNotEmpty() }
        .mapNotNull {
            if (it.startsWith('.')) MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.removePrefix(".")) else it
        }
        .distinct()
        .toList()
        .ifEmpty { listOf("*/*") }

private fun visualMediaOf(types: List<String>): PickVisualMedia.VisualMediaType? =
    when (types.map { it.substringBefore('/') }.toSet()) {
        setOf("image") -> PickVisualMedia.ImageOnly
        setOf("video") -> PickVisualMedia.VideoOnly
        setOf("image", "video") -> PickVisualMedia.ImageAndVideo
        else -> null
    }
