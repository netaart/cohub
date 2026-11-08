package live.cohub.android.media

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import android.webkit.GeolocationPermissions
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts.RequestPermission
import live.cohub.android.host.WebOrigin

class LocationAccess(private val activity: ComponentActivity) {
    private var pending: Pair<String, GeolocationPermissions.Callback>? = null

    private val requestPermission = activity.registerForActivityResult(RequestPermission()) { granted ->
        val (origin, callback) = pending ?: return@registerForActivityResult
        pending = null
        callback.invoke(origin, granted, false)
    }

    fun onPrompt(origin: String, callback: GeolocationPermissions.Callback) {
        if (!WebOrigin.isFirstParty(Uri.parse(origin))) return callback.invoke(origin, false, false)
        if (activity.checkSelfPermission(PERMISSION) == PackageManager.PERMISSION_GRANTED) return callback.invoke(origin, true, false)
        pending?.let { (previous, waiting) -> waiting.invoke(previous, false, false) }
        pending = origin to callback
        requestPermission.launch(PERMISSION)
    }

    fun onHidden() {
        pending = null
    }

    private companion object {
        const val PERMISSION = Manifest.permission.ACCESS_COARSE_LOCATION
    }
}
