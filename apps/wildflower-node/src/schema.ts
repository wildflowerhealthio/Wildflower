import { makeSchema, State } from '@livestore/livestore'
import * as EmrLivestore from 'emr-core/livestore'
import * as GatekeeperLivestore from 'gatekeeper-core/livestore'

const tables = {
  ...EmrLivestore.tables,
  ...GatekeeperLivestore.tables,
} as const

const events = {
  ...EmrLivestore.events,
  ...GatekeeperLivestore.events,
}

const materializers = State.SQLite.materializers(events, {
  ...EmrLivestore.materializers,
  ...GatekeeperLivestore.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export { schema, events, tables }
