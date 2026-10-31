package live.cohub.android.runtime

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.ByteArrayInputStream
import java.io.IOException
import java.net.ConnectException
import java.util.concurrent.ConcurrentHashMap

data class LocalEndpoint(val port: Int, val token: String)

class WorkspaceUnavailable(message: String) : Exception(message)

class LocalWorkspaces(private val http: OkHttpClient, private val ready: (String) -> Boolean) {
    private val endpoints = ConcurrentHashMap<String, LocalEndpoint>()

    fun update(spaceId: String, endpoint: LocalEndpoint?) {
        if (endpoint == null) endpoints.remove(spaceId) else endpoints[spaceId] = endpoint
    }

    suspend fun call(spaceId: String, method: String, params: JsonObject): JsonElement = withContext(Dispatchers.IO) {
        require(METHOD.matches(method)) { "Unsupported workspace method: $method" }
        val body = buildJsonObject {
            put("method", method)
            put("params", params)
        }.toString().toRequestBody(JSON)
        val response = send(spaceId) { Request.Builder().url(it.newBuilder().addPathSegment("rpc").build()).post(body) }
        response.use { Json.parseToJsonElement(it.body.string()) }
    }

    fun intercept(request: WebResourceRequest): WebResourceResponse {
        val segments = request.url.pathSegments
        val spaceId = segments.getOrNull(2)
        val path = request.url.getQueryParameter("path")
        // Never as a document: workspace files are untrusted and this path is on the app's origin.
        if (request.isForMainFrame || request.method != "GET" || segments.size != 4 || segments[3] != "files" || spaceId == null || path == null) {
            return error(404, "Not Found", "NOT_FOUND")
        }
        return try {
            val response = send(spaceId) { base ->
                Request.Builder().url(base.newBuilder().addPathSegment("files").addQueryParameter("path", path).build()).get().apply {
                    for ((name, value) in request.requestHeaders) if (FORWARDED.any { it.equals(name, ignoreCase = true) }) header(name, value)
                }
            }
            val headers = PASSED.mapNotNull { name -> response.header(name)?.let { name to it } }.toMap()
            val contentType = response.body.contentType()
            WebResourceResponse(
                contentType?.let { "${it.type}/${it.subtype}" } ?: "application/octet-stream",
                contentType?.charset()?.name(),
                response.code,
                response.message.ifEmpty { if (response.code == 206) "Partial Content" else "OK" },
                headers,
                response.body.byteStream(),
            )
        } catch (_: WorkspaceUnavailable) {
            error(503, "Service Unavailable", "UNAVAILABLE")
        } catch (_: IOException) {
            error(502, "Bad Gateway", "IO_ERROR")
        }
    }

    /** A 401 means a restarted bridge rotated its token: nothing ran, like a refused connection. */
    private fun send(spaceId: String, build: (HttpUrl) -> Request.Builder): okhttp3.Response {
        val endpoint = endpoints[spaceId]?.takeIf { ready(spaceId) } ?: throw WorkspaceUnavailable("This device does not serve that Space")
        val base = HttpUrl.Builder().scheme("http").host("127.0.0.1").port(endpoint.port).build()
        val response = try {
            http.newCall(build(base).header("Authorization", "Bearer ${endpoint.token}").build()).execute()
        } catch (error: ConnectException) {
            throw WorkspaceUnavailable(error.message ?: "Connection refused")
        }
        if (response.code == 401) {
            response.close()
            throw WorkspaceUnavailable("The file bridge restarted")
        }
        return response
    }

    private fun error(code: Int, reason: String, rpcCode: String) = WebResourceResponse(
        "application/json",
        "utf-8",
        code,
        reason,
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(buildJsonObject { putJsonObject("error") { put("code", rpcCode); put("message", reason) } }.toString().toByteArray()),
    )

    companion object {
        const val PATH_PREFIX = "/__cohub/workspace/"
        private val METHOD = Regex("^fs\\.[a-z]+$")
        private val JSON = "application/json".toMediaType()
        // Conditional requests stay out: WebResourceResponse cannot carry a 304.
        private val FORWARDED = listOf("Range", "If-Range")
        private val PASSED = listOf(
            "Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified", "Cache-Control",
            "Content-Security-Policy", "X-Content-Type-Options",
        )
    }
}
