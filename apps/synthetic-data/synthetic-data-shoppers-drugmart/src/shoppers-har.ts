import { DateTime, type Effect, type ParseResult } from 'effect'
import { chromeHarOf, chromeHarToJson, chromePageOf } from 'http-archive'
import {
  customerUrlOf,
  prescriptionHistoryUrlOf,
  prescriptionStatusUrlOf,
  SHOPPERS_PORTAL_ORIGIN,
} from 'shoppers-drugmart-source'
import * as ChromeHar from 'synthetic-data-fundamentals/chrome-har'
import { StoryDay } from 'synthetic-data-fundamentals/story'

import { customerPayloadOf } from './customer-payload.ts'
import { prescriptionHistoryPayloadOf } from './prescription-history-payload.ts'
import { prescriptionStatusPayloadOf } from './prescription-status-payload.ts'
import type { ShoppersAccount } from './shoppers-account.ts'
import { shoppersPrescriptionsOf } from './shoppers-prescription.ts'

/**
 * The Shoppers Drug Mart generator: a family account as the HAR a browser
 * session on mypharmacy.shoppersdrugmart.ca would export — sign in, the health
 * dashboard, the prescription dashboard with one `prescription-status` XHR per
 * prescription, then the prescription-history page with its history and
 * customers XHRs.
 *
 * @remarks
 * The page sequence is `shoppers-drugmart-collector`'s (login → health
 * dashboard → prescription dashboard → prescription history); the XHR URLs are
 * `shoppers-drugmart-source`'s, so its response kinds recognize them. The
 * dashboard fires the customers XHR too in a live session; the archive records
 * it once, from the history page, so no two entries share a URL. The capture
 * happens on the as-of day at 16:00 UTC.
 */

const LOGIN_URL = `${SHOPPERS_PORTAL_ORIGIN}/en/login`
const HEALTH_DASHBOARD_URL = `${SHOPPERS_PORTAL_ORIGIN}/en/healthdashboard/`
const PRESCRIPTION_DASHBOARD_URL = `${SHOPPERS_PORTAL_ORIGIN}/en/prescription-dashboard/?nav=featured-services/prescription-icon`
const PRESCRIPTION_HISTORY_URL = `${SHOPPERS_PORTAL_ORIGIN}/en/prescription-history`

/** The customers XHR's `expand` query, which the source does not read. */
const CUSTOMER_EXPAND_QUERY = '?expand=patients%2Cstores'

/** Documentation-range address (RFC 5737): the portal serves pages and API from one host. */
const PORTAL_IP = '198.51.100.24'

const JSON_MIME = 'application/json'

/** The headers the portal's single-page app sends on its API calls. */
const XHR_REQUEST_HEADERS: ChromeHar.ExchangeSpec['requestHeaders'] = [
  ['accept', 'application/json, text/plain, */*'],
  ['referer', `${SHOPPERS_PORTAL_ORIGIN}/`],
]

/** Milliseconds from the login navigation to each later request; the dashboard waits on 2FA. */
const HEALTH_DASHBOARD_AFTER_MILLIS = 94_300
const PRESCRIPTION_DASHBOARD_AFTER_MILLIS = 131_800
const FIRST_STATUS_XHR_AFTER_MILLIS = 133_150
/** Milliseconds between one prescription-status XHR and the next. */
const STATUS_XHR_SPACING_MILLIS = 85
const PRESCRIPTION_HISTORY_AFTER_MILLIS = 158_600
const HISTORY_XHR_AFTER_MILLIS = 159_920
const CUSTOMERS_XHR_AFTER_MILLIS = 160_040

/** The session's first request: 16:00 UTC on the as-of day, noon in Toronto. */
const captureStartOf = (asOf: DateTime.Utc): DateTime.Utc =>
  DateTime.add(StoryDay.toDateTime(asOf, 0), { hours: 16 })

/** A JSON XHR to the portal's API, from the page `pageref`. */
const xhrEntryOf = (
  pageref: string,
  startedAt: DateTime.Utc,
  url: string,
  body: unknown,
  waitMillis: number
): ChromeHar.Entry =>
  ChromeHar.entryOf({
    pageref,
    resourceType: 'xhr',
    startedAt,
    url,
    requestHeaders: XHR_REQUEST_HEADERS,
    mimeType: JSON_MIME,
    body: JSON.stringify(body),
    waitMillis,
    serverIPAddress: PORTAL_IP,
  })

