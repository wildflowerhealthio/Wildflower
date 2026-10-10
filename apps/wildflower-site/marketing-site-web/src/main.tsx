import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// react-tundraish is the shared design base, and the site takes it whole — the
// homepage design was derived from the app's dark palette. tundra-css supplies
// the base element classes and the surface/accent plumbing; it must load first
// so react-tundraish's `styles.css` can re-point tundra's grey defaults on
// top. `branding-react/styles.css` then adds the shared chrome's layout tokens
// (the header/footer content column, the dropdown shadow) — the homepage now
// renders the same `SiteHeader`/`SiteFooter` as the apps. The site's own
// `tokens.css` layers last and narrows the content column to the essay measure.
//
// The page is dark-only by design: `index.html` pins
// `data-color-scheme="dark"` on `<html>`, so there is no OS-scheme listener —
// the palette never flips.
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'

import { App } from './app.tsx'
import './styles/fonts.ts'
import './styles/tokens.css'
import './styles/global.css'

const rootElement = document.querySelector('#root')
if (!rootElement) {
  throw new Error('Root element #root not found')
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
)
