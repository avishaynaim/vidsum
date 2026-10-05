package com.vidsum.widget

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import org.unifiedpush.android.connector.UnifiedPush

/**
 * Setup screen. The dashboard's "Connect the Android widget" link opens it as
 * ytsummary://setup?server=<dashboard address>&key=<widget key>; it then turns on instant
 * updates through the ntfy app.
 */
class MainActivity : Activity() {

    private lateinit var store: Store
    private val changed = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) = show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = Store(this)
        findViewById<Button>(R.id.push).setOnClickListener { turnOnPush() }
        findViewById<Button>(R.id.refresh_now).setOnClickListener {
            RefreshWorker.refreshNow(this)
            Toast.makeText(this, "Refreshing…", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.open_dashboard).setOnClickListener {
            store.server?.let { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it.trimEnd('/') + "/"))) }
        }
        handleLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        val filter = IntentFilter(ACTION_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(changed, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(changed, filter)
        show()
    }

    override fun onPause() {
        super.onPause()
        unregisterReceiver(changed)
    }

    private fun handleLink(intent: Intent?) {
        val data = intent?.data ?: return
        if (data.scheme != "ytsummary" || data.host != "setup") return
        val server = data.getQueryParameter("server")
        val key = data.getQueryParameter("key")
        if (server.isNullOrBlank() || key.isNullOrBlank() || !server.startsWith("https://")) {
            Toast.makeText(this, "This link is incomplete; open it again from the dashboard.", Toast.LENGTH_LONG).show()
            return
        }
        store.server = server
        store.key = key
        store.counts = null
        store.error = ""
        RefreshWorker.schedule(this)
        RefreshWorker.refreshNow(this)
        Toast.makeText(this, "Connected to the dashboard", Toast.LENGTH_SHORT).show()
        turnOnPush()
    }

    private fun turnOnPush() {
        if (!store.configured) { show(); return }
        val distributors = UnifiedPush.getDistributors(this)
        val distributor = distributors.firstOrNull { it == NTFY } ?: distributors.firstOrNull()
        if (distributor == null) {
            Toast.makeText(this, "Install the free ntfy app first, then come back here.", Toast.LENGTH_LONG).show()
            try {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$NTFY")))
            } catch (e: ActivityNotFoundException) {
                startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=$NTFY")))
            }
            return
        }
        UnifiedPush.saveDistributor(this, distributor)
        UnifiedPush.registerApp(this)
        Toast.makeText(this, "Turning on instant updates…", Toast.LENGTH_SHORT).show()
    }

    private fun show() {
        val state = findViewById<TextView>(R.id.state)
        val c = store.counts
        state.text = buildString {
            if (!store.configured) {
                append("Not connected yet.\n\nOn this phone, open the YT Summary dashboard (the https link), ")
                append("go to the Remote server panel and tap \"Connect the Android widget\".")
                return@buildString
            }
            append("Connected to ${Uri.parse(store.server).host}\n")
            append(if (store.pushEndpoint != null) "Instant updates: on ✓\n" else "Instant updates: off (needs the ntfy app)\n")
            if (c != null) append("\n▶ ${c.optInt("running")} running   ⏳ ${c.optInt("queued")} queued   📖 ${c.optInt("unread")} unread\n✓ ${c.optInt("doneToday")} done today   ⚠ ${c.optInt("failed")} failed")
            if (store.error.isNotBlank()) append("\n\nProblem: ${store.error}")
        }
        findViewById<Button>(R.id.push).isEnabled = store.configured && store.pushEndpoint == null
        findViewById<Button>(R.id.refresh_now).isEnabled = store.configured
        findViewById<Button>(R.id.open_dashboard).isEnabled = store.configured
    }

    companion object {
        private const val NTFY = "io.heckel.ntfy"
        private const val ACTION_CHANGED = "com.vidsum.widget.CHANGED"

        /** Lets an open setup screen redraw after a push registration result. */
        fun notifyChanged(context: Context) {
            context.sendBroadcast(Intent(ACTION_CHANGED).setPackage(context.packageName))
        }
    }
}
