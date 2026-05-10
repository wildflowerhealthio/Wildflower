import './instrument.ts'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import { TransportProvider } from './bridges/transport-provider.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

AppRoot.render(
  <BrowserRouter>
    <TransportProvider>
      <Routes>{appRoutesFragment}</Routes>
    </TransportProvider>
  </BrowserRouter>
)
