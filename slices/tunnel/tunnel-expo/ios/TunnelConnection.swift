import Foundation
import Network

/// A one-shot, thread-safe "claim" flag. `tryClaim()` returns `true` exactly once;
/// every subsequent call returns `false`. Used to ensure a `CheckedContinuation`
/// is resumed only on the first relevant `NWConnection` state transition, even
/// though `stateUpdateHandler` is `@Sendable`.
private final class ResumeFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var claimed = false

  func tryClaim() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    if claimed { return false }
    claimed = true
    return true
  }
}

class TunnelConnection {
  let id: String
  let config: TunnelConnectionConfig
  let queue: DispatchQueue
  let sendEvent: (String, [String: Any]) -> Void

  // All mutable state below is read/written only from `self.queue`.
  // - NWConnection callbacks fire on `self.queue` (the queue we pass to `start(queue:)`).
  // - `close()` is invoked from `ExpoLocaltunnelModule`'s AsyncFunction / OnDestroy on the
  //   JS dispatch thread, so its body is dispatched onto `self.queue` to keep all access
  //   to `closed` (and the connection refs) serialized through a single queue.
  // This matches the simplicity of Android's `@Volatile closed` flag.
  private var remoteConnection: NWConnection?
  private var localConnection: NWConnection?
  private var closed = false

  // Header-rewrite + keep-alive parser state. All mutated only on `self.queue`.
  private var headerBuffer = Data()
  private var headersDone = false
  private static let maxHeaderBufferBytes = 16 * 1024

  // Stream parser state for keep-alive request boundaries (remote->local stream after
  // headers have been forwarded). When neither `bodyBytesRemaining` nor
  // `chunkedDecoderActive` is set, we are scanning for the next request line.
  private var bodyBytesRemaining: Int = 0
  private var chunkedDecoderActive = false
  private var chunkedState: ChunkedState = .size
  private var chunkedBytesLeftInChunk: Int = 0
  private var chunkedSizeBuffer = ""  // accumulates hex digits if a size line spans reads
  private var requestLineBuffer = Data()
  private var streamParseDisabled = false

  // Local-connect retry state.
  private static let localConnectMaxAttempts = 30
  private static let localConnectRetryIntervalSeconds: Double = 1.0
  private var localConnectAttempts = 0

  private enum ChunkedState {
    case size
    case data
    case afterDataCRLF
    case trailers
  }

  init(
    id: String,
    config: TunnelConnectionConfig,
    queue: DispatchQueue,
    eventSender: @escaping (String, [String: Any]) -> Void
  ) {
    self.id = id
    self.config = config
    self.queue = queue
    self.sendEvent = eventSender
  }

  func connectRemote() async throws {
    guard let port = NWEndpoint.Port(rawValue: UInt16(config.remotePort)) else {
      throw NSError(domain: "ExpoLocaltunnel", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "Invalid remote port: \(config.remotePort)"
      ])
    }

    let host = NWEndpoint.Host(config.remoteHost)
    let params = NWParameters.tcp
    if let tcpOptions = params.defaultProtocolStack.transportProtocol as? NWProtocolTCP.Options {
      tcpOptions.enableKeepalive = true
      tcpOptions.keepaliveIdle = 60
    }

    let connection = NWConnection(host: host, port: port, using: params)
    self.remoteConnection = connection

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let flag = ResumeFlag()

