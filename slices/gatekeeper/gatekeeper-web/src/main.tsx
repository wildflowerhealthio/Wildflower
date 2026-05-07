import './instrument.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { App } from './App.tsx'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

const injectedRoute = (window as Window & { __INITIAL_ROUTE__?: string }).__INITIAL_ROUTE__
const initialEntry = injectedRoute ?? '/'

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[initialEntry]}>
      <App />
    </MemoryRouter>
  </StrictMode>
)
