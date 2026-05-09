import './instrument.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as BridgeTransport from './bridges/transport.ts'
import { appRoutesFragment } from './routes.tsx'

import './styles/global.css'
import { NavigationBridgeHandler } from 'contracts-react'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <NavigationBridgeHandler sender={BridgeTransport.transport.sendMessage} />
      <Routes>{appRoutesFragment}</Routes>
    </BrowserRouter>
  </StrictMode>
)
