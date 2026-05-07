import './instrument.ts'
import 'gatekeeper-web/host-token-bootstrap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { HostBridge } from './host-bridge.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

const injected = (window as Window & { __INITIAL_ROUTE__?: string }).__INITIAL_ROUTE__
const initialEntry = injected ?? '/gatekeeper'

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[initialEntry]}>
      <HostBridge />
      <Routes>{appRoutesFragment}</Routes>
    </MemoryRouter>
  </StrictMode>
)
