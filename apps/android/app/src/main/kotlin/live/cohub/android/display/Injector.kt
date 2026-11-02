package live.cohub.android.display

import android.content.ClipData
import android.os.Build
import androidx.annotation.RequiresApi
import live.cohub.android.helper.ICohubHelper

internal interface Injector {
    fun touch(action: Int, x: Float, y: Float, downTime: Long)

    fun key(action: Int, code: Int, metaState: Int)

    fun putClip(text: String): ClipData?

    fun restoreClip(previous: ClipData?, text: String)
}

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class HelperInjector(private val helper: ICohubHelper, private val displayId: Int) : Injector {
    override fun touch(action: Int, x: Float, y: Float, downTime: Long) {
        if (!helper.touch(displayId, action, x, y, downTime)) throw DisplayError(DisplayError.FAILED, "the phone refused the touch")
    }

    override fun key(action: Int, code: Int, metaState: Int) {
        if (!helper.key(displayId, action, code, metaState)) throw DisplayError(DisplayError.FAILED, "the phone refused the key")
    }

    override fun putClip(text: String): ClipData? = try {
        helper.putClip(text)
    } catch (error: IllegalStateException) {
        throw DisplayError(DisplayError.FAILED, error.message ?: "the phone refused the clipboard")
    }

    override fun restoreClip(previous: ClipData?, text: String) = helper.restoreClip(previous, text)
}
