import { describe, expect, test } from 'vite-plus/test'

import { sentenceJoin } from './sentence-join.ts'

describe('sentenceJoin', () => {
  test('empty list renders empty', () => {
    expect(sentenceJoin([])).toBe('')
  })

  test('a single part renders verbatim', () => {
    expect(sentenceJoin(['create'])).toBe('create')
  })

  test('two parts join with "and", no comma', () => {
    expect(sentenceJoin(['create', 'read'])).toBe('create and read')
  })

  test('three or more parts use the Oxford comma', () => {
    expect(sentenceJoin(['create', 'read', 'update'])).toBe('create, read, and update')
  })
})
