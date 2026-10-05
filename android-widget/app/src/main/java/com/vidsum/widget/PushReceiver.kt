package com.vidsum.widget

import android.content.Context
import android.util.Log
import org.json.JSONObject
import org.unifiedpush.android.connector.MessagingReceiver

/**
 * Instant updates. The ntfy app (the UnifiedPush distributor) hands us a push endpoint, which we
 * give to the server; from then on the server posts the counts there whenever they change, and
 * they arrive here within seconds, even when this app is not running.
 */
class PushReceiver : MessagingReceiver() {

    override fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
        val store = Store(context)
        val pending = goAsync()
        Thread {
            try {
                Api.registerEndpoint(store, endpoint)
                store.pushEndpoint = endpoint
                store.error = ""
            } catch (e: Exception) {
                Log.w(TAG, "Could not register the push endpoint", e)
                store.error = "Instant updates: ${e.message}"
            } finally {
                StatusWidget.render(context)
                MainActivity.notifyChanged(context)
                pending.finish()
            }
        }.start()
    }

    override fun onMessage(context: Context, message: ByteArray, instance: String) {
        val counts = runCatching { JSONObject(String(message)) }.getOrNull() ?: return
        val store = Store(context)
        store.counts = counts
        store.receivedAt = System.currentTimeMillis()
        store.error = ""
        StatusWidget.render(context)
    }

    override fun onUnregistered(context: Context, instance: String) {
        Store(context).pushEndpoint = null
        MainActivity.notifyChanged(context)
    }

    override fun onRegistrationFailed(context: Context, instance: String) {
        Store(context).error = "Instant updates could not be turned on"
        StatusWidget.render(context)
        MainActivity.notifyChanged(context)
    }

    companion object { private const val TAG = "PushReceiver" }
}
