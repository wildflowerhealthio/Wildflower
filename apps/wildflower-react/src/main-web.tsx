import './instrument.ts'
import { NavigationBridgeHandler } from 'navigation-react'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as AppRoot from './app-root.tsx'
import * as BridgeTransport from './bridges/transport.ts'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

AppRoot.render(
  <BrowserRouter>
    <NavigationBridgeHandler sender={BridgeTransport.transport.sendMessage} />
    <Routes>{appRoutesFragment}</Routes>
  </BrowserRouter>
)
