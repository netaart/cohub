package live.cohub.android.host

import android.util.Log
import androidx.annotation.OptIn
import androidx.webkit.PrefetchException
import androidx.webkit.PrefetchNetworkException
import androidx.webkit.Profile
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewOutcomeReceiver
import live.cohub.android.BuildConfig

@OptIn(Profile.ExperimentalUrlPrefetch::class, Profile.ExperimentalPreconnect::class)
object WebWarmup {
    private const val TAG = "CohubWarmup"

    fun prefetch(path: String) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return
        val profile = ProfileStore.getInstance().getProfile(Profile.DEFAULT_PROFILE_NAME) ?: return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.PRECONNECT)) profile.preconnect(BuildConfig.API_ORIGIN)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROFILE_URL_PREFETCH)) return
        val url = WebOrigin.urlOf(path)
        // PrefetchCache, its successor, is not public yet.
        @Suppress("DEPRECATION")
        profile.prefetchUrlAsync(url, null, Runnable::run, Report(url))
    }

    private class Report(private val url: String) : WebViewOutcomeReceiver<Void?, PrefetchException> {
        override fun onResult(result: Void?) {
            if (BuildConfig.WEB_DEBUGGING) Log.d(TAG, "Prefetched $url")
        }

        override fun onError(error: PrefetchException) {
            if (!BuildConfig.WEB_DEBUGGING) return
            val status = (error as? PrefetchNetworkException)?.httpResponseStatusCode
            Log.d(TAG, "Prefetch of $url failed${status?.let { " with HTTP $it" }.orEmpty()}", error)
        }
    }
}