      connection.stateUpdateHandler = { [weak self] state in
        guard let self = self else { return }
        switch state {
        case .ready:
          if flag.tryClaim() {
            self.sendEvent("onConnectionOpen", ["connectionId": self.id])
            self.startRemoteRead()
            continuation.resume()
          }
        case .failed(let error):
          if flag.tryClaim() {
            let code = self.mapErrorCode(error)
            self.sendEvent("onConnectionError", [
              "connectionId": self.id,
              "error": "remote: \(error.localizedDescription)",
              "code": code
            ])
            continuation.resume(throwing: error)
          }
        case .cancelled:
          if flag.tryClaim() {
            continuation.resume(throwing: NSError(
              domain: "ExpoLocaltunnel", code: 2,
              userInfo: [NSLocalizedDescriptionKey: "Connection cancelled"]
            ))
          }
        default:
          break
        }
      }
      connection.start(queue: self.queue)
    }
  }

  /// Reads the first chunk from the remote and starts the local-connect flow.
  /// Subsequent remote->local data is handled by `relayRemoteToLocal` once the local
  /// socket is up.
  private func startRemoteRead() {
    remoteConnection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }

      if let error = error {
        self.handleError(error, side: "remote")
        return
      }

      guard let data = data, !data.isEmpty else {
        if isComplete {
          self.sendEvent("onConnectionDead", ["connectionId": self.id])
          self.closeDetached()
        }
        return
      }

      // Feed the first chunk through the same buffer-until-CRLFCRLF path used by
      // the steady-state relay. If the headers complete in this first chunk we
      // start local-connect immediately with the rewritten bytes; if they don't,
      // we keep buffering on subsequent reads (still pre-local-connect).
      self.ingestRemoteBytesPreLocal(data, isComplete: isComplete)
    }
  }

  /// Pre-local-connect ingestion: accumulate into `headerBuffer` until CRLFCRLF or cap,
  /// then trigger `connectLocalAndPipe` with the (possibly rewritten) buffer.
  private func ingestRemoteBytesPreLocal(_ data: Data, isComplete: Bool) {
    headerBuffer.append(data)

    if let headerEnd = findHeaderEnd(in: headerBuffer) {
      let headersAndMaybeMore = headerBuffer
      headerBuffer = Data()
      let (rewritten, requestInfo, headerLen) = rewriteHostHeader(
        headersAndMaybeMore, headerEndExclusive: headerEnd
      )
      if let info = requestInfo {
        sendEvent("onRequest", [
          "connectionId": id,
          "method": info.method,
          "path": info.path
        ])
      }
      headersDone = true
      // Initialize keep-alive parser state from this request's headers.
      let headerSlice = rewritten.prefix(headerLen)
      configureBodyParser(forHeaders: headerSlice)
      // Anything past the headers is body bytes; advance the body parser through them.
      let bodyTail = rewritten.suffix(from: headerLen)
      // Stash for forwarding after local connects.
      let toForward = rewritten
      connectLocalAndPipe(firstChunk: toForward, bodyTail: Data(bodyTail))
      return
    }

    if headerBuffer.count >= TunnelConnection.maxHeaderBufferBytes {
      // Cap exceeded without finding CRLFCRLF — log and stream as-is without rewrite.
      NSLog("[ExpoLocaltunnel] header buffer exceeded \(TunnelConnection.maxHeaderBufferBytes) bytes without CRLFCRLF; streaming through unmodified")
      let toForward = headerBuffer
      headerBuffer = Data()
      headersDone = true
      streamParseDisabled = true
      connectLocalAndPipe(firstChunk: toForward, bodyTail: Data())
      return
    }

    if isComplete {
      // Remote closed before headers completed — flush whatever we have.
      if !headerBuffer.isEmpty {
        let toForward = headerBuffer
        headerBuffer = Data()
        connectLocalAndPipe(firstChunk: toForward, bodyTail: Data())
      } else {
        sendEvent("onConnectionDead", ["connectionId": id])
        closeDetached()
      }
      return
    }

    // Continue reading more bytes for the header buffer.
    remoteConnection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }
      if let error = error {
        self.handleError(error, side: "remote")
        return
      }
      guard let data = data, !data.isEmpty else {
        if isComplete {
          if !self.headerBuffer.isEmpty {
            let toForward = self.headerBuffer
            self.headerBuffer = Data()
            self.connectLocalAndPipe(firstChunk: toForward, bodyTail: Data())
          } else {
            self.sendEvent("onConnectionDead", ["connectionId": self.id])
            self.closeDetached()
          }
        }
        return
      }
      self.ingestRemoteBytesPreLocal(data, isComplete: isComplete)
    }
  }

  /// Returns the index just past the CRLFCRLF that ends the header block, or nil if not found.
  private func findHeaderEnd(in data: Data) -> Int? {
    let needle: [UInt8] = [0x0D, 0x0A, 0x0D, 0x0A]
    guard data.count >= needle.count else { return nil }
    return data.withUnsafeBytes { (rawBuf: UnsafeRawBufferPointer) -> Int? in
      guard let base = rawBuf.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return nil }
      let n = data.count
      var i = 0
      while i + 4 <= n {
        if base[i] == 0x0D && base[i + 1] == 0x0A && base[i + 2] == 0x0D && base[i + 3] == 0x0A {
          return i + 4
        }
        i += 1
      }
      return nil
    }
  }

  private struct RequestInfo {
    let method: String
    let path: String
  }

  /// Rewrites the Host: header in the header block (bytes [0, headerEndExclusive)) and
  /// returns the resulting Data along with parsed method/path. The byte range past
  /// `headerEndExclusive` is preserved verbatim. The returned `headerLen` is the byte
  /// length of the (possibly modified) header block in the returned Data.
  private func rewriteHostHeader(
    _ data: Data, headerEndExclusive: Int
  ) -> (Data, RequestInfo?, Int) {
    let headerBytes = data.prefix(headerEndExclusive)
    let bodyBytes = data.suffix(from: headerEndExclusive)

    guard var headerStr = String(data: Data(headerBytes), encoding: .utf8) else {
      // Fall back to forwarding unmodified if not valid UTF-8.
      return (data, nil, headerEndExclusive)
    }

    // Parse request line for onRequest emission.
    var requestInfo: RequestInfo? = nil
    if let lineEnd = headerStr.range(of: "\r\n") {
      let requestLine = String(headerStr[..<lineEnd.lowerBound])
      let parts = requestLine.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
      if parts.count >= 2 {
        requestInfo = RequestInfo(method: String(parts[0]), path: String(parts[1]))
      }
    }

    // Optional Host: rewrite.
    if let hostHeader = config.localHostHeader {
      let pattern = "(\\r\\n[Hh]ost: )\\S+"
      if let regex = try? NSRegularExpression(pattern: pattern),
         let match = regex.firstMatch(
           in: headerStr, range: NSRange(headerStr.startIndex..., in: headerStr)
         ),
         let prefixRange = Range(match.range(at: 1), in: headerStr),
         let fullRange = Range(match.range, in: headerStr) {
        headerStr.replaceSubrange(fullRange, with: headerStr[prefixRange] + hostHeader)
      }
    }

    let newHeaderData = headerStr.data(using: .utf8) ?? Data(headerBytes)
    var combined = Data()
    combined.append(newHeaderData)
    combined.append(bodyBytes)
    return (combined, requestInfo, newHeaderData.count)
  }

  /// Inspect the just-parsed headers to decide how to consume the body for the
  /// purposes of finding the next request line. Sets `bodyBytesRemaining` and
  /// `chunkedDecoderActive`.
  private func configureBodyParser(forHeaders headerData: Data) {
    bodyBytesRemaining = 0
    chunkedDecoderActive = false
    chunkedState = .size
    chunkedBytesLeftInChunk = 0
    chunkedSizeBuffer = ""
    requestLineBuffer = Data()

    guard let headerStr = String(data: Data(headerData), encoding: .utf8) else {
      // Can't parse — disable stream parsing for safety.
      streamParseDisabled = true
      return
    }

    // Header lines are separated by CRLF; stop at the empty line.
    let lines = headerStr.components(separatedBy: "\r\n")
    var contentLength: Int? = nil
    var transferEncodingChunked = false
    var method: String = ""

    if let first = lines.first {
      let parts = first.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: false)
      if !parts.isEmpty { method = String(parts[0]).uppercased() }
    }

    for line in lines.dropFirst() {
      if line.isEmpty { break }
      guard let colon = line.firstIndex(of: ":") else { continue }
      let name = line[..<colon].lowercased()
      let value = line[line.index(after: colon)...]
        .trimmingCharacters(in: .whitespacesAndNewlines)
      if name == "content-length" {
        contentLength = Int(value)
      } else if name == "transfer-encoding" {
        if value.lowercased().contains("chunked") {
          transferEncodingChunked = true
        }
      }
    }

    if transferEncodingChunked {
      chunkedDecoderActive = true
      chunkedState = .size
      chunkedBytesLeftInChunk = 0
    } else if let cl = contentLength, cl > 0 {
      bodyBytesRemaining = cl
    } else {
      // No body — typical for GET/HEAD/DELETE without Content-Length, or explicit 0.
      bodyBytesRemaining = 0
      _ = method  // silence unused warning if we add method-specific logic later
    }
  }

  /// Feed bytes through the request-stream parser. When a full request's headers are
  /// found, emits `onRequest` and reconfigures the body parser.
  private func advanceStreamParser(with data: Data) {
    if streamParseDisabled || data.isEmpty { return }
    var idx = 0
    let n = data.count
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
      while idx < n {
        if bodyBytesRemaining > 0 {
          let consume = min(bodyBytesRemaining, n - idx)
          bodyBytesRemaining -= consume
          idx += consume
          continue
        }
        if chunkedDecoderActive {
          let consumed = consumeChunked(base: base, start: idx, end: n)
          if consumed < 0 {
            // Parser gave up; stream-through.
            streamParseDisabled = true
            return
          }
          idx = consumed
          if chunkedDecoderActive { return } // need more bytes
          continue
        }
        // Look for next request line: accumulate into requestLineBuffer until CRLFCRLF.
        // Skip leading CRLFs that some clients emit between pipelined requests.
        while idx < n && requestLineBuffer.isEmpty
            && (base[idx] == 0x0D || base[idx] == 0x0A) {
          idx += 1
        }
        // Append remaining bytes up to (and including) a CRLFCRLF sentinel if present.
        let chunkStart = idx
        while idx < n {
          requestLineBuffer.append(base[idx])
          idx += 1
          if requestLineBuffer.count >= 4 {
            let c = requestLineBuffer.count
            if requestLineBuffer[c - 4] == 0x0D
                && requestLineBuffer[c - 3] == 0x0A
                && requestLineBuffer[c - 2] == 0x0D
                && requestLineBuffer[c - 1] == 0x0A {
              break
            }
          }
          if requestLineBuffer.count >= TunnelConnection.maxHeaderBufferBytes {
            NSLog("[ExpoLocaltunnel] keep-alive request header exceeded \(TunnelConnection.maxHeaderBufferBytes) bytes; disabling stream parse")
            streamParseDisabled = true
            return
          }
        }
        _ = chunkStart
        // Did we complete a header block?
        let c = requestLineBuffer.count
        if c >= 4
            && requestLineBuffer[c - 4] == 0x0D
            && requestLineBuffer[c - 3] == 0x0A
            && requestLineBuffer[c - 2] == 0x0D
            && requestLineBuffer[c - 1] == 0x0A {
          let headers = requestLineBuffer
          requestLineBuffer = Data()
          if let str = String(data: headers, encoding: .utf8),
             let lineEnd = str.range(of: "\r\n") {
            let requestLine = String(str[..<lineEnd.lowerBound])
            let parts = requestLine.split(
              separator: " ", maxSplits: 2, omittingEmptySubsequences: false
            )
            if parts.count >= 2 {
              sendEvent("onRequest", [
                "connectionId": id,
                "method": String(parts[0]),
                "path": String(parts[1])
              ])
            }
            configureBodyParser(forHeaders: headers)
          } else {
            // Couldn't decode — disable parser.
            streamParseDisabled = true
            return
          }
        } else {
          // Reached end of input mid-header; wait for more.
          return
        }
      }
    }
  }

  /// Advances chunked-encoding state through bytes [start, end). Returns the new index,
  /// or -1 on parse failure. Sets `chunkedDecoderActive = false` when the terminating
  /// "0\r\n\r\n" has been consumed.
  private func consumeChunked(base: UnsafePointer<UInt8>, start: Int, end: Int) -> Int {
    var idx = start
    while idx < end {
      switch chunkedState {
      case .size:
        // Read hex digits (accumulated in `chunkedSizeBuffer` so we can resume across
        // reads) until CRLF.
        var sawCRLF = false
        while idx < end {
          let b = base[idx]
          if b == 0x0D { // CR
            // Expect LF next; if not yet available, return without advancing past CR.
            if idx + 1 >= end { return idx }
            if base[idx + 1] != 0x0A { return -1 }
            idx += 2
            sawCRLF = true
            break
          } else {
            // Cap to avoid runaway.
            if chunkedSizeBuffer.count > 32 { return -1 }
            chunkedSizeBuffer.append(Character(UnicodeScalar(b)))
            idx += 1
          }
        }
        if !sawCRLF {
          // Ran out of bytes mid-size line; keep partial digits in chunkedSizeBuffer.
          return idx
        }
        // Strip optional ;extensions
        var sizeStr = chunkedSizeBuffer
        if let semi = sizeStr.firstIndex(of: ";") {
          sizeStr = String(sizeStr[..<semi])
        }
        chunkedSizeBuffer = ""
        guard let size = Int(sizeStr.trimmingCharacters(in: .whitespaces), radix: 16) else {
          return -1
        }
        if size == 0 {
          chunkedState = .trailers
        } else {
          chunkedBytesLeftInChunk = size
          chunkedState = .data
        }
      case .data:
        let take = min(chunkedBytesLeftInChunk, end - idx)
        chunkedBytesLeftInChunk -= take
        idx += take
        if chunkedBytesLeftInChunk == 0 {
          chunkedState = .afterDataCRLF
        } else {
          return idx
        }
      case .afterDataCRLF:
        if idx + 2 > end { return idx } // need more bytes
        if base[idx] != 0x0D || base[idx + 1] != 0x0A { return -1 }
        idx += 2
        chunkedState = .size
      case .trailers:
        // Read until CRLFCRLF (empty line ends trailers, or immediate CRLF if no trailers).
        // Simplest: look for CRLF; if we find an empty line, we're done.
        var lineLen = 0
        let lineStart = idx
        while idx < end {
          if base[idx] == 0x0D {
            if idx + 1 >= end { return lineStart }
            if base[idx + 1] != 0x0A { return -1 }
            if lineLen == 0 {
              // Empty trailer line — end of chunked body.
              idx += 2
              chunkedDecoderActive = false
              chunkedState = .size
              return idx
            }
            idx += 2
            lineLen = 0
          } else {
            lineLen += 1
            idx += 1
          }
        }
        return lineStart
      }
    }
    return idx
  }

  private func connectLocalAndPipe(firstChunk: Data, bodyTail: Data) {
    guard let port = NWEndpoint.Port(rawValue: UInt16(config.localPort)) else {
      handleError(
        NWError.posix(.ECONNREFUSED),
        side: "local"
      )
      return
    }

    let host = NWEndpoint.Host(config.localHost)
    let connection = NWConnection(host: host, port: port, using: .tcp)
    self.localConnection = connection

    connection.stateUpdateHandler = { [weak self] state in
      guard let self = self, !self.closed else { return }
      switch state {
      case .ready:
        self.localConnectAttempts = 0
        self.writeToLocal(firstChunk)
        // Advance keep-alive parser through any body bytes that arrived alongside headers.
        if !bodyTail.isEmpty {
          self.advanceStreamParser(with: bodyTail)
        }
        self.relayRemoteToLocal()
        self.relayLocalToRemote()
      case .failed(let error):
        self.handleLocalConnectFailure(error: error, firstChunk: firstChunk, bodyTail: bodyTail)
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  /// Retry local-connect up to ~30 attempts at 1s spacing, matching the Android behavior.
  /// After exhausting attempts we emit `onConnectionError` and close.
  private func handleLocalConnectFailure(error: NWError, firstChunk: Data, bodyTail: Data) {
    guard !closed else { return }
    localConnectAttempts += 1
    if localConnectAttempts >= TunnelConnection.localConnectMaxAttempts {
      handleError(error, side: "local")
      return
    }
    // Tear down failed connection before next attempt.
    localConnection?.cancel()
    localConnection = nil
    queue.asyncAfter(
      deadline: .now() + TunnelConnection.localConnectRetryIntervalSeconds
    ) { [weak self] in
      guard let self = self, !self.closed else { return }
      self.connectLocalAndPipe(firstChunk: firstChunk, bodyTail: bodyTail)
    }
  }

  /// Steady-state remote->local relay. After headers have completed, bytes flow through
  /// unchanged but we continue parsing the byte stream to emit `onRequest` for
  /// subsequent keep-alive requests.
  private func relayRemoteToLocal() {
    remoteConnection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }

      if let data = data, !data.isEmpty {
        if !self.headersDone {
          // Should not normally happen — first chunk path handles headers — but if a
          // future change reroutes here pre-headers, fall through to a header-buffer
          // accumulation instead of dropping the data.
          self.headerBuffer.append(data)
          if let headerEnd = self.findHeaderEnd(in: self.headerBuffer) {
            let buf = self.headerBuffer
            self.headerBuffer = Data()
            let (rewritten, info, headerLen) = self.rewriteHostHeader(
              buf, headerEndExclusive: headerEnd
            )
            if let info = info {
              self.sendEvent("onRequest", [
                "connectionId": self.id,
                "method": info.method,
                "path": info.path
              ])
            }
            self.headersDone = true
            let headerSlice = rewritten.prefix(headerLen)
            self.configureBodyParser(forHeaders: headerSlice)
            self.writeToLocal(rewritten)
            let bodyTail = rewritten.suffix(from: headerLen)
            if !bodyTail.isEmpty {
              self.advanceStreamParser(with: Data(bodyTail))
            }
          } else if self.headerBuffer.count >= TunnelConnection.maxHeaderBufferBytes {
            NSLog("[ExpoLocaltunnel] header buffer exceeded \(TunnelConnection.maxHeaderBufferBytes) bytes without CRLFCRLF; streaming through unmodified")
            let buf = self.headerBuffer
            self.headerBuffer = Data()
            self.headersDone = true
            self.streamParseDisabled = true
            self.writeToLocal(buf)
          }
        } else {
          self.advanceStreamParser(with: data)
          self.writeToLocal(data)
        }
      }

      if isComplete || error != nil {
        self.closeAndNotify()
        return
      }

      self.relayRemoteToLocal()
    }
  }

  private func relayLocalToRemote() {
    localConnection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }

      if let data = data, !data.isEmpty {
        self.writeToRemote(data)
      }

      if isComplete || error != nil {
        self.closeAndNotify()
        return
      }

      self.relayLocalToRemote()
    }
  }

  private func writeToLocal(_ data: Data) {
    localConnection?.send(content: data, completion: .contentProcessed { [weak self] error in
      if let error = error {
        self?.handleError(error, side: "local-write")
      }
    })
  }

  private func writeToRemote(_ data: Data) {
    remoteConnection?.send(content: data, completion: .contentProcessed { [weak self] error in
      if let error = error {
        self?.handleError(error, side: "remote-write")
      }
    })
  }

  private func handleError(_ error: Error, side: String) {
    guard !closed else { return }
    let code = mapErrorCode(error as? NWError)
    sendEvent("onConnectionError", [
      "connectionId": id,
      "error": "\(side): \(error.localizedDescription)",
      "code": code
    ])
    closeDetached()
  }

  private func closeAndNotify() {
    guard !closed else { return }
    sendEvent("onConnectionClose", ["connectionId": id])
    closeDetached()
  }

  private func mapErrorCode(_ error: NWError?) -> String {
    guard let error = error else { return "UNKNOWN" }
    switch error {
    case .posix(let code) where code == .ECONNREFUSED:
      return "ECONNREFUSED"
    case .posix(let code) where code == .ECONNRESET:
      return "ECONNRESET"
    case .posix(let code) where code == .ETIMEDOUT:
      return "ETIMEDOUT"
    default:
      return "UNKNOWN"
    }
  }

  private func mapErrorCode(_ error: Error) -> String {
    if let nwError = error as? NWError {
      return mapErrorCode(nwError)
    }
    return "UNKNOWN"
  }

  /// Public close. Called from the JS dispatch thread (via AsyncFunction / OnDestroy in
  /// `ExpoLocaltunnelModule`), so we hop to `self.queue` to keep all writes to `closed`
  /// (and the connection refs) serialized on a single queue.
  ///
  /// Awaits each `NWConnection` actually reaching `.cancelled` (or `.failed`) before
  /// returning — so the JS-side `Effect.acquireRelease` finalizer in `startTunnel`
  /// only resolves once the TCP FINs have been sent. Without this await, on iOS
  /// expiration the OS routinely reclaims the process before the cancel runs,
  /// leaving the relay's subdomain lease in flight and forcing a fresh random
  /// subdomain on the next launch.
  /// Fire-and-forget wrapper around `close()` for internal teardown signals
  /// (receive-callback `isComplete`, error handlers). The actual FIN may still be
  /// in flight when this returns — that's fine; internal callers don't need to
  /// block on it. External (JS) callers go through `close()` directly and await.
  private func closeDetached() {
    Task { [weak self] in
      await self?.close()
    }
  }

  func close() async {
    let startMs = Date().timeIntervalSince1970 * 1000
    NSLog("[ExpoLocaltunnel] TunnelConnection(\(id)) close() entered")
    await withCheckedContinuation { (outerCont: CheckedContinuation<Void, Never>) in
      queue.async { [weak self] in
        guard let self = self else {
          NSLog("[ExpoLocaltunnel] TunnelConnection close() self deallocated")
          outerCont.resume()
          return
        }
        if self.closed {
          NSLog("[ExpoLocaltunnel] TunnelConnection(\(self.id)) close() short-circuit (already closed)")
          outerCont.resume()
          return
        }
        self.closed = true

        let toCancel: [NWConnection] = [self.remoteConnection, self.localConnection]
          .compactMap { $0 }
        self.remoteConnection = nil
        self.localConnection = nil

        if toCancel.isEmpty {
          NSLog("[ExpoLocaltunnel] TunnelConnection(\(self.id)) close() no connections to cancel")
          outerCont.resume()
          return
        }

        // `pending` is mutated only from stateUpdateHandler callbacks (which fire on
        // `self.queue`, the queue passed to `connection.start(queue:)`) and from the
        // synchronous already-terminal check below. The enclosing block runs on
        // `self.queue`, so this is a single-queue mutation — no lock.
        var pending = toCancel.count

        let decrement: () -> Void = {
          pending -= 1
          if pending == 0 {
            NSLog("[ExpoLocaltunnel] TunnelConnection(\(self.id)) close() all connections terminal")
            outerCont.resume()
          }
        }

        for conn in toCancel {
          let flag = ResumeFlag()
          conn.stateUpdateHandler = { state in
            switch state {
            case .cancelled, .failed:
              if flag.tryClaim() {
                decrement()
              }
            default:
              break
            }
          }

          // NWConnection.stateUpdateHandler does NOT replay the current state when
          // newly set — it only fires on subsequent transitions. If the connection
          // has already reached `.cancelled` or `.failed` (e.g. a relay-side reset
          // earlier in the session, or a prior `closeDetached()` already cancelled
          // it) the handler above would never fire and we'd hang until the outer
          // `Effect.timeout` budget expired. Check synchronously and short-circuit.
          switch conn.state {
          case .cancelled, .failed:
            NSLog("[ExpoLocaltunnel] TunnelConnection(\(self.id)) close() conn already terminal")
            if flag.tryClaim() {
              decrement()
            }
          default:
            conn.cancel()
          }
        }
      }
    }
    let elapsed = Date().timeIntervalSince1970 * 1000 - startMs
    NSLog("[ExpoLocaltunnel] TunnelConnection(\(id)) close() returned in \(Int(elapsed))ms")
  }
}
