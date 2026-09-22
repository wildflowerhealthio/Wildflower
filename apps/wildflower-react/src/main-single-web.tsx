import './instrument.ts'
import 'tundra-css'
import 'react-tundraish/styles.css'
import { createBrowserHistory } from '@tanstack/react-router'
import './styles/global.css'
import { addOsColorSchemeListener } from 'react-tundraish'
import { renderApp } from './app-root.tsx'
import { makeSingleWebEntryOptions } from './single-web-entry.ts'

addOsColorSchemeListener()

// The single-file bundle the host embeds and serves itself, so it is always
// same-origin with the API and authenticates by cookie — see
// `makeSingleWebEntryOptions`. `main-web` is the cross-origin counterpart.
renderApp({
  history: createBrowserHistory(),
  entry: 'main-single-web',
  ...makeSingleWebEntryOptions(),
})
