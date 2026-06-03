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
      // OnDestroy is synchronous; we can't directly `await` the asynchronous close.
      // Spawn an unstructured Task so each `conn.close()` (which awaits NWConnection
      // reaching `.cancelled`) gets a chance to run before the native module is GC'd.
      // This is the only hook we have for Metro JS-bundle reloads — the JS-side
      // `Effect.acquireRelease` finalizer never runs across reload because the JS
      // VM is being torn down.
      let snapshot = self.withConnectionsLock { () -> [String: TunnelConnection] in
        let snap = self.connections
        self.connections.removeAll()
        return snap
      }
      Task {
        await withTaskGroup(of: Void.self) { group in
          for (_, conn) in snapshot {
            group.addTask { await conn.close() }
          }
        }
      }
    }

    AsyncFunction("createTunnelConnection") { (connectionId: String, config: TunnelConnectionConfig) in
      // Clean up existing connection with this ID if any.
      let existing = self.withConnectionsLock { self.connections[connectionId] }
      await existing?.close()

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
      await conn?.close()
    }

    AsyncFunction("closeAllTunnelConnections") {
      let snapshot = self.withConnectionsLock { () -> [String: TunnelConnection] in
        let snap = self.connections
        self.connections.removeAll()
        return snap
      }
      NSLog("[ExpoLocaltunnel] closeAllTunnelConnections start (\(snapshot.count) conn(s))")
      let startMs = Date().timeIntervalSince1970 * 1000
      // Close all in parallel; `AsyncFunction` only resolves on the JS side once
      // this body completes, so the JS-side `Effect.acquireRelease` release will
      // properly await the TCP FINs being sent before the surrounding scope teardown
      // moves on.
      await withTaskGroup(of: Void.self) { group in
        for (_, conn) in snapshot {
          group.addTask { await conn.close() }
        }
      }
      let elapsed = Date().timeIntervalSince1970 * 1000 - startMs
      NSLog("[ExpoLocaltunnel] closeAllTunnelConnections done in \(Int(elapsed))ms")
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
