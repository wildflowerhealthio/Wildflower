package expo.modules.localtunnel

import kotlinx.coroutines.*
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.Socket

class TunnelConnection(
  val id: String,
  val config: TunnelConnectionConfig,
  val sendEvent: (String, Map<String, Any?>) -> Unit
) {
  private var remoteSocket: Socket? = null
  private var localSocket: Socket? = null
  @Volatile private var closed = false
  private var hostHeaderReplaced = false
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

  fun connectRemote() {
    scope.launch {
      try {
        val socket = Socket()
        socket.keepAlive = true
        socket.connect(InetSocketAddress(config.remoteHost, config.remotePort), 10000)
        remoteSocket = socket

        sendEvent("onConnectionOpen", mapOf("connectionId" to id))

        handleRemoteData()
      } catch (e: Exception) {
        if (!closed) {
          val code = if (e is ConnectException) "ECONNREFUSED" else "UNKNOWN"
          sendEvent("onConnectionError", mapOf(
            "connectionId" to id,
            "error" to (e.message ?: "unknown"),
            "code" to code
          ))
        }
      }
    }
  }

  private suspend fun handleRemoteData() {
    try {
      val input = remoteSocket?.getInputStream() ?: return
      val buffer = ByteArray(65536)

      val bytesRead = input.read(buffer)
      if (bytesRead <= 0) {
        sendEvent("onConnectionDead", mapOf("connectionId" to id))
        close()
        return
      }

      var firstChunk = buffer.copyOf(bytesRead)

      parseAndEmitRequest(firstChunk)
      firstChunk = transformHostHeader(firstChunk)

      connectLocalAndPipe(input, firstChunk)
    } catch (e: Exception) {
      if (!closed) {
        sendEvent("onConnectionError", mapOf(
          "connectionId" to id,
          "error" to (e.message ?: "unknown"),
          "code" to "UNKNOWN"
        ))
        close()
      }
    }
  }

  private suspend fun connectLocalAndPipe(remoteInput: InputStream, firstChunk: ByteArray) {
    try {
      val socket = Socket()
      socket.connect(InetSocketAddress(config.localHost, config.localPort), 5000)
      localSocket = socket

      val localOutput = socket.getOutputStream()
      val localInput = socket.getInputStream()
      val remoteOutput = remoteSocket?.getOutputStream() ?: return

      localOutput.write(firstChunk)
      localOutput.flush()

      val job1 = scope.launch { relay(remoteInput, localOutput) }
      val job2 = scope.launch { relay(localInput, remoteOutput) }

      // When either direction finishes, cancel the other
      try {
        job1.join()
      } finally {
        job2.cancel()
      }

      if (!closed) {
        sendEvent("onConnectionClose", mapOf("connectionId" to id))
        close()
      }
    } catch (e: Exception) {
      if (!closed) {
        if (e is ConnectException) {
          // Retry connection to local server after delay
          delay(1000)
          if (!closed) {
            connectLocalAndPipe(remoteInput, firstChunk)
            return
          }
        }
        sendEvent("onConnectionError", mapOf(
          "connectionId" to id,
          "error" to "local: ${e.message ?: "unknown"}",
          "code" to if (e is ConnectException) "ECONNREFUSED" else "UNKNOWN"
        ))
        close()
      }
    }
  }

  private suspend fun relay(input: InputStream, output: OutputStream) {
    val buffer = ByteArray(65536)
    try {
      while (!closed) {
        val bytesRead = input.read(buffer)
        if (bytesRead <= 0) break
        output.write(buffer, 0, bytesRead)
        output.flush()
      }
    } catch (_: Exception) {
      // Socket closed or broken pipe — expected during teardown
    }
  }

  private fun parseAndEmitRequest(data: ByteArray) {
    val str = String(data, Charsets.UTF_8)
    val match = Regex("^(\\w+) (\\S+)").find(str) ?: return
    sendEvent("onRequest", mapOf(
      "connectionId" to id,
      "method" to match.groupValues[1],
      "path" to match.groupValues[2]
    ))
  }

  private fun transformHostHeader(data: ByteArray): ByteArray {
    val hostHeader = config.localHostHeader ?: return data
    if (hostHeaderReplaced) return data

    val str = String(data, Charsets.UTF_8)
    val regex = Regex("(\\r\\n[Hh]ost: )\\S+")
    if (!regex.containsMatchIn(str)) return data

    hostHeaderReplaced = true
    val match = regex.find(str) ?: return data
    val result = str.substring(0, match.range.first) +
      match.groupValues[1] + hostHeader +
      str.substring(match.range.last + 1)
    return result.toByteArray(Charsets.UTF_8)
  }

  fun close() {
    if (closed) return
    closed = true
    scope.cancel()
    try { remoteSocket?.close() } catch (_: Exception) {}
    try { localSocket?.close() } catch (_: Exception) {}
    remoteSocket = null
    localSocket = null
  }
}
