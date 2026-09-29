import { DateTime } from 'effect'

import * as ChromeHar from '../har/chrome-har.ts'
import * as StoryDay from '../story-day.ts'
import { customerPayloadOf } from './customer-payload.ts'
import { prescriptionHistoryPayloadOf } from './prescription-history-payload.ts'
import { prescriptionStatusPayloadOf } from './prescription-status-payload.ts'
import type { ShoppersAccount } from './shoppers-account.ts'
import { shoppersPrescriptionsOf } from './shoppers-prescription.ts'

/**
 * The Shoppers Drug Mart renderer: a family account as the HAR a browser
 * session on mypharmacy.shoppersdrugmart.ca would export — sign in, the health
 * dashboard, the prescription dashboard with one `prescription-status` XHR per
 * prescription, then the prescription-history page with its history and
 * customers XHRs.
 *
 * @remarks
 * The page sequence is `shoppers-drugmart-collector`'s (login → health
 * dashboard → prescription dashboard → prescription history). The dashboard
 * fires the customers XHR too in a live session; the archive records it once,
 * from the history page, so no two entries share a method, URL and body. The
 * capture happens on the as-of day; the pages carry small HTML bodies that no
 * importer claims, as a real export's navigations do.
 */

const PORTAL_ORIGIN = 'https://mypharmacy.shoppersdrugmart.ca'
const LOGIN_URL = `${PORTAL_ORIGIN}/en/login`
const HEALTH_DASHBOARD_URL = `${PORTAL_ORIGIN}/en/healthdashboard/`
const PRESCRIPTION_DASHBOARD_URL = `${PORTAL_ORIGIN}/en/prescription-dashboard/?nav=featured-services/prescription-icon`
const PRESCRIPTION_HISTORY_URL = `${PORTAL_ORIGIN}/en/prescription-history`
const API_BASE = `${PORTAL_ORIGIN}/api/v1`

/** The customers XHR's `expand`, which the importer does not read. */
const CUSTOMER_EXPAND = 'patients,stores'

/** Documentation-range address (RFC 5737): the portal serves pages and API from one host. */
const PORTAL_IP = '198.51.100.24'

const HTML = 'text/html; charset=utf-8'
const JSON_MIME = 'application/json'

