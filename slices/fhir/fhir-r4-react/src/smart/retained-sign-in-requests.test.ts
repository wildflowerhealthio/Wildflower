import { RetainedSignInRequestStore } from '@wildflowerhealthio/authorization-core/smart-client'
import { Effect, Layer, Option, Ref } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import {
  RetainedSelfAddressedSignInRequestStore,
  takeRetainedSignInRequests,
} from './retained-sign-in-requests.ts'
import { RootArrival } from './root-arrival.ts'

/**
 * Take the retained requests on `arrival` from memory-backed stores holding
 * one of each, and say what each store holds afterwards.
 */
const takeOn = (
  arrival: RootArrival
): Promise<{
  readonly taken: Option.Option<string>
  readonly signIn: Option.Option<string>
  readonly selfAddressed: Option.Option<string>
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const signIn = yield* Ref.make(Option.some('a-sign-in-request'))
      const selfAddressed = yield* Ref.make(Option.some('a-self-addressed-request'))
      const taken = yield* takeRetainedSignInRequests(arrival).pipe(
        Effect.provide(
          Layer.merge(
            RetainedSignInRequestStore.memoryBackedLayer(signIn),
            RetainedSelfAddressedSignInRequestStore.memoryBackedLayer(selfAddressed)
          )
        )
      )
      return { taken, signIn: yield* Ref.get(signIn), selfAddressed: yield* Ref.get(selfAddressed) }
    })
  )

describe('takeRetainedSignInRequests', () => {
  it('should take the self-addressed request and leave the sign-in request on a sign-in return', async () => {
    // Act
    const result = await takeOn(RootArrival.SignInReturn({ code: 'code-1', state: 'state-1' }))

    // Assert — `completeSignIn` takes the sign-in request itself
    expect(result).toEqual({
      taken: Option.some('a-self-addressed-request'),
      signIn: Option.some('a-sign-in-request'),
      selfAddressed: Option.none(),
    })
  })

  it('should take the self-addressed request and forget the sign-in request on any other arrival', async () => {
    // Act
    const result = await takeOn(RootArrival.SelfAddressedSignInReturn({ state: 'state-1' }))

    // Assert
    expect(result).toEqual({
      taken: Option.some('a-self-addressed-request'),
      signIn: Option.none(),
      selfAddressed: Option.none(),
    })
  })
})
