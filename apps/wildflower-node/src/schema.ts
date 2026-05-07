import { makeSchema, State } from '@livestore/livestore'
import {
  events as appsEvents,
  materializers as appsMaterializers,
  tables as appsTables,
} from 'apps-core/livestore'
import {
  events as collectorEvents,
  materializers as collectorMaterializers,
  tables as collectorTables,
} from 'collector-core/livestore'
import { ApprovedApps, HttpRequests, JsonWebKeys } from 'gatekeeper-core/livestore'
import {
  events as fhirEvents,
  materializers as fhirMaterializers,
  tables as fhirTables,
} from 'store-core/livestore'

const tables = {
  ...fhirTables,
  ...collectorTables,
  ...appsTables,
  httpRequests: HttpRequests.table,
  approvedApps: ApprovedApps.table,
  jsonWebKeys: JsonWebKeys.table,
} as const

const events = {
  ...fhirEvents,
  ...collectorEvents,
  ...appsEvents,
  ...JsonWebKeys.events,
  ...ApprovedApps.events,
  ...HttpRequests.events,
}

const materializers = State.SQLite.materializers(events, {
  ...fhirMaterializers,
  ...collectorMaterializers,
  ...appsMaterializers,
  ...JsonWebKeys.materializers,
  ...ApprovedApps.materializers,
  ...HttpRequests.materializers,
})

const state = State.SQLite.makeState({ tables, materializers })

const schema = makeSchema({ events, state })

export { schema, events, tables }
