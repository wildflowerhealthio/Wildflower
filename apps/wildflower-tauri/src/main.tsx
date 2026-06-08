import { createBrowserHistory } from '@tanstack/react-router'
import 'tundra-css'
import 'react-tundraish/styles.css'
// import './instrument.ts'
import { attachConsole } from '@tauri-apps/plugin-log'
import 'wildflower-react/global.css'
import { renderApp } from 'wildflower-react/app-root'
import { addOsColorSchemeListener } from 'wildflower-react/os-color-scheme-listener'
import { makeWebEntryOptions } from 'wildflower-react/web-entry'

addOsColorSchemeListener()
attachConsole().catch((err) => console.error('Failed to attach Tauri console logger', err))

// Same standalone-web wiring as `main-web` (see `makeWebEntryOptions`);
// differs only in `entry` and the commented-out `instrument.ts` import.
renderApp({
  history: createBrowserHistory(),
  entry: 'main-tauri',
  ...makeWebEntryOptions(),
})
