import './instrument.ts'
import { createMemoryHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'

renderApp({
  history: createMemoryHistory(),
  TransportProvider: TransportProvider,
  entry: 'main-embedded',
})
