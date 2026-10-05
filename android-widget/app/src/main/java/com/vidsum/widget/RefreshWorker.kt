package com.vidsum.widget

import android.content.Context
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Fetches the counts from the server. Pushes (PushReceiver) are the normal way the widget
 * updates; this is the backup every 15 minutes (Android's minimum) and the ⟳ button.
 */
class RefreshWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val store = Store(applicationContext)
        if (!store.configured) return@withContext Result.success()
        try {
            store.counts = Api.fetchCounts(store)
            store.receivedAt = System.currentTimeMillis()
            store.error = ""
        } catch (e: Exception) {
            store.error = e.message ?: "Could not reach the server"
        }
        StatusWidget.render(applicationContext)
        Result.success()
    }

    companion object {
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<RefreshWorker>(15, TimeUnit.MINUTES).setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("refresh", ExistingPeriodicWorkPolicy.KEEP, request)
        }

        fun refreshNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(online).build()
            WorkManager.getInstance(context).enqueueUniqueWork("refresh-now", ExistingWorkPolicy.REPLACE, request)
        }
    }
}
