/*
 * Adapted from scrcpy (https://github.com/Genymobile/scrcpy):
 *   Copyright (C) 2018 Genymobile
 *   Copyright (C) 2018-2024 Romain Vimont
 * Licensed under the Apache License, Version 2.0.
 */
package live.cohub.android.helper

import android.annotation.SuppressLint
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import androidx.annotation.RequiresApi

@RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
internal class ShellContext private constructor(base: Context) : ContextWrapper(base) {
    override fun getPackageName(): String = PACKAGE
    override fun getOpPackageName(): String = PACKAGE
    override fun getAttributionSource(): AttributionSource = AttributionSource.Builder(UID).setPackageName(PACKAGE).build()
    override fun getApplicationContext(): Context = this

    companion object {
        const val PACKAGE = "com.android.shell"
        const val UID = HelperHandoff.SHELL_UID

        @SuppressLint("PrivateApi", "DiscouragedPrivateApi", "BlockedPrivateApi", "SoonBlockedPrivateApi")
        fun create(): Context {
            val type = Class.forName("android.app.ActivityThread")
            val thread = type.getMethod("currentActivityThread").invoke(null) ?: type.getDeclaredConstructor().apply { isAccessible = true }.newInstance().also {
                type.getDeclaredField("sCurrentActivityThread").apply { isAccessible = true }.set(null, it)
                type.getDeclaredField("mSystemThread").apply { isAccessible = true }.setBoolean(it, true)
                val controller = Class.forName("android.app.ConfigurationController")
                    .getDeclaredConstructor(Class.forName("android.app.ActivityThreadInternal"))
                    .apply { isAccessible = true }.newInstance(it)
                type.getDeclaredField("mConfigurationController").apply { isAccessible = true }.set(it, controller)
            }
            return ShellContext(type.getDeclaredMethod("getSystemContext").invoke(thread) as Context)
        }
    }
}
