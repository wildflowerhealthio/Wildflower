import './instrument.ts'
import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { renderApp } from './app-root.tsx'
import './styles/global.css'
import { StubTransportProvider } from './bridges/transport-provider.tsx'

renderApp({
  history: createBrowserHistory(),
  TransportProvider: StubTransportProvider,
  entry: 'main-web',
})
