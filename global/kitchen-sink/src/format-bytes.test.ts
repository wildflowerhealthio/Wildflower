import { describe, expect, it } from 'vite-plus/test'

import { formatBytes } from './index.ts'

describe('formatBytes', () => {
  it('renders raw bytes as a whole number under 1 KB', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1023)).toBe('1023 B')
  })

  it('promotes to the next binary unit at 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })

  it('keeps one decimal under 10 in a unit and rounds to whole above it', () => {
    expect(formatBytes(9.4 * 1024)).toBe('9.4 KB')
    expect(formatBytes(12.6 * 1024)).toBe('13 KB')
  })

  it('caps at the largest unit (TB) rather than inventing new ones', () => {
    expect(formatBytes(3 * 1024 ** 4)).toBe('3.0 TB')
    expect(formatBytes(5000 * 1024 ** 4)).toBe('5000 TB')
  })
})
