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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import java.io.FileOutputStream
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.Continuation
import kotlin.coroutines.resume

class ExpoEffectPlatformModule : Module() {
  private var server: EmbeddedServer<*, *>? = null
  private val pendingRequests = ConcurrentHashMap<String, Continuation<ResponseData>>()
  private val pendingBodyFiles = ConcurrentHashMap<String, String>()
  private val inFlightCount = AtomicInteger(0)

  // Defaults overridden by ServerOptions on startServer.
  @Volatile private var bodyDiskThresholdBytes: Long = 10_000_000L
  @Volatile private var maxConcurrentRequests: Int = 256
  @Volatile private var fileSandboxRoots: List<String> = emptyList()

  sealed class ResponseData {
    data class Bytes(
      val statusCode: Int,
      val headers: Map<String, List<String>>,
      val body: ByteArray
    ) : ResponseData()

    data class FileBacked(
      val statusCode: Int,
      val headers: Map<String, List<String>>,
      val filePath: String,
      val start: Long?,
      val end: Long?
    ) : ResponseData()
  }

  class ServerOptions : Record {
    @Field val hostname: String? = null
    @Field val handlerTimeoutSeconds: Double? = null
    @Field val bodyDiskThresholdBytes: Long? = null
    @Field val maxConcurrentRequests: Int? = null
    @Field val fileSandboxRoots: List<String>? = null
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

  private fun defaultSandboxRoots(): List<String> {
    val roots = mutableListOf<String>()
    appContext.cacheDirectory.absolutePath.let { roots.add(it) }
    appContext.reactContext?.filesDir?.absolutePath?.let { roots.add(it) }
    return roots
  }

  /**
   * Resolve a path through symlinks and `..` segments and check whether it
   * lies inside any of `roots`. Symlinks are resolved before comparison so
   * attackers can't smuggle a path out of the sandbox via a symlink.
   */
  private fun isPathInside(candidate: String, roots: List<String>): Boolean {
    val canonical = try {
      File(candidate).canonicalPath
    } catch (_: Exception) {
      return false
    }
    for (root in roots) {
      val canonicalRoot = try {
        File(root).canonicalPath
      } catch (_: Exception) {
        continue
      }
      if (canonical == canonicalRoot) return true
      val prefix = if (canonicalRoot.endsWith(File.separator)) canonicalRoot else canonicalRoot + File.separator
      if (canonical.startsWith(prefix)) return true
    }
    return false
  }

  private fun deleteTempFile(path: String?) {
    if (path != null) try { File(path).delete() } catch (_: Exception) {}
  }

  private fun isLikelyUtf8(bytes: ByteArray): Boolean {
    return try {
      val decoder = Charsets.UTF_8.newDecoder()
      decoder.decode(java.nio.ByteBuffer.wrap(bytes))
      true
    } catch (_: Exception) {
      false
    }
  }

