// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import './styles/global.css'
import { renderApp } from './app-root.tsx'
import { addOsColorSchemeListener } from './styles/add-os-color-scheme-listener.ts'
import { makeWebEntryOptions } from './web-entry.ts'

addOsColorSchemeListener()

// Same standalone-web wiring as `main-web` (see `makeWebEntryOptions`);
// differs only in `entry` and the commented-out `instrument.ts` import.
renderApp({
  history: createBrowserHistory(),
  entry: 'main-single-web',
  ...makeWebEntryOptions(),
})
