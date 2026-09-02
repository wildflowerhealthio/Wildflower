import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

// react-tundraish is the shared design base, and the site takes it whole — the
// same palette, type ramp, and dark theme the app renders in. tundra-css
// supplies the base element classes (`.button`, `.input-4`, the surface/accent
// plumbing); it must load first so react-tundraish's `styles.css` can re-point
// tundra's grey defaults on top. branding-react's `styles.css` then layers the
// chrome layout tokens (`--content-max-width`, `--page-padding-x`,
// `--header-height`, `--radius-pill`), referenced by the shared header, footer,
// and every centered section. The site's own `tokens.css` adds only the
// remaining page-composition values (`--beta-form-width`), and `global.css`
// layers last. (The app loads tundra-css + react-tundraish the same way;
// react-tundraish's styles.css deliberately does not re-import tundra-css.)
import 'tundra-css'
import 'react-tundraish/styles.css'
import 'branding-react/styles.css'

import { addOsColorSchemeListener } from 'react-tundraish'
import { App } from './app.tsx'
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