  override fun definition() = ModuleDefinition {
    Name("ExpoEffectPlatform")

    Events("onHttpRequest")

    AsyncFunction("startServer") { port: Int, options: ServerOptions? ->
      // Idempotency guard — refuse if a server is already running.
      if (server != null) {
        throw IllegalStateException("Server already running; call stopServer first")
      }

      options?.bodyDiskThresholdBytes?.let { bodyDiskThresholdBytes = it }
      options?.maxConcurrentRequests?.let { maxConcurrentRequests = it }
      fileSandboxRoots = options?.fileSandboxRoots ?: defaultSandboxRoots()

      val handlerTimeoutMs = options?.handlerTimeoutSeconds?.let { (it * 1000).toLong() }
      val host = options?.hostname ?: "127.0.0.1"
      val cacheDir = appContext.cacheDirectory
      val threshold = bodyDiskThresholdBytes
      val hardCap = maxOf(threshold * 4, threshold + 50_000_000L)

      server = embeddedServer(CIO, host = host, port = port) {
        intercept(ApplicationCallPipeline.Call) {
          // Bound concurrent in-flight requests so a flood can't exhaust memory.
          if (inFlightCount.get() >= maxConcurrentRequests) {
            call.respondBytes(
              bytes = "Server too busy".toByteArray(Charsets.UTF_8),
              status = HttpStatusCode(503, "Service Unavailable")
            )
            return@intercept
          }
          inFlightCount.incrementAndGet()

          val requestId = UUID.randomUUID().toString()
          val method = call.request.httpMethod.value
          val uri = call.request.uri
          val headersOut: Map<String, List<String>> = call.request.headers.entries()
            .associate { it.key to it.value.toList() }
          val ip = call.request.local.remoteAddress

          var bodyText: String? = null
          var bodyBase64: String? = null
          var bodyFilePath: String? = null

          // Stream-and-spill: read in chunks, keep in-memory below the
          // threshold, spill to disk once we cross it. Works for both
          // Content-Length and chunked-transfer requests since we don't
          // trust the header.
          val channel = call.receiveChannel()
          val inMemory = java.io.ByteArrayOutputStream()
          var spilledFile: File? = null
          var spilledOutput: FileOutputStream? = null
          var totalBytes = 0L
          val buffer = ByteArray(8192)

          try {
            while (!channel.isClosedForRead) {
              val bytesRead = channel.readAvailable(buffer)
              if (bytesRead <= 0) break
              totalBytes += bytesRead

              if (totalBytes > hardCap) {
                spilledOutput?.close()
                spilledFile?.delete()
                inFlightCount.decrementAndGet()
                call.respondBytes(
                  bytes = "Request body exceeds maximum size".toByteArray(Charsets.UTF_8),
                  status = HttpStatusCode(413, "Payload Too Large")
                )
                return@intercept
              }

              if (spilledOutput == null) {
                if (inMemory.size() + bytesRead > threshold) {
                  val tempFile = File(cacheDir, "request-$requestId.bin")
                  val out = FileOutputStream(tempFile)
                  inMemory.writeTo(out)
                  out.write(buffer, 0, bytesRead)
                  spilledFile = tempFile
                  spilledOutput = out
                  inMemory.reset()
                } else {
                  inMemory.write(buffer, 0, bytesRead)
                }
              } else {
                spilledOutput.write(buffer, 0, bytesRead)
              }
            }
          } catch (e: Exception) {
            spilledOutput?.close()
            spilledFile?.delete()
            inFlightCount.decrementAndGet()
            call.respondBytes(
              bytes = "Failed to read request body".toByteArray(Charsets.UTF_8),
              status = HttpStatusCode(400, "Bad Request")
            )
            return@intercept
          }
          spilledOutput?.close()

          if (spilledFile != null) {
            bodyFilePath = spilledFile.absolutePath
          } else {
            val bytes = inMemory.toByteArray()
            if (isLikelyUtf8(bytes)) {
              bodyText = String(bytes, Charsets.UTF_8)
            } else {
              bodyBase64 = Base64.getEncoder().encodeToString(bytes)
            }
          }

          val timeoutJob = handlerTimeoutMs?.let { ms ->
            launch {
              delay(ms)
              val timedOut = pendingRequests.remove(requestId)
              if (timedOut != null) {
                deleteTempFile(pendingBodyFiles.remove(requestId))
                inFlightCount.decrementAndGet()
                timedOut.resume(ResponseData.Bytes(504, emptyMap(), ByteArray(0)))
              }
            }
          }

          if (bodyFilePath != null) pendingBodyFiles[requestId] = bodyFilePath

          val responseData = suspendCancellableCoroutine<ResponseData> { continuation ->
            pendingRequests[requestId] = continuation
            sendEvent(
              "onHttpRequest",
              mapOf(
                "requestId" to requestId,
                "method" to method,
                "path" to uri,
                "headers" to headersOut,
                "body" to bodyText,
                "bodyBase64" to bodyBase64,
                "bodyFilePath" to bodyFilePath,
                "ip" to ip
              )
            )
          }

          timeoutJob?.cancel()
          deleteTempFile(pendingBodyFiles.remove(requestId))
          inFlightCount.decrementAndGet()

          when (responseData) {
            is ResponseData.Bytes -> {
              for ((key, values) in responseData.headers) {
                for (v in values) call.response.headers.append(key, v, safeOnly = false)
              }
              call.respondBytes(
                bytes = responseData.body,
                status = HttpStatusCode(responseData.statusCode, "")
              )
            }
            is ResponseData.FileBacked -> {
              if (!isPathInside(responseData.filePath, fileSandboxRoots)) {
                call.respondBytes(
                  bytes = "File path is outside the configured sandbox roots".toByteArray(Charsets.UTF_8),
                  status = HttpStatusCode(403, "Forbidden")
                )
                return@intercept
              }
              for ((key, values) in responseData.headers) {
                for (v in values) call.response.headers.append(key, v, safeOnly = false)
              }
              val file = File(responseData.filePath)
              call.response.status(HttpStatusCode(responseData.statusCode, ""))
              val start = responseData.start
              val end = responseData.end
              if (start != null && end != null) {
                val length = (end - start).coerceAtLeast(0L)
                call.respondBytes(status = HttpStatusCode(responseData.statusCode, "")) {
                  val slice = ByteArray(length.toInt())
                  file.inputStream().use { input ->
                    input.skip(start)
                    var read = 0
                    while (read < slice.size) {
                      val n = input.read(slice, read, slice.size - read)
                      if (n <= 0) break
                      read += n
                    }
                  }
                  slice
                }
              } else {
                call.respondFile(file)
              }
            }
          }
        }
      }.start(wait = false)
    }

    AsyncFunction("respondToRequest") {
        requestId: String,
        statusCode: Int,
        headers: Map<String, List<String>>,
        body: String,
        bodyEncoding: String ->
      val continuation = pendingRequests.remove(requestId) ?: return@AsyncFunction
      val bytes = when (bodyEncoding) {
        "base64" -> Base64.getDecoder().decode(body)
        else -> body.toByteArray(Charsets.UTF_8)
      }
      continuation.resume(ResponseData.Bytes(statusCode, headers, bytes))
    }

    AsyncFunction("respondToRequestWithFile") {
        requestId: String,
        statusCode: Int,
        headers: Map<String, List<String>>,
        filePath: String,
        start: Long?,
        end: Long? ->
      val continuation = pendingRequests.remove(requestId) ?: return@AsyncFunction
      continuation.resume(ResponseData.FileBacked(statusCode, headers, filePath, start, end))
    }

    AsyncFunction("stopServer") { timeoutSeconds: Int ->
      server?.stop(
        gracePeriodMillis = timeoutSeconds * 1000L,
        timeoutMillis = timeoutSeconds * 1000L
      )

      // Resume all pending requests with 503 and clean up any spilled files.
      val remaining = pendingRequests.entries.toList()
      pendingRequests.clear()
      val remainingFiles = pendingBodyFiles.values.toList()
      pendingBodyFiles.clear()
      for ((_, continuation) in remaining) {
        continuation.resume(ResponseData.Bytes(503, emptyMap(), ByteArray(0)))
      }
      for (path in remainingFiles) deleteTempFile(path)
      inFlightCount.set(0)

      server = null
    }

    Function("getNetworkInterfaces") { getAllNetworkInterfaces() }
  }
}
