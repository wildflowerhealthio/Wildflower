import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// react-tundraish is the shared design base. tundra-css supplies the base
// element classes (`.button`, `.input-2`, the surface/accent plumbing); it must
// load first so react-tundraish's `styles.css` can re-point tundra's grey
// defaults on top. react-tundraish now ships the app's true-neutral/navy
// palette, so `warm-palette.css` re-pins the value-carrying tokens back to the
// marketing site's warm plum/cream brand (it must load right after
// react-tundraish so it wins at equal specificity). The site's tokens.css then
// bridges onto those, and global.css layers last. (The app loads tundra-css +
// react-tundraish the same way; react-tundraish's styles.css deliberately does
// not re-import tundra-css.)
import 'tundra-css'
import 'react-tundraish/styles.css'
import './styles/warm-palette.css'

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
