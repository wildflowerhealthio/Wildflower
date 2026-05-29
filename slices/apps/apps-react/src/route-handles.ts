import type { AnyRoute } from '@tanstack/react-router'

import { Route as AppsHome } from './routes/_auth/apps/index.tsx'

export const openSubtree: readonly AnyRoute[] = []
export const authSubtree: readonly AnyRoute[] = [AppsHome]
export const settingsSubtree: readonly AnyRoute[] = []
