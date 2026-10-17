import type { JSX } from 'react'

import styles from './app.module.css'

/**
 * The app's title, over every page but the introduction at `/`, whose
 * `AppLanding` names the app itself.
 */
const AppTitle = (): JSX.Element => (
  <header className={styles['app__header']}>
    <h1 className="text-heading-3">Strength</h1>
  </header>
)

export { AppTitle }