/** The headers the portal's single-page app sends on its API calls. */
const XHR_REQUEST_HEADERS: readonly ChromeHar.NameValue[] = [
  { name: 'accept', value: 'application/json, text/plain, */*' },
  { name: 'referer', value: `${PORTAL_ORIGIN}/` },
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

/** The customers XHR URL for `account`, which `CustomerResponseKind` recognizes. */
const customerUrlOf = (account: ShoppersAccount): string =>
  `${API_BASE}/customers/pcid/${account.pcid}?expand=${encodeURIComponent(CUSTOMER_EXPAND)}`

/** A prescription's status XHR URL, which `PrescriptionResponseKind` recognizes. */
const prescriptionStatusUrlOf = (prescriptionId: string): string =>
  `${API_BASE}/prescriptions/${prescriptionId}/prescription-status`

/** The history XHR URL for `account`, which `PrescriptionHistoryResponseKind` recognizes. */
const prescriptionHistoryUrlOf = (account: ShoppersAccount): string =>
  `${API_BASE}/prescription-history?customerId=${account.pcid}`

/**
 * `account` — its holder, the people it manages and their stories — as `.har`
 * file text.
 *
 * @param asOf - The as-of instant every story day is dated from; only its UTC
 *   calendar day matters
 * @param account - The family account the session signs in to
 * @returns HAR 1.2 JSON, byte-identical for the same inputs
 */
const render = (asOf: DateTime.Utc, account: ShoppersAccount): string => {
  const captureStart = captureStartOf(asOf)
  const after = (millis: number): DateTime.Utc => DateTime.add(captureStart, { millis })
  const shoppersPrescriptions = shoppersPrescriptionsOf(account)
  const loginPage = 'page_1'
  const healthDashboardPage = 'page_2'
  const prescriptionDashboardPage = 'page_3'
  const prescriptionHistoryPage = 'page_4'
  const documentEntryOf = (
    pageref: string,
    startedAt: DateTime.Utc,
    url: string,
    title: string,
    waitMillis: number
  ): ChromeHar.Entry =>
    ChromeHar.entryOf({
      pageref,
      resourceType: 'document',
      startedAt,
      url,
      requestHeaders: ChromeHar.DOCUMENT_REQUEST_HEADERS,
      mimeType: HTML,
      body: ChromeHar.appShellOf(title),
      waitMillis,
      serverIPAddress: PORTAL_IP,
    })
  const xhrEntryOf = (
    pageref: string,
    startedAt: DateTime.Utc,
    url: string,
    body: string,
    waitMillis: number
  ): ChromeHar.Entry =>
    ChromeHar.entryOf({
      pageref,
      resourceType: 'xhr',
      startedAt,
      url,
      requestHeaders: XHR_REQUEST_HEADERS,
      mimeType: JSON_MIME,
      body,
      waitMillis,
      serverIPAddress: PORTAL_IP,
    })
  return ChromeHar.toJson(
    ChromeHar.archiveOf(
      [
        ChromeHar.pageOf({
          id: loginPage,
          url: LOGIN_URL,
          startedAt: captureStart,
          onContentLoadMillis: 488.2,
          onLoadMillis: 1_104.6,
        }),
        ChromeHar.pageOf({
          id: healthDashboardPage,
          url: HEALTH_DASHBOARD_URL,
          startedAt: after(HEALTH_DASHBOARD_AFTER_MILLIS),
          onContentLoadMillis: 402.9,
          onLoadMillis: 1_687.3,
        }),
        ChromeHar.pageOf({
          id: prescriptionDashboardPage,
          url: PRESCRIPTION_DASHBOARD_URL,
          startedAt: after(PRESCRIPTION_DASHBOARD_AFTER_MILLIS),
          onContentLoadMillis: 377.5,
          onLoadMillis: 1_512.8,
        }),
        ChromeHar.pageOf({
          id: prescriptionHistoryPage,
          url: PRESCRIPTION_HISTORY_URL,
          startedAt: after(PRESCRIPTION_HISTORY_AFTER_MILLIS),
          onContentLoadMillis: 351.4,
          onLoadMillis: 1_398.1,
        }),
      ],
      [
        documentEntryOf(loginPage, captureStart, LOGIN_URL, 'Sign in | Shoppers Drug Mart', 96.1),
        documentEntryOf(
          healthDashboardPage,
          after(HEALTH_DASHBOARD_AFTER_MILLIS),
          HEALTH_DASHBOARD_URL,
          'Health Dashboard | Shoppers Drug Mart',
          71.4
        ),
        documentEntryOf(
          prescriptionDashboardPage,
          after(PRESCRIPTION_DASHBOARD_AFTER_MILLIS),
          PRESCRIPTION_DASHBOARD_URL,
          'Prescriptions | Shoppers Drug Mart',
          68.8
        ),
        ...shoppersPrescriptions.map((shoppersPrescription, index) =>
          xhrEntryOf(
            prescriptionDashboardPage,
            after(FIRST_STATUS_XHR_AFTER_MILLIS + index * STATUS_XHR_SPACING_MILLIS),
            prescriptionStatusUrlOf(shoppersPrescription.prescriptionId),
            JSON.stringify(prescriptionStatusPayloadOf(asOf, account, shoppersPrescription)),
            212.5
          )
        ),
        documentEntryOf(
          prescriptionHistoryPage,
          after(PRESCRIPTION_HISTORY_AFTER_MILLIS),
          PRESCRIPTION_HISTORY_URL,
          'Prescription History | Shoppers Drug Mart',
          66.2
        ),
        xhrEntryOf(
          prescriptionHistoryPage,
          after(HISTORY_XHR_AFTER_MILLIS),
          prescriptionHistoryUrlOf(account),
          JSON.stringify(prescriptionHistoryPayloadOf(asOf, account, shoppersPrescriptions)),
          538.7
        ),
        xhrEntryOf(
          prescriptionHistoryPage,
          after(CUSTOMERS_XHR_AFTER_MILLIS),
          customerUrlOf(account),
          JSON.stringify(customerPayloadOf(account)),
          187.9
        ),
      ]
    )
  )
}

export { render }
export type { ShoppersAccount }
