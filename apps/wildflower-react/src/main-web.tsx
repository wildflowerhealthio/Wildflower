import './instrument.ts'
import 'gatekeeper-react/host-token-bootstrap'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>{appRoutesFragment}</Routes>
    </BrowserRouter>
  </StrictMode>
)
