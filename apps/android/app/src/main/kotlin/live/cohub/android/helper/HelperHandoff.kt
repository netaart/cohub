package live.cohub.android.helper

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import live.cohub.android.CohubApplication

class HelperHandoff : ContentProvider() {
    override fun onCreate() = true

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method != METHOD || Binder.getCallingUid() != SHELL_UID || extras == null) return null
        val app = context?.applicationContext as? CohubApplication ?: return null
        return app.display?.phone?.attach(extras)
    }

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun getType(uri: Uri): String? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        const val SHELL_UID = 2000
        const val AUTHORITY_SUFFIX = ".helper"
        const val METHOD = "attach"
        const val KEY_NONCE = "nonce"
        const val KEY_HELPER = "helper"
        const val KEY_APP = "app"
    }
}
