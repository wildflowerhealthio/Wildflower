import { makeSchema, State } from '@livestore/livestore'
import * as AppsLivestore from 'apps-core/livestore'
import * as CollectorLivestore from 'collector-core/livestore'
import * as EmrLivestore from 'emr-core/livestore'
import * as GatekeeperLivestore from 'gatekeeper-core/livestore'
import * as LocalHttpServerLivestore from 'local-http-server-core/livestore'
import * as TunnelLivestore from 'tunnel-core/livestore'

const tables = {
  ...EmrLivestore.tables,
  ...GatekeeperLivestore.tables,
  ...CollectorLivestore.tables,
  ...AppsLivestore.tables,
  ...LocalHttpServerLivestore.tables,
  ...TunnelLivestore.tables,
} as const

const events = {
  ...EmrLivestore.events,
  ...GatekeeperLivestore.events,
  ...CollectorLivestore.events,
  ...AppsLivestore.events,
  ...LocalHttpServerLivestore.events,
  ...TunnelLivestore.events,
}

const materializers = State.SQLite.materializers(events, {
  ...EmrLivestore.materializers,
  ...GatekeeperLivestore.materializers,
  ...CollectorLivestore.materializers,
  ...AppsLivestore.materializers,
  ...TunnelLivestore.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export { schema, events, tables }
