import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Design-system stylesheets: tundra-css supplies the base tokens/reset, then
// react-tundraish re-points them to the Wildflower palette + type scale, and
// branding-react adds the page-composition layout tokens (--content-max-width,
// --page-padding-x, --header-height). Loaded before the app's own CSS module
// so app styles win on tied specificity.
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to; the italic cut carries emphasis. Mono is reserved for machine strings —
// which this app is full of, so it earns its place here.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'

import { addOsColorSchemeListener } from 'react-tundraish'
import { AppRoot } from './app-root.tsx'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
addOsColorSchemeListener()

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <AppRoot />
    </StrictMode>
  )
}
