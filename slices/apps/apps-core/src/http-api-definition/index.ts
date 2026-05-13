import { HttpApi } from '@effect/platform'
import * as Apps from './apps.ts'
import * as Server from './server.ts'

const AppsApi = HttpApi.make('AppsApi').add(Server.httpApiGroup).add(Apps.httpApiGroup)

export { AppsApi, Apps, Server }
