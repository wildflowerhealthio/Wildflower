import { describe, expect, it } from 'vite-plus/test'

import { servedDirectoryOf } from './smart-app-page.ts'

describe('servedDirectoryOf', () => {
  it('should read a preview build’s directory off its entry chunk under assets/', () => {
    expect(servedDirectoryOf('https://importer.example/pr-7/assets/main-3f2a.js')).toBe('/pr-7/')
  })

  it('should read the origin root off a root-served build’s entry chunk', () => {
    expect(servedDirectoryOf('https://importer.example/assets/main-3f2a.js')).toBe('/')
  })

  it('should read the dev server’s root off its src/ entry module', () => {
    expect(servedDirectoryOf('http://localhost:5193/src/main.tsx')).toBe('/')
  })
})
