import { DEFAULT_DATA_SET_URL } from 'synthetic-data-react'

/**
 * The data set URL the app reads, kept in `sessionStorage` so it survives the
 * SMART redirect: a bare visit's `?dataSet=` is gone by the time the OAuth
 * callback lands on the app root, and a URL typed after the launch outlives a
 * reload of the tab.
 */

/** The query parameter a bare visit names a data set with. */
const DATA_SET_PARAM = 'dataSet'

/** Where the URL is kept, in this tab's `sessionStorage`. */
const DATA_SET_STORAGE_KEY = 'synthetic-data-app:data-set-url'

/** Keep `dataSetUrl` as the one to read in this tab. */
const rememberDataSetUrl = (storage: Storage, dataSetUrl: string): void => {
  storage.setItem(DATA_SET_STORAGE_KEY, dataSetUrl)
}

/**
 * Keep the page's `?dataSet=`, when it has one, as the URL to read once the
 * app is connected. Called from the entry before the SMART handshake, while
 * the address bar still carries it.
 */
const rememberDataSetParam = (window: Window): void => {
  const dataSetUrl = new URLSearchParams(window.location.search).get(DATA_SET_PARAM)
  if (dataSetUrl !== null) rememberDataSetUrl(window.sessionStorage, dataSetUrl)
}

/** The URL to read: the one kept in this tab, else the published data set. */
const rememberedDataSetUrl = (storage: Storage): string =>
  storage.getItem(DATA_SET_STORAGE_KEY) ?? DEFAULT_DATA_SET_URL

export { DATA_SET_PARAM, rememberDataSetParam, rememberDataSetUrl, rememberedDataSetUrl }
