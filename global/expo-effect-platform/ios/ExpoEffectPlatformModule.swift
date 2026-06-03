import ExpoModulesCore
import FlyingFox
import Foundation

func getAllNetworkInterfaces() -> [String: String] {
  var result: [String: String] = [:]
  var ifaddr: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&ifaddr) == 0, let firstAddr = ifaddr else { return result }

  for ptr in sequence(first: firstAddr, next: { $0.pointee.ifa_next }) {
    let addr = ptr.pointee.ifa_addr.pointee
    if addr.sa_family == UInt8(AF_INET) {
      let name = String(cString: ptr.pointee.ifa_name)
      var hostname = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      getnameinfo(
        ptr.pointee.ifa_addr, socklen_t(addr.sa_len),
        &hostname, socklen_t(hostname.count), nil, socklen_t(0), NI_NUMERICHOST)
      result[name] = String(cString: hostname)
    }
  }
  freeifaddrs(ifaddr)
  return result
}

struct ClosureHTTPHandler: HTTPHandler {
  let closure: @Sendable (HTTPRequest) async throws -> HTTPResponse
  func handleRequest(_ request: HTTPRequest) async throws -> HTTPResponse {
    try await closure(request)
  }
}

/// Holds all of the per-server mutable state. Wrapping it in an actor
/// serializes access from FlyingFox handler closures (which run on arbitrary
/// executors) and from the JS-bridge AsyncFunction calls.
actor ServerState {
  var server: HTTPServer?
  var task: Task<Void, Error>?
  var pendingRequests: [String: CheckedContinuation<HTTPResponse, Never>] = [:]
  var pendingTimeoutTasks: [String: Task<Void, Never>] = [:]
  var pendingBodyFiles: [String: String] = [:]
  var bodyDiskThresholdBytes: Int = 10_000_000
  var maxConcurrentRequests: Int = 256
  var fileSandboxRoots: [String] = []
  var inFlightCount: Int = 0

  func configure(
    bodyDiskThresholdBytes: Int?,
    maxConcurrentRequests: Int?,
    fileSandboxRoots: [String]?
  ) {
    if let v = bodyDiskThresholdBytes { self.bodyDiskThresholdBytes = v }
    if let v = maxConcurrentRequests { self.maxConcurrentRequests = v }
    if let v = fileSandboxRoots { self.fileSandboxRoots = v }
  }

  func setServer(_ s: HTTPServer?, task: Task<Void, Error>?) {
    self.server = s
    self.task = task
  }

  func tryReserveSlot() -> Bool {
    guard inFlightCount < maxConcurrentRequests else { return false }
    inFlightCount += 1
    return true
  }

  func releaseSlot() {
    if inFlightCount > 0 { inFlightCount -= 1 }
  }

  func registerRequest(
    _ id: String,
    continuation: CheckedContinuation<HTTPResponse, Never>,
    bodyFilePath: String?,
    timeoutTask: Task<Void, Never>?
  ) {
    pendingRequests[id] = continuation
    if let path = bodyFilePath { pendingBodyFiles[id] = path }
    if let t = timeoutTask { pendingTimeoutTasks[id] = t }
  }

  /// Pop the continuation + cleanup state for a request. Returns nil if the
  /// request has already been resolved (e.g. via timeout) so callers can no-op.
  func takeRequest(_ id: String) -> (
    continuation: CheckedContinuation<HTTPResponse, Never>,
    bodyFilePath: String?
  )? {
    guard let cont = pendingRequests.removeValue(forKey: id) else { return nil }
    let timeout = pendingTimeoutTasks.removeValue(forKey: id)
    timeout?.cancel()
    let bodyPath = pendingBodyFiles.removeValue(forKey: id)
    return (cont, bodyPath)
  }

  /// Used by the timeout task; same shape as takeRequest but doesn't cancel
  /// the timeout (the caller is the timeout itself).
  func takeRequestForTimeout(_ id: String) -> (
    continuation: CheckedContinuation<HTTPResponse, Never>,
    bodyFilePath: String?
  )? {
    guard let cont = pendingRequests.removeValue(forKey: id) else { return nil }
    pendingTimeoutTasks.removeValue(forKey: id)
    let bodyPath = pendingBodyFiles.removeValue(forKey: id)
    return (cont, bodyPath)
  }

  func drainAll() -> (
    continuations: [CheckedContinuation<HTTPResponse, Never>],
    timeoutTasks: [Task<Void, Never>],
    bodyFilePaths: [String]
  ) {
    let conts = Array(pendingRequests.values)
    let timeouts = Array(pendingTimeoutTasks.values)
    let paths = Array(pendingBodyFiles.values)
    pendingRequests.removeAll()
    pendingTimeoutTasks.removeAll()
    pendingBodyFiles.removeAll()
    inFlightCount = 0
    return (conts, timeouts, paths)
  }

  func sandboxRootsSnapshot() -> [String] { fileSandboxRoots }
}

