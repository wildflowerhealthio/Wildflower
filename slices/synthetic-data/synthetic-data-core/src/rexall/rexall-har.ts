import { DateTime } from 'effect'

import * as ChromeHar from '../har/chrome-har.ts'
import * as StoryDay from '../story-day.ts'
import type { Story } from '../story.ts'
import { profileOf } from './carebook-profile.ts'
import { medicationListUrlOf, searchsetOf } from './carebook-searchset.ts'
import type { RexallAccount } from './rexall-account.ts'

/**
 * The Rexall Be Well renderer: a story as the HAR a browser session on
 * letsbewell.ca would export — sign in, open the prescriptions page, and the
 * two XHRs that page makes (the profile and the prescriptions searchset).
 *
 * @remarks
 * The page sequence is `rexall-be-well-collector`'s (`letsbewell.ca/sign-in`,
 * then `app.letsbewell.ca/health/prescriptions`). The capture happens on the
 * as-of day at a time hashed from the account; the two pages carry small HTML
 * bodies that no importer claims, as a real export's navigations do.
 */

const SIGN_IN_URL = 'https://letsbewell.ca/sign-in'
const PRESCRIPTIONS_URL = 'https://app.letsbewell.ca/health/prescriptions'
const PROFILE_URL = 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me'

/** Documentation-range addresses (RFC 5737): the export records one per host. */
const SIGN_IN_IP = '203.0.113.10'
const APP_IP = '203.0.113.11'
const TUNNEL_IP = '203.0.113.12'

const HTML = 'text/html; charset=utf-8'
const JSON_MIME = 'application/json; charset=utf-8'

/** The headers the single-page app sends on its API calls. */
const XHR_REQUEST_HEADERS: readonly ChromeHar.NameValue[] = [
  { name: 'accept', value: 'application/json, text/plain, */*' },
  { name: 'origin', value: 'https://app.letsbewell.ca' },
  { name: 'referer', value: 'https://app.letsbewell.ca/' },
]

/** Milliseconds from the sign-in navigation to each later request. */
const PRESCRIPTIONS_PAGE_AFTER_MILLIS = 18_400
const PROFILE_XHR_AFTER_MILLIS = 19_650
const LIST_XHR_AFTER_MILLIS = 19_910

/** The session's first request: 15:00 UTC on the as-of day, late morning in Toronto. */
const captureStartOf = (asOf: DateTime.Utc): DateTime.Utc =>
  DateTime.add(StoryDay.toDateTime(asOf, 0), { hours: 15 })

/**
 * `story`, filled under `account`, as `.har` file text.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param story - Whose profile and prescriptions the session shows
 * @param account - The Rexall account the prescriptions are filled under
 * @returns HAR 1.2 JSON, byte-identical for the same inputs
 */
const render = (asOf: DateTime.Utc, story: Story, account: RexallAccount): string => {
  const captureStart = captureStartOf(asOf)
  const after = (millis: number): DateTime.Utc => DateTime.add(captureStart, { millis })
  const signInPage = 'page_1'
  const prescriptionsPage = 'page_2'
  return ChromeHar.toJson(
    ChromeHar.archiveOf(
      [
        ChromeHar.pageOf({
          id: signInPage,
          url: SIGN_IN_URL,
          startedAt: captureStart,
          onContentLoadMillis: 412.7,
          onLoadMillis: 988.3,
        }),
        ChromeHar.pageOf({
          id: prescriptionsPage,
          url: PRESCRIPTIONS_URL,
          startedAt: after(PRESCRIPTIONS_PAGE_AFTER_MILLIS),
          onContentLoadMillis: 356.1,
          onLoadMillis: 1210.9,
        }),
      ],
      [
        ChromeHar.entryOf({
          pageref: signInPage,
          resourceType: 'document',
          startedAt: captureStart,
          url: SIGN_IN_URL,
          requestHeaders: ChromeHar.DOCUMENT_REQUEST_HEADERS,
          mimeType: HTML,
          body: ChromeHar.appShellOf('Sign in | Be Well'),
          waitMillis: 88.4,
          serverIPAddress: SIGN_IN_IP,
        }),
        ChromeHar.entryOf({
          pageref: prescriptionsPage,
          resourceType: 'document',
          startedAt: after(PRESCRIPTIONS_PAGE_AFTER_MILLIS),
          url: PRESCRIPTIONS_URL,
          requestHeaders: ChromeHar.DOCUMENT_REQUEST_HEADERS,
          mimeType: HTML,
          body: ChromeHar.appShellOf('Prescriptions | Be Well'),
          waitMillis: 64.9,
          serverIPAddress: APP_IP,
        }),
        ChromeHar.entryOf({
          pageref: prescriptionsPage,
          resourceType: 'xhr',
          startedAt: after(PROFILE_XHR_AFTER_MILLIS),
          url: PROFILE_URL,
          requestHeaders: XHR_REQUEST_HEADERS,
          mimeType: JSON_MIME,
          body: JSON.stringify(profileOf(asOf, story.person, account)),
          waitMillis: 142.6,
          serverIPAddress: TUNNEL_IP,
        }),
        ChromeHar.entryOf({
          pageref: prescriptionsPage,
          resourceType: 'xhr',
          startedAt: after(LIST_XHR_AFTER_MILLIS),
          url: medicationListUrlOf(account),
          requestHeaders: XHR_REQUEST_HEADERS,
          mimeType: JSON_MIME,
          body: JSON.stringify(searchsetOf(asOf, account, story.prescriptions)),
          waitMillis: 611.3,
          serverIPAddress: TUNNEL_IP,
        }),
      ]
    )
  )
}

export { render }
export { sourcePatientOf } from './rexall-account.ts'
export type { RexallAccount }
