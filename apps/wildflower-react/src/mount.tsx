import { type ReactNode, StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/** Mount the app under `#root`, wrapped in `<StrictMode>`. */
const mount = (children: ReactNode): void => {
  const container = document.getElementById('root')
  if (container === null) {
    throw new Error('root element not found')
  }
  createRoot(container).render(<StrictMode>{children}</StrictMode>)
}

export { mount }
