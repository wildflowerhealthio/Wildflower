import type { AnyRoute } from '@tanstack/react-router'

import { Route as TunnelScreen } from './routes/_settings/tunnel/index.tsx'

export const openSubtree: readonly AnyRoute[] = []
export const authSubtree: readonly AnyRoute[] = []
export const settingsSubtree: readonly AnyRoute[] = [TunnelScreen]