private func deleteTempFile(_ path: String?) {
  if let p = path { try? FileManager.default.removeItem(atPath: p) }
}

/// Resolves a path through symlinks and `..` segments, returning the canonical
/// absolute path string. Returns nil if the path cannot be resolved.
private func canonicalize(_ path: String) -> String? {
  let url = URL(fileURLWithPath: path).standardizedFileURL
  return url.resolvingSymlinksInPath().path
}

/// True if `candidate` is contained within (or equal to) any of `roots`,
/// resolving symlinks before comparison so attackers can't bypass via symlinks.
private func isPathInside(_ candidate: String, roots: [String]) -> Bool {
  guard let canonical = canonicalize(candidate) else { return false }
  for root in roots {
    guard let canonicalRoot = canonicalize(root) else { continue }
    if canonical == canonicalRoot { return true }
    let prefix = canonicalRoot.hasSuffix("/") ? canonicalRoot : canonicalRoot + "/"
    if canonical.hasPrefix(prefix) { return true }
  }
  return false
}

/// Default sandbox roots when the caller doesn't supply any. Restricts file
/// responses to the app's own document and cache directories plus the temp
/// directory (where request-body spill files live).
private func defaultSandboxRoots() -> [String] {
  var roots: [String] = [NSTemporaryDirectory()]
  if let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
    roots.append(docs.path)
  }
  if let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first {
    roots.append(caches.path)
  }
  return roots
}

public class ExpoEffectPlatformModule: Module {
  let state = ServerState()

  struct ServerOptions: Record {
    @Field var hostname: String? = nil
    @Field var handlerTimeoutSeconds: Double? = nil
    @Field var bodyDiskThresholdBytes: Int? = nil
    @Field var maxConcurrentRequests: Int? = nil
    @Field var fileSandboxRoots: [String]? = nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoEffectPlatform")

    Events("onHttpRequest")

