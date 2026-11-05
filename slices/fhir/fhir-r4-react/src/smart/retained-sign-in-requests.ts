import {
  BrowserSignIn,
  forgetRetainedSignInRequest,
  memoryBackedRetainedRequestStore,
  type RetainedRequestStorage,
  type RetainedRequestStoreShape,
  type RetainedRequestUnusable,
  type RetainedSignInRequestStore,
  sessionStorageBackedRetainedRequestStore,
  type SignInServices,
  type SignInWindow,
} from '@wildflowerhealthio/authorization-core/smart-client'
import { Context, Effect, Layer, Option, type Ref, Schema } from 'effect'

import type { RootArrival } from './root-arrival.ts'
import { FhirBaseUrl } from './smart-connection.ts'

/** The app's SMART registration: the client it signs in as, and the scopes it asks for. */
interface SmartRegistration {
  readonly clientId: string
  readonly scope: string
}

/**
 * The `sessionStorage` key `authorization-core`'s sign-in retains its sign-in
 * request at, for every SMART app on this package. `sessionStorage` is per
 * tab, so it is one key for the one sign-in a tab can be in.
 */
const RETAINED_SIGN_IN_REQUEST_KEY = 'fhir-r4-react.retained-sign-in-request'

/**
 * The `sessionStorage` key the {@link RetainedSelfAddressedSignInRequest} this
 * tab started lives at until the redirect target completes it.
 */
const RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY =
  'fhir-r4-react.retained-self-addressed-sign-in-request'

/**
 * A self-addressed sign-in in progress, retained across the redirect in
 * `sessionStorage`: the open server, and the `state` the redirect must come
 * back with. It holds no credential.
 */
const RetainedSelfAddressedSignInRequest = Schema.Struct({
  /** The `state` the redirect carries, which its return must carry back. */
  expectedState: Schema.String,
  fhirBaseUrl: FhirBaseUrl,
})
type RetainedSelfAddressedSignInRequest = Schema.Schema.Type<
  typeof RetainedSelfAddressedSignInRequest
>

const RetainedSelfAddressedSignInRequestJson = Schema.parseJson(RetainedSelfAddressedSignInRequest)
const encodeRetainedSelfAddressedSignInRequest = Schema.encodeSync(
  RetainedSelfAddressedSignInRequestJson
)
const decodeRetainedSelfAddressedSignInRequest = Schema.decodeUnknownOption(
  RetainedSelfAddressedSignInRequestJson
)

/**
 * Where the {@link RetainedSelfAddressedSignInRequest} a tab started is kept
 * until the redirect target completes it, as its JSON. The same store
 * `authorization-core` keeps its own retained sign-in request in, under a tag
 * of its own, so the two requests never share a key.
 */
class RetainedSelfAddressedSignInRequestStore extends Context.Tag(
  'fhir-r4-react/RetainedSelfAddressedSignInRequestStore'
)<RetainedSelfAddressedSignInRequestStore, RetainedRequestStoreShape>() {
  /** The store at `key` in `page`'s `sessionStorage`. */
  static readonly sessionStorageBackedLayer = (
    page: { readonly sessionStorage: RetainedRequestStorage },
    key: string
  ): Layer.Layer<RetainedSelfAddressedSignInRequestStore> =>
    Layer.succeed(
      RetainedSelfAddressedSignInRequestStore,
      sessionStorageBackedRetainedRequestStore(page, key)
    )

  /** A store in `held`, which never refuses: for a test to read and seed. */
  static readonly memoryBackedLayer = (
    held: Ref.Ref<Option.Option<string>>
  ): Layer.Layer<RetainedSelfAddressedSignInRequestStore> =>
    Layer.succeed(RetainedSelfAddressedSignInRequestStore, memoryBackedRetainedRequestStore(held))
}

/** Every service a SMART app's sign-in runs against, both kinds of sign-in. */
type SmartSignInServices = SignInServices | RetainedSelfAddressedSignInRequestStore

/**
 * The sign-in services of a SMART app's `page`, its retained sign-in request
 * kept at {@link RETAINED_SIGN_IN_REQUEST_KEY} and its retained self-addressed
 * one at {@link RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY}: what the edges
 * that run a sign-in Effect provide it with.
 */
const smartSignInLayer = (page: SignInWindow): Layer.Layer<SmartSignInServices> =>
  Layer.merge(
    BrowserSignIn.layerFromWindow(page, RETAINED_SIGN_IN_REQUEST_KEY),
    RetainedSelfAddressedSignInRequestStore.sessionStorageBackedLayer(
      page,
      RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY
    )
  )

/** Retain `request` for the redirect's return, before the page leaves. */
const retainSelfAddressedSignInRequest = (
  request: RetainedSelfAddressedSignInRequest
): Effect.Effect<void, RetainedRequestUnusable, RetainedSelfAddressedSignInRequestStore> =>
  Effect.flatMap(RetainedSelfAddressedSignInRequestStore, (store) =>
    store.retain(encodeRetainedSelfAddressedSignInRequest(request))
  )

/**
 * Take every retained sign-in request an arrival can complete out of its
 * store: the one rule every sign-in arrival at the app root
 * follows, before it decides what to show.
 *
 * @returns The retained self-addressed sign-in request as stored, `None` when
 *   there is none.
 *
 * @remarks
 * A `SignInReturn` leaves `authorization-core`'s retained request to
 * `completeSignIn`, which takes it before it redeems the code; any other
 * arrival forgets it. The self-addressed request is taken either way, and
 * decoded only by the arrival that completes it
 * ({@link completeSelfAddressedSignIn}). A storage that throws fails with
 * `RetainedRequestUnusable`, except on a `SignInReturn` taking the
 * self-addressed request, which is not that arrival's to complete: it returns
 * `None` instead.
 */
const takeRetainedSignInRequests = (
  arrival: RootArrival
): Effect.Effect<
  Option.Option<string>,
  RetainedRequestUnusable,
  RetainedSignInRequestStore | RetainedSelfAddressedSignInRequestStore
> =>
  Effect.gen(function* () {
    const takingSelfAddressed = Effect.flatMap(
      RetainedSelfAddressedSignInRequestStore,
      (store) => store.take
    )
    if (arrival._tag === 'SignInReturn') {
      return yield* takingSelfAddressed.pipe(Effect.orElseSucceed(Option.none))
    }
    const retained = yield* takingSelfAddressed
    yield* forgetRetainedSignInRequest
    return retained
  })

export {
  decodeRetainedSelfAddressedSignInRequest,
  RETAINED_SELF_ADDRESSED_SIGN_IN_REQUEST_KEY,
  RETAINED_SIGN_IN_REQUEST_KEY,
  RetainedSelfAddressedSignInRequest,
  RetainedSelfAddressedSignInRequestStore,
  retainSelfAddressedSignInRequest,
  smartSignInLayer,
  takeRetainedSignInRequests,
  type SmartRegistration,
  type SmartSignInServices,
}
