import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Design-system stylesheets: tundra-css supplies the base tokens/reset, then
// react-tundraish re-points them to the Wildflower palette + type scale. Loaded
// before the app's own CSS module so app styles win on tied specificity.
import 'tundra-css'
import 'react-tundraish/styles.css'
// Branding layout tokens (--content-max-width, --page-padding-x,
// --header-height, --radius-pill). After react-tundraish because the layout
// tokens reference --space-N ramps from tundraish.
import 'branding-react/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to; the italic cut carries emphasis. Mono is reserved for machine strings —
// the preview lists resource types and ids, and the results list failed writes
// by reference, so it earns its place here.
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
