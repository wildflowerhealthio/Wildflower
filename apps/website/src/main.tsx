import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// react-tundraish is the shared design base (tundra-css + the warm Wildflower
// token system + the `.button` / `.accent-*` / surface classes). It loads first
// so the site's own tokens.css can bridge onto it and global.css can layer on
// top. Fonts are imported separately (the site bundles its own @fontsource).
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
