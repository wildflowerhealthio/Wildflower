package expo.modules.localtunnel

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.selects.select
import java.io.InputStream
import java.io.OutputStream
import java.net.ConnectException
import java.net.InetAddress
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
  private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

  companion object {
    private const val TAG = "TunnelConnection"

    // Cap the buffer used to find the end of HTTP headers. If we don't see a
    // CRLFCRLF within this many bytes, we give up parsing/rewriting and stream
    // the bytes through unmodified. 16 KB is well above any reasonable header
    // size and matches the common nginx/Apache default of large_client_header.
    private const val HEADER_BUFFER_MAX_SIZE_BYTES = 16 * 1024

    private const val LOCAL_CONNECT_RETRY_DELAY_MS = 1000L
    private const val LOCAL_CONNECT_MAX_ATTEMPTS = 30 // ~30s total budget
  }

  fun connectRemote() {
    scope.launch {
      val addresses = try {
        InetAddress.getAllByName(config.remoteHost)
      } catch (e: Exception) {
        if (!closed) {
          sendEvent("onConnectionError", mapOf(
            "connectionId" to id,
            "error" to "remote: DNS: ${e.message ?: "resolve failed"}",
            "code" to "EAI_NONAME"
          ))
        }
        return@launch
      }
      if (addresses.isEmpty()) {
        if (!closed) {
          sendEvent("onConnectionError", mapOf(
            "connectionId" to id,
            "error" to "remote: DNS returned no addresses for ${config.remoteHost}",
            "code" to "EAI_NONAME"
          ))
        }
        return@launch
      }
      Log.d(TAG, "remote DNS for ${config.remoteHost} -> ${addresses.joinToString { it.hostAddress ?: "?" }}")

      // Walk every resolved address (RFC 8305 happy-eyeballs in spirit), since
      // Java's Socket.connect(InetSocketAddress) only tries the first match.
      // Hosts like `localtunnel.me` can have multiple A records and the
      // session's data-plane port is only bound on one of them; landing on
      // the wrong IP yields ECONNREFUSED. iOS NWConnection handles this
      // automatically.
      var connected: Socket? = null
      var lastError: Exception? = null
      for (addr in addresses) {
        if (closed) return@launch
        try {
          val s = Socket()
          s.keepAlive = true
          s.connect(InetSocketAddress(addr, config.remotePort), 10000)
          connected = s
          break
        } catch (e: Exception) {
          lastError = e
          Log.w(TAG, "remote connect to ${addr.hostAddress}:${config.remotePort} failed: ${e.message}")
        }
      }

      if (connected == null) {
        if (!closed) {
          val e = lastError
          val code = if (e is ConnectException) "ECONNREFUSED" else "UNKNOWN"
          sendEvent("onConnectionError", mapOf(
            "connectionId" to id,
            "error" to "remote: ${e?.message ?: "all remote addresses unreachable"}",
            "code" to code
          ))
        }
        return@launch
      }
      remoteSocket = connected

      sendEvent("onConnectionOpen", mapOf("connectionId" to id))

      try {
        connectLocalAndPipe()
      } catch (e: Exception) {
        if (!closed) {
          sendEvent("onConnectionError", mapOf(
            "connectionId" to id,
            "error" to (e.message ?: "unknown"),
            "code" to "UNKNOWN"
          ))
        }
      }
    }
  }

  /**
   * Connects to the local server (with up to ~30s of 1s-spaced retries) and
   * pipes bytes between remote and local. Replaces the previous recursive
   * retry to avoid unbounded stack growth on prolonged outages, and matches
   * the iOS retry budget.
   */
  private suspend fun connectLocalAndPipe() {
    val remoteInput = remoteSocket?.getInputStream() ?: return
    val remoteOutput = remoteSocket?.getOutputStream() ?: return

    var local: Socket? = null
    var lastError: Exception? = null
    for (attempt in 1..LOCAL_CONNECT_MAX_ATTEMPTS) {
      if (closed) return
      try {
        val socket = Socket()
        socket.connect(InetSocketAddress(config.localHost, config.localPort), 5000)
        local = socket
        break
      } catch (e: ConnectException) {
        lastError = e
        if (attempt < LOCAL_CONNECT_MAX_ATTEMPTS) {
          delay(LOCAL_CONNECT_RETRY_DELAY_MS)
        }
      } catch (e: Exception) {
        // Non-connect errors (e.g. unknown host, security): don't burn the
        // retry budget on them.
        lastError = e
        break
      }
    }

    if (local == null) {
      if (!closed) {
        val e = lastError
        sendEvent("onConnectionError", mapOf(
          "connectionId" to id,
          "error" to "local: ${e?.message ?: "connect failed"}",
          "code" to if (e is ConnectException) "ECONNREFUSED" else "UNKNOWN"
        ))
        close()
      }
      return
    }
    localSocket = local

    try {
      val localOutput = local.getOutputStream()
      val localInput = local.getInputStream()

      // remote->local: parse/rewrite HTTP request stream (with keep-alive
      // support) before forwarding.
      val remoteToLocal = scope.launch { pumpRemoteToLocal(remoteInput, localOutput) }
      // local->remote: opaque passthrough. We don't inspect responses.
      val localToRemote = scope.launch { relay(localInput, remoteOutput) }

      // Wait for whichever side ends first. If we only joined one (e.g.
      // remoteToLocal) and the other completed first because the local server
      // closed the socket, we'd block forever.
      select<Unit> {
        remoteToLocal.onJoin { }
        localToRemote.onJoin { }
      }
      remoteToLocal.cancel()
      localToRemote.cancel()

      if (!closed) {
        sendEvent("onConnectionClose", mapOf("connectionId" to id))
        close()
      }
    } catch (e: Exception) {
      if (!closed) {
        sendEvent("onConnectionError", mapOf(
          "connectionId" to id,
          "error" to "local: ${e.message ?: "unknown"}",
          "code" to "UNKNOWN"
        ))
        close()
      }
    }
  }

  /**
   * Reads from the remote (public) socket and writes to the local server.
   *
   * Strategy:
   *   1. Buffer bytes until we find CRLFCRLF (end of HTTP request headers).
   *   2. Rewrite the Host header in that buffer (if [config.localHostHeader]
   *      is set), emit onRequest with the request line, and flush to local.
   *   3. Then walk the request stream looking for body framing
   *      (Content-Length / Transfer-Encoding: chunked) so we can locate the
   *      next request line on a keep-alive connection and emit onRequest for
   *      each new request.
   *
   * If anything looks malformed we log and fall back to opaque passthrough —
   * we are a dumb tunnel, not a strict HTTP parser.
   */
  private suspend fun pumpRemoteToLocal(remoteInput: InputStream, localOutput: OutputStream) {
    val readBuf = ByteArray(65536)

    // Pre-headers buffer for the *current* request. Reset between requests on
    // keep-alive connections.
    var headerBuf = ByteArray(0)
    var passthrough = false

    // When parsing has located a body, count it down so we know when the next
    // request starts. -1 means "not yet known".
    var bodyRemaining = 0L
    // Chunked-body state for the current request.
    var inChunked = false
    var chunkRemaining = 0L
    // ChunkState: reading size line vs reading chunk data vs reading trailer.
    var chunkState = ChunkState.SIZE_LINE
    var chunkLineBuf = StringBuilder()

    // After we finish a request body, we look for the next request line in
    // the residual bytes already received. Anything past the body belongs to
    // the next request's headers.
    var awaitingNextRequest = false

    try {
      while (!closed) {
        val bytesRead = remoteInput.read(readBuf)
        if (bytesRead <= 0) {
          if (!closed) sendEvent("onConnectionDead", mapOf("connectionId" to id))
          break
        }

        if (passthrough) {
          localOutput.write(readBuf, 0, bytesRead)
          localOutput.flush()
          continue
        }

        // Slice out the chunk we just received as a working buffer that we
        // will progressively drain into either: header parsing, body
        // counting, or the next request's header buffer.
        var chunk = readBuf.copyOf(bytesRead)

        // Loop: a single read() may contain the tail of the current request
        // body AND the start of the next request, so we keep processing the
        // chunk in stages until empty.
        while (chunk.isNotEmpty() && !closed) {
          if (awaitingNextRequest) {
            // Start collecting headers for the next request.
            headerBuf = ByteArray(0)
            awaitingNextRequest = false
          }

          if (bodyRemaining > 0L) {
            // Still draining a Content-Length body.
            val take = minOf(bodyRemaining, chunk.size.toLong()).toInt()
            localOutput.write(chunk, 0, take)
            localOutput.flush()
            bodyRemaining -= take
            chunk = chunk.copyOfRange(take, chunk.size)
            if (bodyRemaining == 0L) {
              awaitingNextRequest = true
            }
            continue
          }

          if (inChunked) {
            // Drain chunked body. We byte-walk the encoding so we can locate
            // the terminator (0\r\n\r\n) and any trailing headers.
            val consumed = consumeChunked(
              chunk,
              localOutput,
              stateRef = ChunkedState(chunkState, chunkRemaining, chunkLineBuf)
            )
            chunkState = consumed.state
            chunkRemaining = consumed.remaining
            chunkLineBuf = consumed.lineBuf
            chunk = chunk.copyOfRange(consumed.consumed, chunk.size)
            if (consumed.finished) {
              inChunked = false
              chunkState = ChunkState.SIZE_LINE
              chunkRemaining = 0
              chunkLineBuf = StringBuilder()
              awaitingNextRequest = true
            }
            continue
          }

          // Otherwise: building up the next request's headers.
          headerBuf = headerBuf + chunk
          chunk = ByteArray(0)

          val headerEnd = indexOfCrLfCrLf(headerBuf)
          if (headerEnd < 0) {
            if (headerBuf.size >= HEADER_BUFFER_MAX_SIZE_BYTES) {
              Log.w(TAG, "Header buffer cap reached without CRLFCRLF; falling back to passthrough for connection $id")
              localOutput.write(headerBuf)
              localOutput.flush()
              passthrough = true
            }
            // else: keep buffering on the next read.
            break
          }

          // We have full headers in headerBuf[0 .. headerEnd+4).
          val headersEndExclusive = headerEnd + 4
          val headerBytes = headerBuf.copyOfRange(0, headersEndExclusive)
          val leftover = headerBuf.copyOfRange(headersEndExclusive, headerBuf.size)

          val parsed = parseRequestHeaders(headerBytes)
          if (parsed != null) {
            sendEvent("onRequest", mapOf(
              "connectionId" to id,
              "method" to parsed.method,
              "path" to parsed.path
            ))

            val rewritten = rewriteHostHeader(headerBytes)
            localOutput.write(rewritten)
            localOutput.flush()

            when {
              parsed.contentLength != null && parsed.contentLength > 0 -> {
                bodyRemaining = parsed.contentLength
              }
              parsed.chunked -> {
                inChunked = true
                chunkState = ChunkState.SIZE_LINE
                chunkRemaining = 0
                chunkLineBuf = StringBuilder()
              }
              else -> {
                // No body — next request can start immediately.
                awaitingNextRequest = true
              }
            }
          } else {
            Log.w(TAG, "Failed to parse request headers for connection $id; falling back to passthrough")
            localOutput.write(headerBytes)
            localOutput.flush()
            passthrough = true
          }

          // Continue draining `leftover` (which may contain body bytes and/or
          // the next request) in the inner loop.
          headerBuf = ByteArray(0)
          chunk = leftover
        }
      }
    } catch (_: Exception) {
      // Socket closed or broken pipe — expected during teardown.
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
      // Socket closed or broken pipe — expected during teardown.
    }
  }

  // ---------- HTTP parsing helpers ----------

  private data class ParsedHeaders(
    val method: String,
    val path: String,
    val contentLength: Long?,
    val chunked: Boolean
  )

  private fun parseRequestHeaders(headerBytes: ByteArray): ParsedHeaders? {
    val text = String(headerBytes, Charsets.ISO_8859_1)
    val lines = text.split("\r\n")
    if (lines.isEmpty()) return null
    val requestLine = lines[0]
    val parts = requestLine.split(' ')
    if (parts.size < 2) return null
    val method = parts[0]
    val path = parts[1]
    if (method.isEmpty() || path.isEmpty()) return null

    var contentLength: Long? = null
    var chunked = false
    for (i in 1 until lines.size) {
      val line = lines[i]
      if (line.isEmpty()) break
      val colon = line.indexOf(':')
      if (colon < 0) continue
      val name = line.substring(0, colon).trim().lowercase()
      val value = line.substring(colon + 1).trim()
      when (name) {
        "content-length" -> contentLength = value.toLongOrNull()
        "transfer-encoding" -> if (value.lowercase().contains("chunked")) chunked = true
      }
    }
    return ParsedHeaders(method, path, contentLength, chunked)
  }

  private fun rewriteHostHeader(headerBytes: ByteArray): ByteArray {
    val replacement = config.localHostHeader ?: return headerBytes
    val text = String(headerBytes, Charsets.ISO_8859_1)
    val regex = Regex("(\\r\\n[Hh]ost:[ \\t]*)\\S+")
    val match = regex.find(text) ?: return headerBytes
    val rewritten = text.substring(0, match.range.first) +
      match.groupValues[1] + replacement +
      text.substring(match.range.last + 1)
    return rewritten.toByteArray(Charsets.ISO_8859_1)
  }

  private fun indexOfCrLfCrLf(buf: ByteArray): Int {
    if (buf.size < 4) return -1
    for (i in 0..(buf.size - 4)) {
      if (buf[i] == 0x0D.toByte() && buf[i + 1] == 0x0A.toByte() &&
          buf[i + 2] == 0x0D.toByte() && buf[i + 3] == 0x0A.toByte()) {
        return i
      }
    }
    return -1
  }

  // ---------- Chunked-encoding walker ----------

  private enum class ChunkState { SIZE_LINE, DATA, DATA_CRLF, TRAILER }

  private data class ChunkedState(
    val state: ChunkState,
    val remaining: Long,
    val lineBuf: StringBuilder
  )

  private data class ChunkedConsumeResult(
    val consumed: Int,
    val finished: Boolean,
    val state: ChunkState,
    val remaining: Long,
    val lineBuf: StringBuilder
  )

  /**
   * Consumes as much of [chunk] as needed to advance chunked-encoding state,
   * writing every consumed byte through to [output] (we don't strip the
   * encoding — we just need to know where the body ends).
   *
   * Returns how many bytes were consumed and whether the terminating
   * 0-size chunk + trailer block was reached.
   */
  private fun consumeChunked(
    chunk: ByteArray,
    output: OutputStream,
    stateRef: ChunkedState
  ): ChunkedConsumeResult {
    var state = stateRef.state
    var remaining = stateRef.remaining
    var lineBuf = stateRef.lineBuf
    var i = 0
    var finished = false
    var trailerCrlfCount = 0

    while (i < chunk.size && !finished) {
      when (state) {
        ChunkState.SIZE_LINE -> {
          val b = chunk[i]
          output.write(b.toInt())
          i++
          if (b == 0x0A.toByte()) {
            // End of size line. Parse hex size from lineBuf.
            val line = lineBuf.toString().trim()
            lineBuf = StringBuilder()
            // Strip any chunk extensions (after ';').
            val sizeStr = line.substringBefore(';').trim()
            val size = sizeStr.toLongOrNull(16) ?: 0L
            if (size == 0L) {
              state = ChunkState.TRAILER
              trailerCrlfCount = 1 // we just consumed the LF that follows "0"
            } else {
              remaining = size
              state = ChunkState.DATA
            }
          } else if (b != 0x0D.toByte()) {
            lineBuf.append((b.toInt() and 0xFF).toChar())
          }
        }
        ChunkState.DATA -> {
          val take = minOf(remaining, (chunk.size - i).toLong()).toInt()
          output.write(chunk, i, take)
          i += take
          remaining -= take
          if (remaining == 0L) {
            state = ChunkState.DATA_CRLF
          }
        }
        ChunkState.DATA_CRLF -> {
          // Two bytes (CRLF) follow each chunk's data. We pass them through
          // and don't validate strictly — middleboxes vary.
          val b = chunk[i]
          output.write(b.toInt())
          i++
          if (b == 0x0A.toByte()) {
            state = ChunkState.SIZE_LINE
          }
        }
        ChunkState.TRAILER -> {
          // After the "0\r\n" we look for an empty line (CRLF) optionally
          // preceded by trailer headers each ending with CRLF. Terminator is
          // CRLFCRLF; we already consumed the LF after "0" so we need one
          // more CRLF immediately, OR trailer lines followed by CRLF.
          val b = chunk[i]
          output.write(b.toInt())
          i++
          when (b) {
            0x0D.toByte() -> { /* wait for LF */ }
            0x0A.toByte() -> {
              trailerCrlfCount += 1
              if (trailerCrlfCount >= 2) {
                finished = true
              }
            }
            else -> {
              // Any byte that isn't CR/LF means we're inside a trailer header
              // line; reset the count until we hit the next blank line.
              trailerCrlfCount = 0
            }
          }
        }
      }
    }
    output.flush()
    return ChunkedConsumeResult(i, finished, state, remaining, lineBuf)
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
