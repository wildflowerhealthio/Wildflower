// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import { awaitWebAuthReady } from 'gatekeeper-react'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { stubTransport } from './bridges/transport-context.ts'

// Same standalone-web auth behavior as `main-web`: synchronous token
// read → gate resolves or throws a TanStack redirect immediately.
// Stub transport (pre-resolved).
renderApp({
  history: createBrowserHistory(),
  entry: 'main-single-web',
  awaitAuthReady: () => awaitWebAuthReady,
  makeTransport: () => Promise.resolve(stubTransport),
})
