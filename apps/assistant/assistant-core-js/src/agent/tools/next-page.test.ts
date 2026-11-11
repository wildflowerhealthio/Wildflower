import { Effect, Encoding } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as Chat from '../../chat.ts'
import {
  searchBundleOf,
  STUB_FHIR_BASE,
  stubFhirRecords,
  toolUseBlock,
} from '../../test-helpers.ts'
import * as Tools from './index.ts'
import { ada, everyone, toolsFor, runCall, succeeded, observation } from './tools.test-helpers.ts'

describe('Tools.run next_page', () => {
  const nextUrl = `${STUB_FHIR_BASE}/Observation?patient=p1&_count=20&page=2`

  it("should give a cursor for the next page that reads the server's next link", () => {
    const server = stubFhirRecords({
      'Observation?patient=p1&_count=20&page=2': Effect.succeed(
        searchBundleOf([observation('o3', 'p1')])
      ),
      'Observation?': Effect.succeed(searchBundleOf([observation('o1', 'p1')], { nextUrl })),
    })
    const tools = toolsFor(ada)

    const first = runCall(tools, server, 'search_records', {
      resourceType: 'Observation',
      params: [],
    })
    const cursor = Encoding.encodeBase64Url('Observation?patient=p1&_count=20&page=2')
    const second = runCall(tools, server, 'next_page', { cursor }, new Set([cursor]))

    expect(first).toEqual(
      succeeded({ resources: [observation('o1', 'p1')], more: true, next: cursor })
    )
    expect(second).toEqual(succeeded({ resources: [observation('o3', 'p1')], more: false }))
  })

  it('should say there is more but give no cursor for a next link off the server', () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(
        searchBundleOf([], { nextUrl: 'https://elsewhere.example/Observation?page=2' })
      ),
    })

    expect(
      runCall(toolsFor(everyone), server, 'search_records', {
        resourceType: 'Observation',
        params: [],
      })
    ).toEqual(succeeded({ resources: [], more: true }))
  })

  it.each([
    ['https://elsewhere.example/Observation?page=2'],
    ['../admin/Observation'],
    ['Group?member=p2'],
  ])('should refuse a cursor for %s, reading nothing', (path) => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })
    const cursor = Encoding.encodeBase64Url(path)

    const result = runCall(toolsFor(ada), server, 'next_page', { cursor }, new Set([cursor]))

    expect(result.is_error).toBe(true)
    expect(server.readPaths).toEqual([])
  })

  it('should refuse a cursor no page in the chat gave, reading nothing', () => {
    const server = stubFhirRecords({ '': Effect.succeed(searchBundleOf([])) })

    const result = runCall(toolsFor(ada), server, 'next_page', {
      cursor: Encoding.encodeBase64Url('Observation?patient=p2&_elements=code'),
    })

    expect(result.is_error).toBe(true)
    expect(server.readPaths).toEqual([])
  })

  it("should give a cursor for a next link on the FHIR base itself, a server's paging handle", () => {
    const server = stubFhirRecords({
      'Observation?': Effect.succeed(
        searchBundleOf([], { nextUrl: `${STUB_FHIR_BASE}?_getpages=abc` })
      ),
    })

    expect(
      runCall(toolsFor(everyone), server, 'search_records', {
        resourceType: 'Observation',
        params: [],
      })
    ).toEqual(
      succeeded({ resources: [], more: true, next: Encoding.encodeBase64Url('?_getpages=abc') })
    )
  })
})

describe('Tools.cursorsIssuedIn', () => {
  it('should hold the next cursor of each page the chat read, and none from failed calls', () => {
    const chat = Chat.append(Chat.start('telehealth'), {
      _tag: 'tool-round',
      modelId: 'claude-sonnet-5',
      message: {
        role: 'assistant',
        content: [
          toolUseBlock('search', 'search_records', {}),
          toolUseBlock('last', 'next_page', {}),
          toolUseBlock('failed', 'search_records', {}),
        ],
      },
      results: [
        {
          type: 'tool_result',
          tool_use_id: 'search',
          content: JSON.stringify({ resources: [], more: true, next: 'cursor-1' }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'last',
          content: JSON.stringify({ resources: [], more: false }),
        },
        {
          type: 'tool_result',
          tool_use_id: 'failed',
          is_error: true,
          content: JSON.stringify({ resources: [], more: true, next: 'cursor-2' }),
        },
      ],
    })

    expect(Tools.cursorsIssuedIn(chat)).toEqual(new Set(['cursor-1']))
  })
})
