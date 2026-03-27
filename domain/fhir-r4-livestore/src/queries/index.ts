import { queryDb } from '@livestore/livestore'

import { tables } from '../schema/index.ts'

export const accounts$ = queryDb(tables.accounts, { label: 'accounts' })
