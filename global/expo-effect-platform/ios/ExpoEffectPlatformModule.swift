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

public class ExpoEffectPlatformModule: Module {
  var server: HTTPServer? = nil
  var task: Task<Void, Error>? = nil
  private var pendingRequests: [String: CheckedContinuation<HTTPResponse, Never>] = [:]
  private var pendingTimeoutTasks: [String: Task<Void, Never>] = [:]
  private let pendingRequestsLock = NSLock()
  private var bodyDiskThresholdBytes: Int = 10_000_000

  struct ServerOptions: Record {
    @Field var hostname: String? = nil
    @Field var handlerTimeoutSeconds: Double? = nil
    @Field var bodyDiskThresholdBytes: Int? = nil
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoEffectPlatform")

    Events("onHttpRequest")

    AsyncFunction("startServer") { (port: UInt16, options: ServerOptions?) in
      if let threshold = options?.bodyDiskThresholdBytes {
        self.bodyDiskThresholdBytes = threshold
      }

      if let hostname = options?.hostname {
        let address = try sockaddr_in.inet(ip4: hostname, port: port)
        self.server = HTTPServer(address: address)
      } else {
        self.server = HTTPServer(port: port)
      }

      self.task = Task {
        guard let server = self.server else { return }

        await server.appendRoute(
          "*",
          to: ClosureHTTPHandler { req in
            let requestId = UUID().uuidString
            let bodyData = await (try? req.bodyData) ?? Data()

            var body: String? = nil
            var bodyFilePath: String? = nil

            if bodyData.count > self.bodyDiskThresholdBytes {
              let tempPath = NSTemporaryDirectory() + "request-\(requestId).bin"
              let tempURL = URL(fileURLWithPath: tempPath)
              try? bodyData.write(to: tempURL)
              bodyFilePath = tempPath
            } else {
              body = String(data: bodyData, encoding: .utf8) ?? ""
            }

            let headers: [String: String] = req.headers.reduce(into: [:]) {
              $0[$1.key.rawValue] = $1.value
            }
            let ip = req.remoteIPAddress ?? ""

            return await withCheckedContinuation { continuation in
              self.pendingRequestsLock.lock()
              self.pendingRequests[requestId] = continuation
              self.pendingRequestsLock.unlock()

              if let timeoutSeconds = options?.handlerTimeoutSeconds {
                let timeoutTask = Task {
                  try? await Task.sleep(nanoseconds: UInt64(timeoutSeconds * 1_000_000_000))
                  self.pendingRequestsLock.lock()
                  let timedOut = self.pendingRequests.removeValue(forKey: requestId)
                  self.pendingTimeoutTasks.removeValue(forKey: requestId)
                  self.pendingRequestsLock.unlock()

                  if let filePath = bodyFilePath {
                    try? FileManager.default.removeItem(atPath: filePath)
                  }

                  timedOut?.resume(
                    returning: HTTPResponse(
                      statusCode: HTTPStatusCode(504, phrase: "Gateway Timeout"),
                      headers: [:],
                      body: Data()
                    ))
                }
                self.pendingRequestsLock.lock()
                self.pendingTimeoutTasks[requestId] = timeoutTask
                self.pendingRequestsLock.unlock()
              }

              self.sendEvent(
                "onHttpRequest",
                [
                  "requestId": requestId,
                  "method": req.method.rawValue,
                  "path": req.target.rawValue,
                  "headers": headers,
                  "body": body as Any,
                  "bodyFilePath": bodyFilePath as Any,
                  "ip": ip,
                ]
              )
            }
          }
        )

        try await server.run()
      }
    }

    AsyncFunction("respondToRequest") {
      (requestId: String, statusCode: Int, headers: [String: String], body: String) in
      self.pendingRequestsLock.lock()
      let continuation = self.pendingRequests.removeValue(forKey: requestId)
      let timeoutTask = self.pendingTimeoutTasks.removeValue(forKey: requestId)
      self.pendingRequestsLock.unlock()
      timeoutTask?.cancel()

      guard let continuation else { return }

      let flyingFoxHeaders: [HTTPHeader: String] = Dictionary(
        uniqueKeysWithValues: headers.map { (HTTPHeader(rawValue: $0.key), $0.value) }
      )
      let response = HTTPResponse(
        statusCode: HTTPStatusCode(statusCode, phrase: ""),
        headers: flyingFoxHeaders,
        body: Data(body.utf8)
      )
      continuation.resume(returning: response)
    }

    AsyncFunction("respondToRequestWithFile") {
      (requestId: String, statusCode: Int, headers: [String: String], filePath: String) in
      self.pendingRequestsLock.lock()
      let continuation = self.pendingRequests.removeValue(forKey: requestId)
      let timeoutTask = self.pendingTimeoutTasks.removeValue(forKey: requestId)
      self.pendingRequestsLock.unlock()
      timeoutTask?.cancel()

      guard let continuation else { return }

      let fileURL = URL(fileURLWithPath: filePath)
      let fileData = (try? Data(contentsOf: fileURL, options: .mappedIfSafe)) ?? Data()

      let flyingFoxHeaders: [HTTPHeader: String] = Dictionary(
        uniqueKeysWithValues: headers.map { (HTTPHeader(rawValue: $0.key), $0.value) }
      )
      let response = HTTPResponse(
        statusCode: HTTPStatusCode(statusCode, phrase: ""),
        headers: flyingFoxHeaders,
        body: fileData
      )
      continuation.resume(returning: response)
    }

    AsyncFunction("stopServer") { (timeoutSeconds: Int) in
      if let server = self.server {
        await server.stop(timeout: TimeInterval(timeoutSeconds))
      }

      self.pendingRequestsLock.lock()
      let remaining = self.pendingRequests
      self.pendingRequests.removeAll()
      let timeoutTasks = self.pendingTimeoutTasks
      self.pendingTimeoutTasks.removeAll()
      self.pendingRequestsLock.unlock()

      for (_, task) in timeoutTasks {
        task.cancel()
      }
      for (_, continuation) in remaining {
        continuation.resume(
          returning: HTTPResponse(
            statusCode: HTTPStatusCode(503, phrase: "Service Unavailable"),
            headers: [:],
            body: Data()
          ))
      }

      self.server = nil
      self.task = nil
    }

    Function("getNetworkInterfaces") {
      getAllNetworkInterfaces()
    }
  }
}
