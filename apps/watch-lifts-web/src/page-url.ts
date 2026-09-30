import { Either } from 'effect'
import { ReturnTarget } from 'pebble-configuration'
import { LiftSettings, PhoneSettings } from 'watch-lifts-core'

/** What the page is opened with: the weights to start from and where to hand them back. */
interface PageInputs {
  /**
   * The weights in the `PhoneSettings.PARAM` query parameter, or
   * `LiftSettings.DEFAULT` when it is missing or not the settings.
   */
  readonly settings: LiftSettings.Type
  /** The Pebble phone app's `return_to`, or why the page will not hand off to it. */
  readonly returnTarget: Either.Either<ReturnTarget.Type, ReturnTarget.ForeignReturnTargetError>
}

/**
 * Reads the page's inputs from its URL, as the watchapp's PebbleKit JS
 * (`PhoneSettings.configurationUrl`) and the Pebble phone app (`return_to`)
 * write them. A page opened without `return_to` hands back to the guide's
 * default, `ReturnTarget.DEFAULT`.
 */
const readPageUrl = (url: URL): PageInputs => {
  const weights = url.searchParams.get(PhoneSettings.PARAM)
  return {
    settings:
      weights === null
        ? LiftSettings.DEFAULT
        : Either.getOrElse(LiftSettings.fromJson(weights), () => LiftSettings.DEFAULT),
    returnTarget: ReturnTarget.decode(
      url.searchParams.get(ReturnTarget.PARAM) ?? ReturnTarget.DEFAULT
    ),
  }
}

export { readPageUrl, type PageInputs }
