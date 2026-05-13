import { HttpApi } from '@effect/platform'
import * as Remotes from './remotes.ts'

const CollectorApi = HttpApi.make('CollectorApi').add(Remotes.httpApiGroup)

export { CollectorApi, Remotes }
