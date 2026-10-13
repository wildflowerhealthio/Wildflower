import { Outlet } from '@tanstack/react-router'
import type { JSX } from 'react'

import styles from './root-shell.module.css'

// Every slice's client DI (apps, authorization, fhir-r4, databases, request log)
// runs through TanStack Query + the router-context runAuthed/runtimeLayer, so no
// slice client providers nest here. Auth/runtime providers wrap the router from
// above (app-root.tsx and app-root-tree.tsx).
const RootShell = (): JSX.Element => (
  <div className={styles['root-shell']}>
    <Outlet />
  </div>
)

export { RootShell }
