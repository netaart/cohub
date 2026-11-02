package live.cohub.android.helper

import android.annotation.SuppressLint
import android.content.AttributionSource
import android.content.pm.ProviderInfo
import android.os.Binder
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.Process
import android.util.Log
import androidx.annotation.RequiresApi
import kotlin.system.exitProcess

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
object HelperMain {
    @JvmStatic
    @Suppress("DEPRECATION")
    fun main(args: Array<String>) {
        val (appPackage, uid, nonce) = args.takeIf { it.size == 3 } ?: exitProcess(2)
        val appUid = uid.toIntOrNull() ?: exitProcess(2)
        Looper.prepareMainLooper()
        val helper = Helper(appUid, appPackage)
        val app = handOff(appPackage, appUid, nonce, helper) ?: run {
            Log.w(Helper.TAG, "the app refused the helper")
            exitProcess(1)
        }
        try {
            app.linkToDeath({
                helper.releaseAll()
                exitProcess(0)
            }, 0)
        } catch (_: Exception) {
            helper.releaseAll()
            exitProcess(0)
        }
        Log.i(Helper.TAG, "helping $appPackage")
        Looper.loop()
    }

    @SuppressLint("PrivateApi")
    private fun handOff(appPackage: String, appUid: Int, nonce: String, helper: Helper): IBinder? = runCatching {
        val authority = "$appPackage${HelperHandoff.AUTHORITY_SUFFIX}"
        val manager = Class.forName("android.app.ActivityManager").getMethod("getService").invoke(null)!!
        val holder = manager.javaClass.getMethod(
            "getContentProviderExternal", String::class.java, Int::class.javaPrimitiveType, IBinder::class.java, String::class.java,
        ).invoke(manager, authority, appUid / PER_USER, Binder(), Helper.TAG) ?: return null
        val info = holder.javaClass.getField("info").get(holder) as ProviderInfo
        if (info.packageName != appPackage || info.applicationInfo.uid != appUid) return null
        val provider = holder.javaClass.getField("provider").get(holder)!!
        val call = provider.javaClass.methods.first { it.name == "call" && it.parameterTypes.size == 5 && it.parameterTypes[0] == AttributionSource::class.java }
        val extras = Bundle().apply {
            putString(HelperHandoff.KEY_NONCE, nonce)
            putBinder(HelperHandoff.KEY_HELPER, helper)
        }
        val caller = AttributionSource.Builder(Process.myUid()).setPackageName(ShellContext.PACKAGE).build()
        (call.invoke(provider, caller, authority, HelperHandoff.METHOD, null, extras) as Bundle?)?.getBinder(HelperHandoff.KEY_APP)
    }.onFailure { Log.w(Helper.TAG, "the app did not take the helper", it) }.getOrNull()

    private const val PER_USER = 100_000
}
