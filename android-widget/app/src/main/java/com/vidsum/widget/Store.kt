package com.vidsum.widget

import android.content.Context
import org.json.JSONObject

/** The server address, the widget's read-only key, and the last counts it received. */
class Store(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("widget", Context.MODE_PRIVATE)

    var server: String?
        get() = prefs.getString("server", null)
        set(value) = prefs.edit().putString("server", value).apply()

    var key: String?
        get() = prefs.getString("key", null)
        set(value) = prefs.edit().putString("key", value).apply()

    /** The push endpoint the ntfy app gave us, once the server has accepted it. */
    var pushEndpoint: String?
        get() = prefs.getString("pushEndpoint", null)
        set(value) = prefs.edit().putString("pushEndpoint", value).apply()

    var counts: JSONObject?
        get() = prefs.getString("counts", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(value) = prefs.edit().putString("counts", value?.toString()).apply()

    /** When the counts were last received, in ms (0 = never). */
    var receivedAt: Long
        get() = prefs.getLong("receivedAt", 0)
        set(value) = prefs.edit().putLong("receivedAt", value).apply()

    /** The last error, shown on the widget's second line ("" = none). */
    var error: String
        get() = prefs.getString("error", "") ?: ""
        set(value) = prefs.edit().putString("error", value).apply()

    val configured: Boolean get() = !server.isNullOrBlank() && !key.isNullOrBlank()
}
