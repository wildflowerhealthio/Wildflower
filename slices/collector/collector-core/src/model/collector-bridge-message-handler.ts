import { type CancelSnifferRequestMessage } from 'browser-sniffer-core'
import { Either, type ParseResult, Effect, Encoding, MutableHashMap, Option } from 'effect'
import { UnknownException } from 'effect/Cause'
import type CollectorBridge from '../bridge.ts'
import type * as EntityDefinition from './entity-definition.ts'
import type * as Remote from './remote.ts'
import { RemoteResponse } from './response.ts'

type Service = CollectorBridge['Web']['HandlerTag']['Service']

interface CollectorBridgeMessageHandler extends Service {
  readonly inProgressResponses: MutableHashMap.MutableHashMap<string, RemoteResponse>
}

const make = <TResources>({
  remote,
  sendMessage,
  onResult: handleResult,
}: {
  remote: Remote.Remote<TResources>
  sendMessage: (
    message: typeof CancelSnifferRequestMessage.Type
  ) => Effect.Effect<void, never, never>
  onResult: (args: {
    readonly response: RemoteResponse
    readonly result: Either.Either<
      EntityDefinition.Parsed<TResources>,
      ParseResult.ParseError | UnknownException
    >
  }) => void
}): CollectorBridgeMessageHandler => {
  const inProgressResponses = MutableHashMap.empty<string, RemoteResponse>()

  const ResponseStart: Service['ResponseStart'] = (event) => {
    if (remote.entityDefinitions.some((e) => e.isFoundAt(event.url))) {
      MutableHashMap.set(
        event.id,
        new RemoteResponse(event.url, event.status, event.statusText, event.headers)
      )(inProgressResponses)
      return Effect.void
    } else {
      return sendMessage({
        _tag: 'CancelSnifferRequest',
        id: event.id,
      } satisfies typeof CancelSnifferRequestMessage.Type)
    }
  }

  const ResponseData: Service['ResponseData'] = (event) =>
    Effect.sync(() => {
      const maybeResponse = MutableHashMap.get(event.id)(inProgressResponses)
      if (Option.isNone(maybeResponse)) {
        throw new Error('Received response data for response that is not being tracked')
      }
      const dataArrayEither = Encoding.decodeBase64(event.data)
      Either.match(dataArrayEither, {
        onLeft: (error) => {
          throw new Error(`Failed to decode base64 data: ${JSON.stringify(error)}`)
        },
        onRight: (dataArray) => {
          maybeResponse.value.appendChunk(dataArray)
        },
      })
    })

  const ResponseFinished: Service['ResponseFinished'] = (event) =>
    Effect.sync(() => {
      const response = Option.getOrThrow(MutableHashMap.get(event.id)(inProgressResponses))
      MutableHashMap.remove(inProgressResponses, event.id)

      const entity = remote.entityDefinitions.find((e) => e.isFoundAt(response.url))
      if (entity === undefined) return

      handleResult({ response, result: entity.parse(response) })
    })

  const RequestError: Service['RequestError'] = (event) =>
    Effect.sync(() => {
      const response = Option.getOrThrow(MutableHashMap.get(event.id)(inProgressResponses))
      MutableHashMap.remove(inProgressResponses, event.id)

      const entity = remote.entityDefinitions.find((e) => e.isFoundAt(response.url))
      if (entity === undefined) return

      handleResult({ response, result: Either.left(new UnknownException(event.message)) })
    })

  return {
    inProgressResponses,
    ResponseStart,
    ResponseData,
    ResponseFinished,
    RequestError,
  }
}

export type { CollectorBridgeMessageHandler }
export { make }
