// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { StubTransportProvider } from './bridges/transport-provider.tsx'

renderApp({
  history: createBrowserHistory(),
  TransportProvider: StubTransportProvider,
  entry: 'main-single-web',
})
