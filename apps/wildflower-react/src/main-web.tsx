import './instrument.ts'
import { NavigationBridgeHandler } from 'contracts-react'
import { BrowserRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import * as BridgeTransport from './bridges/transport.ts'
import { mount } from './mount.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

mount(
  <BrowserRouter>
    <NavigationBridgeHandler sender={BridgeTransport.transport.sendMessage} />
    <Routes>{appRoutesFragment}</Routes>
  </BrowserRouter>
)
