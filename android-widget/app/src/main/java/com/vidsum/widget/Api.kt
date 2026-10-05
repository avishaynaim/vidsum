package com.vidsum.widget

import java.net.HttpURLConnection
import java.net.URL
import org.json.JSONObject

/** The two server calls the widget makes (vidsum remote-linux-tailscale/widget.js). */
object Api {
    fun fetchCounts(store: Store): JSONObject {
        val conn = open(store, "/api/widget")
        return conn.use { JSONObject(it.readBody()) }
    }

    fun registerEndpoint(store: Store, endpoint: String) {
        val conn = open(store, "/api/widget/register")
        conn.requestMethod = "POST"
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(JSONObject().put("endpoint", endpoint).toString().toByteArray()) }
        conn.use { it.readBody() }
    }

    private fun open(store: Store, path: String): HttpURLConnection {
        val server = store.server ?: error("Not connected yet")
        val conn = URL(server.trimEnd('/') + path).openConnection() as HttpURLConnection
        conn.connectTimeout = 15_000
        conn.readTimeout = 20_000
        conn.setRequestProperty("X-Widget-Key", store.key ?: "")
        conn.setRequestProperty("Accept", "application/json")
        return conn
    }

    private fun HttpURLConnection.readBody(): String {
        val code = responseCode
        val stream = if (code in 200..299) inputStream else errorStream
        val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
        if (code !in 200..299) {
            val message = runCatching { JSONObject(text).optString("error") }.getOrNull()
            error(if (message.isNullOrBlank()) "Server answered $code" else message)
        }
        return text
    }

    private inline fun <T> HttpURLConnection.use(block: (HttpURLConnection) -> T): T =
        try { block(this) } finally { disconnect() }
}