/**
 * `account` — the people it manages and their stories — as `.har` file text.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param account - The family account the session signs in to
 * @returns HAR 1.2 JSON, byte-identical for the same inputs; fails only if
 *   `http-archive` cannot encode the archive built here
 */
const render = (
  asOf: DateTime.Utc,
  account: ShoppersAccount
): Effect.Effect<string, ParseResult.ParseError> => {
  const captureStart = captureStartOf(asOf)
  const after = (millis: number): DateTime.Utc => DateTime.add(captureStart, { millis })
  const shoppersPrescriptions = shoppersPrescriptionsOf(account)
  const loginPage = 'page_1'
  const healthDashboardPage = 'page_2'
  const prescriptionDashboardPage = 'page_3'
  const prescriptionHistoryPage = 'page_4'
  return chromeHarToJson(
    chromeHarOf(
      [
        chromePageOf({
          id: loginPage,
          url: LOGIN_URL,
          startedAt: captureStart,
          onContentLoadMillis: 488.2,
          onLoadMillis: 1_104.6,
        }),
        chromePageOf({
          id: healthDashboardPage,
          url: HEALTH_DASHBOARD_URL,
          startedAt: after(HEALTH_DASHBOARD_AFTER_MILLIS),
          onContentLoadMillis: 402.9,
          onLoadMillis: 1_687.3,
        }),
        chromePageOf({
          id: prescriptionDashboardPage,
          url: PRESCRIPTION_DASHBOARD_URL,
          startedAt: after(PRESCRIPTION_DASHBOARD_AFTER_MILLIS),
          onContentLoadMillis: 377.5,
          onLoadMillis: 1_512.8,
        }),
        chromePageOf({
          id: prescriptionHistoryPage,
          url: PRESCRIPTION_HISTORY_URL,
          startedAt: after(PRESCRIPTION_HISTORY_AFTER_MILLIS),
          onContentLoadMillis: 351.4,
          onLoadMillis: 1_398.1,
        }),
      ],
      [
        ChromeHar.navigationEntryOf({
          pageref: loginPage,
          startedAt: captureStart,
          url: LOGIN_URL,
          title: 'Sign in | Shoppers Drug Mart',
          waitMillis: 96.1,
          serverIPAddress: PORTAL_IP,
        }),
        ChromeHar.navigationEntryOf({
          pageref: healthDashboardPage,
          startedAt: after(HEALTH_DASHBOARD_AFTER_MILLIS),
          url: HEALTH_DASHBOARD_URL,
          title: 'Health Dashboard | Shoppers Drug Mart',
          waitMillis: 71.4,
          serverIPAddress: PORTAL_IP,
        }),
        ChromeHar.navigationEntryOf({
          pageref: prescriptionDashboardPage,
          startedAt: after(PRESCRIPTION_DASHBOARD_AFTER_MILLIS),
          url: PRESCRIPTION_DASHBOARD_URL,
          title: 'Prescriptions | Shoppers Drug Mart',
          waitMillis: 68.8,
          serverIPAddress: PORTAL_IP,
        }),
        ...shoppersPrescriptions.map((shoppersPrescription, index) =>
          xhrEntryOf(
            prescriptionDashboardPage,
            after(FIRST_STATUS_XHR_AFTER_MILLIS + index * STATUS_XHR_SPACING_MILLIS),
            prescriptionStatusUrlOf(shoppersPrescription.prescriptionId),
            prescriptionStatusPayloadOf(asOf, account, shoppersPrescription),
            212.5
          )
        ),
        ChromeHar.navigationEntryOf({
          pageref: prescriptionHistoryPage,
          startedAt: after(PRESCRIPTION_HISTORY_AFTER_MILLIS),
          url: PRESCRIPTION_HISTORY_URL,
          title: 'Prescription History | Shoppers Drug Mart',
          waitMillis: 66.2,
          serverIPAddress: PORTAL_IP,
        }),
        xhrEntryOf(
          prescriptionHistoryPage,
          after(HISTORY_XHR_AFTER_MILLIS),
          prescriptionHistoryUrlOf(account.pcid),
          prescriptionHistoryPayloadOf(asOf, account, shoppersPrescriptions),
          538.7
        ),
        xhrEntryOf(
          prescriptionHistoryPage,
          after(CUSTOMERS_XHR_AFTER_MILLIS),
          `${customerUrlOf(account.pcid)}${CUSTOMER_EXPAND_QUERY}`,
          customerPayloadOf(account),
          187.9
        ),
      ]
    ),
    // Indented, as a DevTools "Save all as HAR" export writes the file.
    { pretty: true }
  )
}

export { render }
