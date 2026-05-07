import { act, renderHook } from '@testing-library/react-native'

import { useNotificationTapHandler } from './use-notification-tap-handler.ts'

type NotificationCallback = (response: {
  readonly notification: { readonly request: { readonly content: { readonly data: unknown } } }
  readonly actionIdentifier: string
}) => void

const subscriptions: { remove: jest.Mock }[] = []
let lastCallback: NotificationCallback | null = null

jest.mock('expo-notifications', () => ({
  addNotificationResponseReceivedListener: jest.fn((cb: NotificationCallback) => {
    lastCallback = cb
    const sub = { remove: jest.fn() }
    subscriptions.push(sub)
    return sub
  }),
}))

const trigger = (data: unknown, actionIdentifier = 'default'): void => {
  if (lastCallback === null) throw new Error('listener not registered')
  lastCallback({
    notification: { request: { content: { data } } },
    actionIdentifier,
  })
}

beforeEach(() => {
  subscriptions.length = 0
  lastCallback = null
})

describe('useNotificationTapHandler', () => {
  it('invokes onTap with id + actionIdentifier when data decodes', () => {
    const onTap = jest.fn()
    renderHook(() => {
      useNotificationTapHandler(onTap)
    })

    act(() => {
      trigger({ id: 'req-1' }, 'approve')
    })

    expect(onTap).toHaveBeenCalledWith({ id: 'req-1', action: 'approve' })
  })

  it('ignores notifications whose data fails the schema', () => {
    const onTap = jest.fn()
    renderHook(() => {
      useNotificationTapHandler(onTap)
    })

    act(() => {
      trigger({ wrong: 'shape' })
    })
    act(() => {
      trigger(null)
    })
    act(() => {
      trigger({ id: 42 }) // wrong type for id
    })

    expect(onTap).not.toHaveBeenCalled()
  })

  it('does not re-register the listener when onTap identity changes, and routes to the latest cb', () => {
    const first = jest.fn()
    const second = jest.fn()
    const { rerender } = renderHook(
      ({ cb }: { cb: typeof first }) => {
        useNotificationTapHandler(cb)
      },
      { initialProps: { cb: first } }
    )

    expect(subscriptions).toHaveLength(1)
    rerender({ cb: second })
    expect(subscriptions).toHaveLength(1)

    act(() => {
      trigger({ id: 'req-2' })
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith({ id: 'req-2', action: 'default' })
  })

  it('removes the subscription on unmount', () => {
    const { unmount } = renderHook(() => {
      useNotificationTapHandler(jest.fn())
    })
    expect(subscriptions[0]?.remove).not.toHaveBeenCalled()
    unmount()
    expect(subscriptions[0]?.remove).toHaveBeenCalledTimes(1)
  })
})
