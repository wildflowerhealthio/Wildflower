import type { BetaToolResultBlockParam } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ToolCall from './tool-call.ts'
import * as Tools from './tools.ts'

const search: ToolCall.Call = {
  name: 'search_records',
  input: {
    resourceType: 'Observation',
    params: [
      { name: 'code', value: '4548-4' },
      { name: '_count', value: '5' },
    ],
  },
}

describe('ToolCall.summaryOf', () => {
  it.each([
    [search, 'Searched Observation: code=4548-4, up to 5'],
    [
      { name: 'search_records', input: { resourceType: 'Condition', params: [] } },
      'Searched Condition: up to 20',
    ],
    [{ name: 'next_page', input: { cursor: 'abc' } }, 'Read the next page of results'],
    [
      { name: 'read_record', input: { resourceType: 'Practitioner', id: 'dr1' } },
      'Read Practitioner/dr1',
    ],
    [{ name: 'capabilities', input: {} }, 'Checked what the server can search on'],
    [{ name: 'search_records', input: 'garbled' }, 'Searched the record'],
  ] as const)('should describe %j as %s', (call, line) => {
    expect(ToolCall.summaryOf(call)).toBe(line)
  })
})

describe('ToolCall.parametersOf', () => {
  it('should list a search’s type and parameters, and nothing of a cursor', () => {
    expect(ToolCall.parametersOf(search)).toEqual([
      { name: 'resourceType', value: 'Observation' },
      { name: 'code', value: '4548-4' },
      { name: '_count', value: '5' },
    ])
    expect(ToolCall.parametersOf({ name: 'next_page', input: { cursor: 'abc' } })).toEqual([])
  })
})

describe('ToolCall.resultSummaryOf', () => {
  const resultOf = (content: string, isError = false): Option.Option<BetaToolResultBlockParam> =>
    Option.some({
      type: 'tool_result',
      tool_use_id: 'call-1',
      content,
      is_error: isError,
    })

  it.each([
    [
      'search_records',
      resultOf('{"resources":[{},{}],"more":true,"next":"x"}'),
      '2 records, more available',
    ],
    ['next_page', resultOf('{"resources":[{}],"more":false}'), '1 record'],
    ['read_record', resultOf('{"resourceType":"Patient","name":[{"text":"Ada"}]}'), '1 record'],
    [
      'capabilities',
      resultOf(
        Schema.encodeSync(Tools.CapabilitiesResult)({
          resourceTypes: [
            { type: 'Observation', searchParams: ['code'] },
            { type: 'Condition', searchParams: [] },
            { type: 'Patient', searchParams: ['_id'] },
          ],
        })
      ),
      '3 record types',
    ],
    ['search_records', resultOf('The FHIR server answered 500.', true), 'Failed'],
    ['search_records', Option.none(), 'No result'],
  ] as const)('should sum up a %s result without repeating its records', (name, result, line) => {
    expect(ToolCall.resultSummaryOf(name, result)).toBe(line)
  })
})
