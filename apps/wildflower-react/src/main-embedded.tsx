import './instrument.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { NavigateBinder, RouteChangeWatcher } from './embedded-glue.tsx'
import { initialEntry } from './embedded-runtime.ts'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[initialEntry]}>
      <NavigateBinder />
      <RouteChangeWatcher />
      <Routes>{appRoutesFragment}</Routes>
    </MemoryRouter>
  </StrictMode>
)
