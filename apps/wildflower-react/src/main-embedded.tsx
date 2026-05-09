import './instrument.ts'
import { NavigationBridgeHandler } from 'contracts-react'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { MemoryRouter, Routes } from 'react-router'
import * as NavigationBridge from './bridges/navigation.ts'
import * as BridgeTransport from './bridges/transport.ts'
import './styles/global.css'
import { appRoutesFragment } from './routes.tsx'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[NavigationBridge.initialPath]}>
      <NavigationBridgeHandler sender={BridgeTransport.transport.sendMessage} />
      <Routes>{appRoutesFragment}</Routes>
    </MemoryRouter>
  </StrictMode>
)
