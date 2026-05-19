package expo.modules.localtunnel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.concurrent.ConcurrentHashMap

class TunnelConnectionConfig : Record {
  @Field val remoteHost: String = ""
  @Field val remotePort: Int = 0
  @Field val localHost: String = "localhost"
  @Field val localPort: Int = 0
  @Field val localHostHeader: String? = null
}

class ExpoLocaltunnelModule : Module() {
  // ConcurrentHashMap: AsyncFunction handlers (JS dispatch thread) and event
  // callbacks from TunnelConnection (connection-internal threads) both touch
  // this map. Per-key operations are atomic; we use compute/remove for any
  // compound (read-then-write) operations to keep them atomic too.
  private val connections = ConcurrentHashMap<String, TunnelConnection>()

  override fun definition() = ModuleDefinition {
    Name("ExpoLocaltunnel")

    Events(
      "onConnectionOpen",
      "onConnectionClose",
      "onConnectionError",
      "onConnectionDead",
      "onRequest"
    )

    OnDestroy {
      // Snapshot then clear: drain entries atomically so we don't miss or
      // double-close any concurrently-added connection.
      val snapshot = ArrayList(connections.values)
      connections.clear()
      snapshot.forEach { it.close() }
    }

    AsyncFunction("createTunnelConnection") { connectionId: String, config: TunnelConnectionConfig ->
      val newConn = TunnelConnection(
        id = connectionId,
        config = config
      ) { name, body -> sendEvent(name, body) }
      // Atomically replace any existing entry for this id. The previous value
      // (if any) is closed after the swap so handlers always see the new one.
      val previous = connections.put(connectionId, newConn)
      previous?.close()
      newConn.connectRemote()
    }

    AsyncFunction("closeTunnelConnection") { connectionId: String ->
      // remove() returns the previous mapping atomically.
      connections.remove(connectionId)?.close()
    }

    AsyncFunction("closeAllTunnelConnections") {
      val snapshot = ArrayList(connections.values)
      connections.clear()
      snapshot.forEach { it.close() }
    }
  }
}
