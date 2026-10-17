import { describe, expect, it } from 'vite-plus/test'

import golden from '../../servers-wire-golden.json' with { type: 'json' }
import { DENY_ACTION_ID, intentOf, OPEN_ACTION_ID } from './notification-action.ts'

describe('NotificationAction', () => {
  it("should name the consent notification's actions as the host registers them", () => {
    // Assert
    expect({ open: OPEN_ACTION_ID, deny: DENY_ACTION_ID }).toEqual(
      golden.consentNotificationActions
    )
  })

  it.each([
    ['tap', 'open'],
    ['open', 'open'],
    ['deny', 'deny'],
    ['dismiss', 'nothing'],
  ] as const)('should read the action %j as asking to %s', (actionId, intent) => {
    // Act
    const read = intentOf({ actionId, notification: { id: 1_534_013_825 } })

    // Assert
    expect(read).toBe(intent)
  })
})
