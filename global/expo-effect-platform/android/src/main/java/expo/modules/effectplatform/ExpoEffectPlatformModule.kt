package expo.modules.effectplatform

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.cio.*
import io.ktor.server.engine.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.utils.io.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import java.io.FileOutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume

class ExpoEffectPlatformModule : Module() {
  private var server: EmbeddedServer<*, *>? = null
  private val pendingRequests = ConcurrentHashMap<String, Continuation<ResponseData>>()
  private var bodyDiskThresholdBytes: Long = 10_000_000L

  sealed class ResponseData {
    data class Text(
      val statusCode: Int,
      val headers: Map<String, String>,
      val body: String
    ) : ResponseData()

    data class FileBacked(
      val statusCode: Int,
      val headers: Map<String, String>,
      val filePath: String
    ) : ResponseData()
  }

  class ServerOptions : Record {
    @Field val hostname: String? = null
    @Field val handlerTimeoutSeconds: Double? = null
    @Field val bodyDiskThresholdBytes: Long? = null
  }

  private fun getAllNetworkInterfaces(): Map<String, String> {
    val result = mutableMapOf<String, String>()
    val interfaces = NetworkInterface.getNetworkInterfaces() ?: return result
    for (iface in interfaces) {
      for (addr in iface.inetAddresses) {
        if (!addr.isLoopbackAddress && addr is Inet4Address) {
          addr.hostAddress?.let { result[iface.name] = it }
        }
      }
    }
    return result
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoEffectPlatform")

    Events("onHttpRequest")

    AsyncFunction("startServer") { port: Int, options: ServerOptions? ->
      if (options?.bodyDiskThresholdBytes != null) {
        bodyDiskThresholdBytes = options.bodyDiskThresholdBytes!!
      }
      val handlerTimeoutMs = options?.handlerTimeoutSeconds?.let { (it * 1000).toLong() }

      val host = options?.hostname ?: "0.0.0.0"
      server = embeddedServer(CIO, host = host, port = port) {
        intercept(ApplicationCallPipeline.Call) {
          val requestId = UUID.randomUUID().toString()
          val method = call.request.httpMethod.value
          val uri = call.request.uri
          val headers = call.request.headers.entries()
            .associate { it.key to it.value.joinToString(", ") }
          val ip = call.request.local.remoteAddress

          val contentLength = call.request.contentLength() ?: 0L
          var body: String? = null
          var bodyFilePath: String? = null

          if (contentLength > bodyDiskThresholdBytes) {
            val tempFile = File(appContext.cacheDirectory, "request-$requestId.bin")
            val channel = call.receiveChannel()
            FileOutputStream(tempFile).use { output ->
              val buffer = ByteArray(8192)
              while (!channel.isClosedForRead) {
                val bytesRead = channel.readAvailable(buffer)
                if (bytesRead > 0) {
                  output.write(buffer, 0, bytesRead)
                }
              }
            }
            bodyFilePath = tempFile.absolutePath
          } else {
            body = call.receiveText()
          }

          val timeoutJob = handlerTimeoutMs?.let { ms ->
            launch {
              delay(ms)
              val timedOut = pendingRequests.remove(requestId)
              if (timedOut != null) {
                bodyFilePath?.let { File(it).delete() }
                timedOut.resume(ResponseData.Text(504, emptyMap(), ""))
              }
            }
          }

          val responseData = suspendCancellableCoroutine<ResponseData> { continuation ->
            pendingRequests[requestId] = continuation
            sendEvent(
              "onHttpRequest",
              mapOf(
                "requestId" to requestId,
                "method" to method,
                "path" to uri,
                "headers" to headers,
                "body" to body,
                "bodyFilePath" to bodyFilePath,
                "ip" to ip
              )
            )
          }

          timeoutJob?.cancel()

          // Clean up temp file for request body
          bodyFilePath?.let { File(it).delete() }

          when (responseData) {
            is ResponseData.Text -> {
              for ((key, value) in responseData.headers) {
                call.response.headers.append(key, value, safeOnly = false)
              }
              call.respondBytes(
                bytes = responseData.body.toByteArray(Charsets.UTF_8),
                status = HttpStatusCode(responseData.statusCode, "")
              )
            }
            is ResponseData.FileBacked -> {
              for ((key, value) in responseData.headers) {
                call.response.headers.append(key, value, safeOnly = false)
              }
              val file = File(responseData.filePath)
              call.response.status(HttpStatusCode(responseData.statusCode, ""))
              call.respondFile(file)
            }
          }
        }
      }.start(wait = false)
    }

    AsyncFunction("respondToRequest") {
        requestId: String, statusCode: Int, headers: Map<String, String>, body: String ->
      val continuation = pendingRequests.remove(requestId) ?: return@AsyncFunction
      continuation.resume(ResponseData.Text(statusCode, headers, body))
    }

    AsyncFunction("respondToRequestWithFile") {
        requestId: String, statusCode: Int, headers: Map<String, String>, filePath: String ->
      val continuation = pendingRequests.remove(requestId) ?: return@AsyncFunction
      continuation.resume(ResponseData.FileBacked(statusCode, headers, filePath))
    }

    AsyncFunction("stopServer") { timeoutSeconds: Int ->
      server?.stop(
        gracePeriodMillis = timeoutSeconds * 1000L,
        timeoutMillis = timeoutSeconds * 1000L
      )

      // Resume all pending requests with 503
      val remaining = pendingRequests.entries.toList()
      pendingRequests.clear()
      for ((_, continuation) in remaining) {
        continuation.resume(ResponseData.Text(503, emptyMap(), ""))
      }

      server = null
    }

    Function("getNetworkInterfaces") { getAllNetworkInterfaces() }
  }
}
