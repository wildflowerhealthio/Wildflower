import { makeSchema, State } from '@livestore/livestore'
import {
  events as fhirEvents,
  materializers as fhirMaterializers,
  tables as fhirTables,
} from 'emr-core/livestore'
import {
  events as gatekeeperEvents,
  materializers as gatekeeperMaterializers,
  tables as gatekeeperTables,
} from 'gatekeeper-core/livestore'

const tables = {
  ...fhirTables,
  ...gatekeeperTables,
} as const

const events = {
  ...fhirEvents,
  ...gatekeeperEvents,
}

const materializers = State.SQLite.materializers(events, {
  ...fhirMaterializers,
  ...gatekeeperMaterializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export { schema, events, tables }
