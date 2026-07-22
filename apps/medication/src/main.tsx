import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// Design-system stylesheets: tundra-css supplies the base tokens/reset, then
// react-tundraish re-points them to the Wildflower palette + type scale. Loaded
// before the app's own CSS module so app styles win on tied specificity.
import 'tundra-css'
import 'react-tundraish/styles.css'
// Self-hosted UI font (Atkinson Hyperlegible Next) that `--font-sans` resolves
// to; the italic cut carries emphasis. Mono is reserved for machine strings.
import '@fontsource-variable/atkinson-hyperlegible-next/wght.css'
import '@fontsource-variable/atkinson-hyperlegible-next/wght-italic.css'
import '@fontsource-variable/atkinson-hyperlegible-mono/wght.css'

import { App } from './app.tsx'
import { startColorSchemeSync } from './color-scheme.ts'

// Mirror the OS colour preference onto `data-color-scheme` so tundra's dark
// palette (keyed off that attribute, not `prefers-color-scheme`) tracks the OS.
startColorSchemeSync()

const container = document.getElementById('root')
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}
