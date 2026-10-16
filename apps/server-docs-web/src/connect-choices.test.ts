import {
  MENU_COPY,
  RELAY_GROUP_NAME,
  serverUrlForRelayEntry,
} from '@wildflowerhealthio/smart-app-core'
import { Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { CONNECT_CHOICES } from './connect-choices.ts'

describe('CONNECT_CHOICES', () => {
  it('offers the relay entry, the free entry, then launching without a server', () => {
    expect(CONNECT_CHOICES.map((choice) => [choice.kind, choice.name])).toEqual([
      ['server-entry', RELAY_GROUP_NAME],
      ['server-entry', MENU_COPY.wildflower.freeEntryName],
      ['without-server', 'Without a server'],
    ])
    expect(CONNECT_CHOICES.at(-1)).toMatchObject({ buttonLabel: 'Launch without a server' })
  })

  it('validates each entry with its own rule, in the Wildflower menu’s words', () => {
    const [relay, free] = CONNECT_CHOICES
    expect(relay).toMatchObject({ serverUrlFor: serverUrlForRelayEntry })
    if (free?.kind !== 'server-entry') throw new Error('the free entry is the second choice')
    expect(free.serverUrlFor(' https://Server.Example.com/ ')).toEqual(
      Either.right('https://server.example.com')
    )
    expect(free.serverUrlFor('my-server.example.com')).toEqual(
      Either.left(MENU_COPY.wildflower.invalidFreeEntry)
    )
  })
})
