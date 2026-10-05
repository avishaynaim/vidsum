package com.vidsum.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import java.text.DateFormat
import java.util.Date

/**
 * The home-screen widget: "▶ running  ⏳ queued  📖 unread" and a second line with today's
 * finished videos, failures and the time of the last update. Tapping it opens the dashboard;
 * the ⟳ corner fetches the counts at once.
 */
class StatusWidget : AppWidgetProvider() {

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context)
        RefreshWorker.schedule(context)
    }

    override fun onEnabled(context: Context) {
        RefreshWorker.schedule(context)
        RefreshWorker.refreshNow(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) RefreshWorker.refreshNow(context)
    }

    companion object {
        const val ACTION_REFRESH = "com.vidsum.widget.REFRESH"

        /** Redraws every placed widget from the stored counts. */
        fun render(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, StatusWidget::class.java))
            if (ids.isEmpty()) return
            val store = Store(context)
            val views = RemoteViews(context.packageName, R.layout.widget_status)
            val c = store.counts
            if (!store.configured) {
                views.setTextViewText(R.id.counts, "YT Summary")
                views.setTextViewText(R.id.detail, "Tap to connect")
            } else if (c == null) {
                views.setTextViewText(R.id.counts, "▶ –   ⏳ –   📖 –")
                views.setTextViewText(R.id.detail, store.error.ifBlank { "Loading…" })
            } else {
                views.setTextViewText(R.id.counts,
                    "▶ ${c.optInt("running")}   ⏳ ${c.optInt("queued")}   📖 ${c.optInt("unread")}")
                val parts = mutableListOf("✓ ${c.optInt("doneToday")} today")
                if (c.optInt("failed") > 0) parts += "⚠ ${c.optInt("failed")} failed"
                if (c.optBoolean("paused")) parts += "⏸ paused"
                parts += if (store.error.isNotBlank()) "offline" else
                    DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(store.receivedAt))
                views.setTextViewText(R.id.detail, parts.joinToString("  ·  "))
            }
            views.setOnClickPendingIntent(R.id.widget_root, openIntent(context, store))
            val refresh = Intent(context, StatusWidget::class.java).setAction(ACTION_REFRESH)
            views.setOnClickPendingIntent(R.id.refresh,
                PendingIntent.getBroadcast(context, 1, refresh, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            manager.updateAppWidget(ids, views)
        }

        /** The dashboard in the browser (already signed in there), or the setup screen. */
        private fun openIntent(context: Context, store: Store): PendingIntent {
            val intent = if (store.configured)
                Intent(Intent.ACTION_VIEW, Uri.parse(store.server!!.trimEnd('/') + "/"))
            else
                Intent(context, MainActivity::class.java)
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
    }
}
