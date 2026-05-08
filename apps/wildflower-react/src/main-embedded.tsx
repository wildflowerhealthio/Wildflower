/* oxlint-disable react/only-export-components -- This file is the embedded
   bundle's entrypoint; React Refresh doesn't apply to a script that owns a
   `createRoot(...).render(...)` call rather than exporting a tree. The tiny
   `RouteChangedSender` component is a private glue artifact, kept inline so
   the wiring sequence (peek-buffer → seed router → mount) reads top-down. */
import './instrument.ts'
import { GatekeeperNativeToWeb, GatekeeperWebToNative } from 'gatekeeper-core/message-schemas'
import {
  bootstrapTokenFromUrl,
  subscribeAuthTokenIssued,
} from 'gatekeeper-react/host-token-bootstrap'
import {
  type AppNavigationRequestedType,
  InteropNativeToWeb,
  InteropWebToNative,
} from 'interop-core'
import {
  AppNavigationBinder,
  createAppNavigationBridge,
  createNativeBackBridge,
  makeWebMessageHandler,
  NativeBackBinder,
  useRouteChangedSender,
} from 'interop-react'
import { type JSX, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Routes } from 'react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { appRoutesFragment } from './routes.tsx'
import './styles/global.css'

// Construct the cross-process handler before any React renders. The
// handler synchronously replays `window.__INITIAL_MESSAGES__` into its
// per-tag buffers, so the rest of this module can drain them before the
// router mounts — that's how we get a flicker-free initial route.
const NativeToWeb = { ...InteropNativeToWeb, ...GatekeeperNativeToWeb }
const WebToNative = { ...InteropWebToNative, ...GatekeeperWebToNative }
const handler = makeWebMessageHandler({ receive: NativeToWeb, send: WebToNative })

// Auth token: a buffered AuthTokenIssued is delivered immediately on
// listener registration (idle → live transition drains the queue);
// future rotations stream through the same listener. The URL fallback
// covers standalone-web bootstraps where no message bridge exists.
subscribeAuthTokenIssued(handler)
bootstrapTokenFromUrl()

// Initial route: drain any AppNavigationRequested(s) the host injected
// via `__INITIAL_MESSAGES__`. The last one wins. Anything that arrives
// *after* this point flows through `appNavigationBridge` instead.
const bufferedRoutes: ReadonlyArray<AppNavigationRequestedType> =
  handler.consumeBuffered('AppNavigationRequested')
const initialEntry = bufferedRoutes.at(-1)?.path ?? '/'

// Bridges for the two messages whose listeners run inside the router
// but whose subscriptions need to be live before the router mounts (so
// events can queue rather than drop during the React mount window).
const nativeBackBridge = createNativeBackBridge()
nativeBackBridge.subscribe(handler)
const appNavigationBridge = createAppNavigationBridge()
appNavigationBridge.subscribe(handler)

function RouteChangedSender(): JSX.Element | null {
  useRouteChangedSender(handler)
  return null
}

const container = document.getElementById('root')
if (container === null) {
  throw new Error('root element not found')
}

createRoot(container).render(
  <StrictMode>
    <MemoryRouter initialEntries={[initialEntry]}>
      <NativeBackBinder bridge={nativeBackBridge} />
      <AppNavigationBinder bridge={appNavigationBridge} />
      <RouteChangedSender />
      <Routes>{appRoutesFragment}</Routes>
    </MemoryRouter>
  </StrictMode>
)
