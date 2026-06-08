// import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import 'wildflower-react/global.css'
import { renderApp } from 'wildflower-react/app-root'
import { makeWebEntryOptions } from 'wildflower-react/web-entry'

// import { addOsColorSchemeListener } from './styles/add-os-color-scheme-listener.ts'
// addOsColorSchemeListener()

// Same standalone-web wiring as `main-web` (see `makeWebEntryOptions`);
// differs only in `entry` and the commented-out `instrument.ts` import.
renderApp({
  history: createBrowserHistory(),
  entry: 'main-tauri',
  ...makeWebEntryOptions(),
})
