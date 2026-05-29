import type { AnyRoute } from '@tanstack/react-router'

import { Route as AccountConfig } from './routes/_auth/collector/account.$id.tsx'
import { Route as AccountNew } from './routes/_auth/collector/account.new.tsx'
import { Route as AccountList } from './routes/_auth/collector/index.tsx'

export const openSubtree: readonly AnyRoute[] = []
export const authSubtree: readonly AnyRoute[] = [AccountList, AccountNew, AccountConfig]
export const settingsSubtree: readonly AnyRoute[] = []
