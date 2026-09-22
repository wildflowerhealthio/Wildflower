import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { restoreRedirectedUrl } from 'branding-core'
import type { TokenResponseHandler } from 'gatekeeper-react'
import { addOsColorSchemeListener } from 'react-tundraish'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { makeHostedEntryOptions } from './hosted-entry.ts'

addOsColorSchemeListener()

restoreRedirectedUrl(window)

const { hostedStore, ...entryOptions } = makeHostedEntryOptions()
const history = createBrowserHistory()

const tokenResponseHandler: TokenResponseHandler = {
  writeBearer: (accessToken) => {
    hostedStore.storeBearer(accessToken)
  },
  navigateAfterAuth: (returnTo) => {
    history.push(returnTo)
  },
}

renderApp({
  history,
  entry: 'main-hosted',
  ...entryOptions,
  tokenResponseHandler,
})
