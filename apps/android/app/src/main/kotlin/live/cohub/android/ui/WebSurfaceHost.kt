package live.cohub.android.ui

import android.view.ViewGroup.LayoutParams
import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import live.cohub.android.host.WebSurface

/**
 * Hosts the single WebView. `generation` only advances when a renderer dies,
 * which is the one case where the view cannot be reused.
 */
@Composable
fun WebSurfaceHost(
    onCreate: (WebView, recreate: () -> Unit) -> WebSurface,
    modifier: Modifier = Modifier,
) {
    var surface by remember { mutableStateOf<WebSurface?>(null) }
    var generation by remember { mutableIntStateOf(0) }
    val recreate = remember { { generation += 1 } }
    val context = LocalContext.current
    val padsInsets = remember { !WebSurface.reportsSafeArea(context) }

    key(generation) {
        AndroidView(
            modifier = modifier
                .fillMaxSize()
                .then(if (padsInsets) Modifier.windowInsetsPadding(WindowInsets.safeDrawing) else Modifier),
            factory = { context ->
                WebView(context).also { webView ->
                    // WRAP_CONTENT (the AndroidView default) forces a zero CSS layout height.
                    webView.layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
                    if (padsInsets) {
                        ViewCompat.setOnApplyWindowInsetsListener(webView) { _, _ -> WindowInsetsCompat.CONSUMED }
                    }
                    surface = onCreate(webView, recreate)
                }
            },
            onRelease = { webView -> webView.destroy() },
        )
    }

    // History first, then the system back gesture exits the app.
    BackHandler(enabled = surface?.canGoBack() == true) { surface?.goBack() }
}
