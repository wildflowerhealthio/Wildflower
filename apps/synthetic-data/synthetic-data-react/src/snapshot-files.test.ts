import { Either } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { snapshotRootOf } from './snapshot-files.ts'

describe('snapshotRootOf', () => {
  it.each([
    ['https://data.example/sets/demo/', 'https://data.example/sets/demo/'],
    ['https://data.example/sets/demo', 'https://data.example/sets/demo/'],
    ['https://data.example/sets/demo/index.json', 'https://data.example/sets/demo/'],
    ['  https://data.example/  ', 'https://data.example/'],
    ['https://data.example/sets/demo/?v=2#people', 'https://data.example/sets/demo/'],
    ['http://localhost:4173/', 'http://localhost:4173/'],
  ])('reads %j as the root %j', (address, root) => {
    expect(Either.map(snapshotRootOf(address), (url) => url.href)).toEqual(Either.right(root))
  })

  it.each([
    ['data.example/sets/demo/', 'Enter the full address, starting https://.'],
    ['', 'Enter the full address, starting https://.'],
    ['ftp://data.example/sets/demo/', 'The address must start https:// or http://.'],
    ['file:///home/me/site/', 'The address must start https:// or http://.'],
  ])('refuses %j', (address, problem) => {
    expect(snapshotRootOf(address)).toEqual(Either.left(problem))
  })
})
