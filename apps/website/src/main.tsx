import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// react-tundraish is the shared design base. tundra-css supplies the base
// element classes (`.button`, `.input-2`, the surface/accent plumbing); it must
// load first so react-tundraish's `styles.css` can re-point tundra's grey
// defaults to the warm Wildflower palette on top. The site's tokens.css bridges
// onto those, and global.css layers last. (The app loads the same pair the same
// way; react-tundraish's styles.css deliberately does not re-import tundra-css.)
import 'tundra-css'
import 'react-tundraish/styles.css'

import { App } from './app.tsx'
import { addOsColorSchemeListener } from './styles/color-scheme.ts'
import './styles/fonts.ts'
import './styles/tokens.css'
import './styles/global.css'

// react-tundraish's dark palette is attribute-driven (`data-color-scheme`), so
// translate the OS preference into that attribute before first paint.
addOsColorSchemeListener()

const rootElement = document.querySelector('#root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