    AsyncFunction("startServer") { [weak self] (port: UInt16, options: ServerOptions?) in
      guard let self else { return }

      // Idempotency guard — refuse if a server is already running.
      if await self.state.server != nil {
        throw NSError(
          domain: "ExpoEffectPlatform", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Server already running; call stopServer first"])
      }

      await self.state.configure(
        bodyDiskThresholdBytes: options?.bodyDiskThresholdBytes,
        maxConcurrentRequests: options?.maxConcurrentRequests,
        fileSandboxRoots: options?.fileSandboxRoots ?? defaultSandboxRoots()
      )

      let hostname = options?.hostname ?? "127.0.0.1"
      let server: HTTPServer
      let address = try sockaddr_in.inet(ip4: hostname, port: port)
      server = HTTPServer(address: address)

      let task = Task { [weak self] in
        guard let self else { return }
        await server.appendRoute(
          "*",
          to: ClosureHTTPHandler { [weak self] req in
            guard let self else {
              return HTTPResponse(
                statusCode: HTTPStatusCode(503, phrase: "Service Unavailable"),
                headers: HTTPHeaders(),
                body: Data())
            }
            return await self.handleIncoming(req: req, options: options)
          })

        try await server.run()
      }

      await self.state.setServer(server, task: task)
    }

    AsyncFunction("respondToRequest") {
      [weak self]
      (
        requestId: String, statusCode: Int,
        headers: [String: [String]], body: String, bodyEncoding: String
      ) in
      guard let self else { return }
      guard let entry = await self.state.takeRequest(requestId) else { return }
      deleteTempFile(entry.bodyFilePath)
      await self.state.releaseSlot()

      let bodyData: Data
      switch bodyEncoding {
      case "base64":
        bodyData = Data(base64Encoded: body) ?? Data()
      default:
        bodyData = Data(body.utf8)
      }

      let response = HTTPResponse(
        statusCode: HTTPStatusCode(statusCode, phrase: ""),
        headers: buildHeaders(from: headers),
        body: bodyData
      )
      entry.continuation.resume(returning: response)
    }

    AsyncFunction("respondToRequestWithFile") {
      [weak self]
      (
        requestId: String, statusCode: Int,
        headers: [String: [String]], filePath: String, start: Int?, end: Int?
      ) in
      guard let self else { return }
      let roots = await self.state.sandboxRootsSnapshot()
      guard let entry = await self.state.takeRequest(requestId) else { return }
      deleteTempFile(entry.bodyFilePath)
      await self.state.releaseSlot()

      // Sandbox the file path. If the caller supplies a path that escapes the
      // configured roots, refuse to serve it — return 403 instead. Symlinks
      // are resolved before checking so attackers can't smuggle a path out.
      if !isPathInside(filePath, roots: roots) {
        let response = HTTPResponse(
          statusCode: HTTPStatusCode(403, phrase: "Forbidden"),
          headers: HTTPHeaders(),
          body: Data("File path is outside the configured sandbox roots".utf8))
        entry.continuation.resume(returning: response)
        return
      }

      let fileURL = URL(fileURLWithPath: filePath)
      let body: HTTPBodySequence
      do {
        let range: Range<Int>?
        if let s = start, let e = end {
          range = s..<e
        } else {
          range = nil
        }
        body = try HTTPBodySequence(file: fileURL, range: range)
      } catch {
        let response = HTTPResponse(
          statusCode: HTTPStatusCode(500, phrase: "Internal Server Error"),
          headers: HTTPHeaders(),
          body: Data("Failed to open file body".utf8))
        entry.continuation.resume(returning: response)
        return
      }

      let response = HTTPResponse(
        statusCode: HTTPStatusCode(statusCode, phrase: ""),
        headers: buildHeaders(from: headers),
        body: body
      )
      entry.continuation.resume(returning: response)
    }

    AsyncFunction("stopServer") { [weak self] (timeoutSeconds: Int) in
      guard let self else { return }
      let server = await self.state.server
      if let server { await server.stop(timeout: TimeInterval(timeoutSeconds)) }

      let drained = await self.state.drainAll()
      for t in drained.timeoutTasks { t.cancel() }
      for path in drained.bodyFilePaths { deleteTempFile(path) }
      for cont in drained.continuations {
        cont.resume(
          returning: HTTPResponse(
            statusCode: HTTPStatusCode(503, phrase: "Service Unavailable"),
            headers: HTTPHeaders(),
            body: Data()))
      }

      await self.state.setServer(nil, task: nil)
    }

    Function("getNetworkInterfaces") {
      getAllNetworkInterfaces()
    }
  }

  /// Construct FlyingFox HTTPHeaders from `[String: [String]]`, preserving
  /// multiple values per key (so e.g. multiple `Set-Cookie` lines emit
  /// individually).
  private func buildHeaders(from input: [String: [String]]) -> HTTPHeaders {
    var headers = HTTPHeaders()
    for (key, values) in input {
      headers.setValues(values, for: HTTPHeader(rawValue: key))
    }
    return headers
  }

  /// Try to decode bytes as UTF-8 string; returns nil if invalid.
  private func tryUTF8(_ data: Data) -> String? {
    return String(data: data, encoding: .utf8)
  }

