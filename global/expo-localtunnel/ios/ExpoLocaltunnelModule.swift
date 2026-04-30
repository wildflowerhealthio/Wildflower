import ExpoModulesCore
import Network

public class ExpoLocaltunnelModule: Module {
  private var connections: [String: TunnelConnection] = [:]
  private let connectionsLock = NSLock()
  private let queue = DispatchQueue(label: "expo.localtunnel", qos: .userInitiated)

  /// Synchronous wrapper around `connectionsLock`. The helper itself is non-`async`,
  /// so the `noasync`-annotated `NSLock.lock()`/`unlock()` calls inside are reachable
  /// from `AsyncFunction` closures without tripping Swift 6 concurrency diagnostics.
  private func withConnectionsLock<T>(_ body: () -> T) -> T {
    connectionsLock.lock()
    defer { connectionsLock.unlock() }
    return body()
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoLocaltunnel")

    Events(
      "onConnectionOpen",
      "onConnectionClose",
      "onConnectionError",
      "onConnectionDead",
      "onRequest"
    )

    OnDestroy {
      let snapshot = self.withConnectionsLock { () -> [String: TunnelConnection] in
        let snap = self.connections
        self.connections.removeAll()
        return snap
      }
      for (_, conn) in snapshot {
        conn.close()
      }
    }

    AsyncFunction("createTunnelConnection") { (connectionId: String, config: TunnelConnectionConfig) in
      // Clean up existing connection with this ID if any
      let existing = self.withConnectionsLock { self.connections[connectionId] }
      existing?.close()

      let conn = TunnelConnection(
        id: connectionId,
        config: config,
        queue: self.queue
      ) { (name: String, body: [String: Any]) in
        self.sendEvent(name, body)
      }
      self.withConnectionsLock { self.connections[connectionId] = conn }
      try await conn.connectRemote()
    }

    AsyncFunction("closeTunnelConnection") { (connectionId: String) in
      let conn = self.withConnectionsLock { self.connections.removeValue(forKey: connectionId) }
      conn?.close()
    }

    AsyncFunction("closeAllTunnelConnections") {
      let snapshot = self.withConnectionsLock { () -> [String: TunnelConnection] in
        let snap = self.connections
        self.connections.removeAll()
        return snap
      }
      for (_, conn) in snapshot {
        conn.close()
      }
    }
  }
}

struct TunnelConnectionConfig: Record {
  @Field var remoteHost: String = ""
  @Field var remotePort: Int = 0
  @Field var localHost: String = "localhost"
  @Field var localPort: Int = 0
  @Field var localHostHeader: String?
}
