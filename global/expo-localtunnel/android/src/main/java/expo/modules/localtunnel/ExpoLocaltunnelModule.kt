package expo.modules.localtunnel

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class TunnelConnectionConfig : Record {
  @Field val remoteHost: String = ""
  @Field val remotePort: Int = 0
  @Field val localHost: String = "localhost"
  @Field val localPort: Int = 0
  @Field val localHostHeader: String? = null
}

class ExpoLocaltunnelModule : Module() {
  private val connections = mutableMapOf<String, TunnelConnection>()

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
      connections.values.forEach { it.close() }
      connections.clear()
    }

    AsyncFunction("createTunnelConnection") { connectionId: String, config: TunnelConnectionConfig ->
      // Clean up existing connection with this ID if any
      connections[connectionId]?.close()

      val conn = TunnelConnection(
        id = connectionId,
        config = config
      ) { name, body -> sendEvent(name, body) }
      connections[connectionId] = conn
      conn.connectRemote()
    }

    AsyncFunction("closeTunnelConnection") { connectionId: String ->
      connections[connectionId]?.close()
      connections.remove(connectionId)
    }

    AsyncFunction("closeAllTunnelConnections") {
      connections.values.forEach { it.close() }
      connections.clear()
    }
  }
}