  /// Per-request handler invoked from FlyingFox. Reads the request body,
  /// spills to disk above the threshold, base64-encodes if non-UTF-8, and
  /// suspends until the JS handler responds (or timeout fires).
  private func handleIncoming(req: HTTPRequest, options: ServerOptions?) async -> HTTPResponse {
    // Bound concurrent in-flight requests so a flood can't exhaust memory.
    let reserved = await state.tryReserveSlot()
    if !reserved {
      return HTTPResponse(
        statusCode: HTTPStatusCode(503, phrase: "Service Unavailable"),
        headers: HTTPHeaders(),
        body: Data("Server too busy".utf8))
    }

    let requestId = UUID().uuidString
    let threshold = await state.bodyDiskThresholdBytes

    // Read body chunks. Buffer until we exceed the threshold, then spill the
    // accumulated buffer + any remaining chunks to disk. This keeps peak
    // memory bounded even when Content-Length is missing (chunked transfers).
    var inMemory = Data()
    var spilled: FileHandle?
    var spilledPath: String?
    var totalBytes = 0
    let hardCap = max(threshold * 4, threshold + 50_000_000)

    do {
      for try await chunk in req.bodySequence {
        totalBytes += chunk.count
        if totalBytes > hardCap {
          if let h = spilled { try? h.close() }
          if let p = spilledPath { deleteTempFile(p) }
          await state.releaseSlot()
          return HTTPResponse(
            statusCode: HTTPStatusCode(413, phrase: "Payload Too Large"),
            headers: HTTPHeaders(),
            body: Data("Request body exceeds maximum size".utf8))
        }

        if spilled == nil {
          if inMemory.count + chunk.count > threshold {
            let tempPath = NSTemporaryDirectory() + "request-\(requestId).bin"
            FileManager.default.createFile(atPath: tempPath, contents: nil)
            let handle = FileHandle(forWritingAtPath: tempPath)
            if let handle {
              try handle.write(contentsOf: inMemory)
              try handle.write(contentsOf: chunk)
              spilled = handle
              spilledPath = tempPath
              inMemory = Data()
            } else {
              inMemory.append(chunk)
            }
          } else {
            inMemory.append(chunk)
          }
        } else if let h = spilled {
          try h.write(contentsOf: chunk)
        }
      }
    } catch {
      if let h = spilled { try? h.close() }
      if let p = spilledPath { deleteTempFile(p) }
      await state.releaseSlot()
      return HTTPResponse(
        statusCode: HTTPStatusCode(400, phrase: "Bad Request"),
        headers: HTTPHeaders(),
        body: Data("Failed to read request body".utf8))
    }

    if let h = spilled { try? h.close() }

    var bodyText: String? = nil
    var bodyBase64: String? = nil
    var bodyFilePath: String? = nil

    if spilledPath != nil {
      bodyFilePath = spilledPath
    } else if let utf8 = tryUTF8(inMemory) {
      bodyText = utf8
    } else {
      bodyBase64 = inMemory.base64EncodedString()
    }

    // Build headers payload — `[String: [String]]` so multi-valued headers
    // (e.g. Set-Cookie) round-trip without the lossy comma-join.
    var headersOut: [String: [String]] = [:]
    for header in req.headers.keys {
      headersOut[header.rawValue] = req.headers.values(for: header)
    }
    // `remoteAddress` is an `Address` enum — `String(describing:)` would
    // emit the case shape (`ip4("1.2.3.4", port: 12345)`) instead of the
    // raw IP string. Pattern-match to lift the IP out of `ip4` / `ip6`;
    // `unix` sockets are local-only and have no remote IP, so they fall
    // through to the empty string the consumer's `OnHttpRequestPayload.ip`
    // already treats as "unknown".
    let ip: String
    switch req.remoteAddress {
    case .ip4(let address, _), .ip6(let address, _):
      ip = address
    case .unix, .none:
      ip = ""
    }

    return await withCheckedContinuation { (continuation: CheckedContinuation<HTTPResponse, Never>) in
      Task {
        var timeoutTask: Task<Void, Never>?
        if let timeoutSeconds = options?.handlerTimeoutSeconds {
          timeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
            guard let self else { return }
            guard let entry = await self.state.takeRequestForTimeout(requestId) else { return }
            deleteTempFile(entry.bodyFilePath)
            await self.state.releaseSlot()
            entry.continuation.resume(
              returning: HTTPResponse(
                statusCode: HTTPStatusCode(504, phrase: "Gateway Timeout"),
                headers: HTTPHeaders(),
                body: Data()))
          }
        }

        await state.registerRequest(
          requestId, continuation: continuation, bodyFilePath: bodyFilePath,
          timeoutTask: timeoutTask)

        sendEvent(
          "onHttpRequest",
          [
            "requestId": requestId,
            "method": req.method.rawValue,
            "path": req.target.rawValue,
            "headers": headersOut,
            "body": bodyText as Any,
            "bodyBase64": bodyBase64 as Any,
            "bodyFilePath": bodyFilePath as Any,
            "ip": ip,
          ])
      }
    }
  }
}
