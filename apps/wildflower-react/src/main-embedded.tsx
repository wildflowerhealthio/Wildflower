import './instrument.ts'
import { NavigationBridgeHandler } from 'navigation-react'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { findInitialPath } from './bridges/find-initial-path.ts'
import * as BridgeTransport from './bridges/transport.ts'
import { mount } from './mount.tsx'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

const initialPath = findInitialPath(BridgeTransport.initialMessages)

mount(
  <MemoryRouter initialEntries={[initialPath]}>
    <NavigationBridgeHandler sender={BridgeTransport.transport.sendMessage} />
    <Routes>{appRoutesFragment}</Routes>
  </MemoryRouter>
)
