import Foundation
import Network

class TunnelConnection {
  let id: String
  let config: TunnelConnectionConfig
  let queue: DispatchQueue
  let sendEvent: (String, [String: Any]) -> Void

  private var remoteConnection: NWConnection?
  private var localConnection: NWConnection?
  private var hostHeaderReplaced = false
  private var closed = false

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
      var resumed = false

      connection.stateUpdateHandler = { [weak self] state in
        guard let self = self else { return }
        switch state {
        case .ready:
          if !resumed {
            resumed = true
            self.sendEvent("onConnectionOpen", ["connectionId": self.id])
            self.startRemoteRead()
            continuation.resume()
          }
        case .failed(let error):
          if !resumed {
            resumed = true
            let code = self.mapErrorCode(error)
            self.sendEvent("onConnectionError", [
              "connectionId": self.id,
              "error": error.localizedDescription,
              "code": code
            ])
            continuation.resume(throwing: error)
          }
        case .cancelled:
          if !resumed {
            resumed = true
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
          self.close()
        }
        return
      }

      self.parseAndEmitRequest(data)
      let transformedData = self.transformHostHeader(data)
      self.connectLocalAndPipe(firstChunk: transformedData)
    }
  }

  private func parseAndEmitRequest(_ data: Data) {
    guard let str = String(data: data, encoding: .utf8) else { return }
    let pattern = "^(\\w+) (\\S+)"
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)),
          let methodRange = Range(match.range(at: 1), in: str),
          let pathRange = Range(match.range(at: 2), in: str)
    else { return }

    sendEvent("onRequest", [
      "connectionId": id,
      "method": String(str[methodRange]),
      "path": String(str[pathRange])
    ])
  }

  private func transformHostHeader(_ data: Data) -> Data {
    guard let hostHeader = config.localHostHeader, !hostHeaderReplaced else {
      return data
    }
    guard var str = String(data: data, encoding: .utf8) else { return data }

    let pattern = "(\\r\\n[Hh]ost: )\\S+"
    guard let regex = try? NSRegularExpression(pattern: pattern),
          let match = regex.firstMatch(in: str, range: NSRange(str.startIndex..., in: str)),
          let prefixRange = Range(match.range(at: 1), in: str),
          let fullRange = Range(match.range, in: str)
    else { return data }

    str.replaceSubrange(fullRange, with: str[prefixRange] + hostHeader)
    hostHeaderReplaced = true
    return str.data(using: .utf8) ?? data
  }

  private func connectLocalAndPipe(firstChunk: Data) {
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
      guard let self = self else { return }
      switch state {
      case .ready:
        self.writeToLocal(firstChunk)
        self.relayRemoteToLocal()
        self.relayLocalToRemote()
      case .failed(let error):
        self.handleError(error, side: "local")
      default:
        break
      }
    }
    connection.start(queue: queue)
  }

  private func relayRemoteToLocal() {
    remoteConnection?.receive(minimumIncompleteLength: 1, maximumLength: 65536) {
      [weak self] data, _, isComplete, error in
      guard let self = self, !self.closed else { return }

      if let data = data, !data.isEmpty {
        let transformed = self.transformHostHeader(data)
        self.writeToLocal(transformed)
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
    close()
  }

  private func closeAndNotify() {
    guard !closed else { return }
    sendEvent("onConnectionClose", ["connectionId": id])
    close()
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

  func close() {
    guard !closed else { return }
    closed = true
    remoteConnection?.cancel()
    localConnection?.cancel()
    remoteConnection = nil
    localConnection = nil
  }
}
