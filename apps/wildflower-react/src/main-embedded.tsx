import './instrument.ts'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { findInitialPath } from './bridges/find-initial-path.ts'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { initialMessages } from './bridges/transport.ts'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

const initialPath = findInitialPath(initialMessages)

AppRoot.render(
  <MemoryRouter initialEntries={[initialPath]}>
    <TransportProvider>
      <Routes>{appRoutesFragment}</Routes>
    </TransportProvider>
  </MemoryRouter>
)
