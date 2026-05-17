import { type HttpApiGroup, HttpApiBuilder } from '@effect/platform'
import { Layer } from 'effect'
import { CollectorApi } from '../http-api-definition/index.ts'
import type { CollectorStore } from '../livestore/index.ts'
import * as Remotes from './remotes.ts'

const CollectorApiHandlersLive = Layer.mergeAll(Remotes.layer)

const CollectorApiLive = HttpApiBuilder.api(CollectorApi).pipe(
  Layer.provide(CollectorApiHandlersLive)
)

type CollectorGroupNames = 'collector-remotes'

const CollectorApiHandlersFor = <ParentId extends string>(): Layer.Layer<
  HttpApiGroup.ApiGroup<ParentId, CollectorGroupNames>,
  never,
  CollectorStore
> =>
  // See gatekeeper-core's AuthApiHandlersFor: the phantom-id bridge lets a
  // Layer built against CollectorApi satisfy a parent ApiId's group requirement.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  CollectorApiHandlersLive as unknown as Layer.Layer<
    HttpApiGroup.ApiGroup<ParentId, CollectorGroupNames>,
    never,
    CollectorStore
  >

export { CollectorApi, CollectorApiHandlersLive, CollectorApiHandlersFor, CollectorApiLive }
