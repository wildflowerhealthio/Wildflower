import ExpoModulesCore
import Network

public class ExpoLocaltunnelModule: Module {
  private var connections: [String: TunnelConnection] = [:]
  private let connectionsLock = NSLock()
  private let queue = DispatchQueue(label: "expo.localtunnel", qos: .userInitiated)

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
      self.connectionsLock.lock()
      let snapshot = self.connections
      self.connections.removeAll()
      self.connectionsLock.unlock()
      for (_, conn) in snapshot {
        conn.close()
      }
    }

    AsyncFunction("createTunnelConnection") { (connectionId: String, config: TunnelConnectionConfig) in
      // Clean up existing connection with this ID if any
      self.connectionsLock.lock()
      let existing = self.connections[connectionId]
      self.connectionsLock.unlock()
      existing?.close()

      let conn = TunnelConnection(
        id: connectionId,
        config: config,
        queue: self.queue
      ) { (name: String, body: [String: Any]) in
        self.sendEvent(name, body)
      }
      self.connectionsLock.lock()
      self.connections[connectionId] = conn
      self.connectionsLock.unlock()
      try await conn.connectRemote()
    }

    AsyncFunction("closeTunnelConnection") { (connectionId: String) in
      self.connectionsLock.lock()
      let conn = self.connections.removeValue(forKey: connectionId)
      self.connectionsLock.unlock()
      conn?.close()
    }

    AsyncFunction("closeAllTunnelConnections") {
      self.connectionsLock.lock()
      let snapshot = self.connections
      self.connections.removeAll()
      self.connectionsLock.unlock()
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
