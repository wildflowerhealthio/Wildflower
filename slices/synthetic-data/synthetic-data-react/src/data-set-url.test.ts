import { Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { DEFAULT_DATA_SET_URL, dataSetRootOf } from './data-set-url.ts'

const rootHrefOf = (url: string): string | undefined =>
  Either.match(dataSetRootOf(url), { onLeft: () => undefined, onRight: (root) => root.href })

describe('dataSetRootOf', () => {
  it.each([
    [DEFAULT_DATA_SET_URL, DEFAULT_DATA_SET_URL],
    ['https://wildflowerhealthio.github.io/synthetic-data', DEFAULT_DATA_SET_URL],
    ['  http://localhost:8000/  ', 'http://localhost:8000/'],
    ['http://127.0.0.1:8000/out', 'http://127.0.0.1:8000/out/'],
  ])('should read %j as the root %j', (url, root) => {
    expect(rootHrefOf(url)).toBe(root)
  })

  it('should keep every manifest path inside the root', () => {
    const root = Either.getOrThrow(dataSetRootOf('https://example.com/data'))
    expect(new URL('index.json', root).href).toBe('https://example.com/data/index.json')
  })

  it.each([
    ['', 'It is not a full URL, such as https://example.com/data/.'],
    ['example.com/data/', 'It is not a full URL, such as https://example.com/data/.'],
    ['file:///home/data/', 'A data set is read over https: or http:.'],
    ['javascript:alert(1)', 'A data set is read over https: or http:.'],
    [
      'https://example.com/data/?v=1',
      'A data set URL is the folder that holds index.json, with no ? or # part.',
    ],
    [
      'https://example.com/data/#people',
      'A data set URL is the folder that holds index.json, with no ? or # part.',
    ],
  ])('should reject %j', (url, reason) => {
    expect(
      Either.match(dataSetRootOf(url), { onLeft: (invalid) => invalid.reason, onRight: String })
    ).toBe(reason)
  })
})
