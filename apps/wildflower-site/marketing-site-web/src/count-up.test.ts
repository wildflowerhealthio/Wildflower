import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { countUpStats } from './count-up.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('countUpStats', () => {
  it('should animate every number cell up to the value rendered in the DOM', () => {
    // Arrange
    const host = statsHost([
      { text: '4', label: 'long-term conditions' },
      { text: '213', label: 'lab results' },
    ])

    // Act
    runToCompletion(host)

    // Assert
    expect(numberCellTexts(host)).toStrictEqual(['4', '213'])
  })

  it('should keep the "+" suffix while animating "10+" to 10', () => {
    // Arrange
    const host = statsHost([{ text: '10+', label: 'prescription medications' }])

    // Act
    runToCompletion(host)

    // Assert
    expect(numberCellTexts(host)).toStrictEqual(['10+'])
  })

  it('should zero the cells when the animation starts', () => {
    // Arrange
    const host = statsHost([
      { text: '4', label: 'clinics' },
      { text: '10+', label: 'providers' },
    ])

    // Act — schedule frames without running any.
    countUpStats(host, { schedule: () => {}, now: () => 0 })

    // Assert
    expect(numberCellTexts(host)).toStrictEqual(['0', '0+'])
  })

  it('should run only once per host', () => {
    // Arrange
    const host = statsHost([{ text: '18', label: 'vaccinations' }])
    runToCompletion(host)

    // Act — a second invocation must not zero the cells again.
    countUpStats(host, { schedule: () => {}, now: () => 0 })

    // Assert
    expect(numberCellTexts(host)).toStrictEqual(['18'])
    expect(host.dataset['counted']).toBe('1')
  })

  it('should stay eligible when the host has no number cells yet', () => {
    // Arrange — an empty host, as rendered before the stats markup arrives.
    const host = document.createElement('div')
    document.body.append(host)

    // Act
    countUpStats(host, { schedule: () => {}, now: () => 0 })

    // Assert — no `data-counted` flag, so a later call still animates.
    expect(host.dataset['counted']).toBeUndefined()
    host.append(textCell('18'), textCell('vaccinations'))
    runToCompletion(host)
    expect(numberCellTexts(host)).toStrictEqual(['18'])
  })

  it('should skip the animation entirely under prefers-reduced-motion', () => {
    // Arrange
    vi.stubGlobal('matchMedia', (query: string): Pick<MediaQueryList, 'matches' | 'media'> => ({
      matches: true,
      media: query,
    }))
    const host = statsHost([{ text: '213', label: 'lab results' }])
    const schedule = vi.fn()

    // Act
    countUpStats(host, { schedule, now: () => 0 })

    // Assert — final values stay rendered, nothing is scheduled.
    expect(numberCellTexts(host)).toStrictEqual(['213'])
    expect(schedule).not.toHaveBeenCalled()
  })

  it('should always land every cell on its rendered target and suffix', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            value: fc.nat(),
            suffix: fc.constantFrom('', '+'),
          }),
          { minLength: 1 }
        ),
        (rows) => {
          // Arrange
          const host = statsHost(
            rows.map((row, index) => ({
              text: `${row.value}${row.suffix}`,
              label: `label ${index}`,
            }))
          )

          // Act
          runToCompletion(host)

          // Assert
          expect(numberCellTexts(host)).toStrictEqual(
            rows.map((row) => `${row.value}${row.suffix}`)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A single cell carrying `text`. */
function textCell(text: string): HTMLElement {
  const element = document.createElement('span')
  element.textContent = text
  return element
}

/** Builds the expected host shape: children alternate number cell, label cell. */
function statsHost(rows: readonly { text: string; label: string }[]): HTMLElement {
  const host = document.createElement('div')
  for (const row of rows) {
    const numberCell = document.createElement('span')
    numberCell.textContent = row.text
    const labelCell = document.createElement('span')
    labelCell.textContent = row.label
    host.append(numberCell, labelCell)
  }
  document.body.append(host)
  return host
}

/** The rendered text of each number cell (the even-indexed children). */
function numberCellTexts(host: HTMLElement): string[] {
  return Array.from(host.children)
    .filter((_, index) => index % 2 === 0)
    .map((cell) => cell.textContent ?? '')
}

/**
 * Starts the count-up with an injected scheduler/clock and pumps frames until
 * the animation stops requesting them.
 */
function runToCompletion(host: HTMLElement): void {
  const queue: ((frameNow: number) => void)[] = []
  let clock = 0
  countUpStats(host, { schedule: (callback) => queue.push(callback), now: () => clock })
  // 900ms duration + 90ms per-row stagger, stepped at ~60fps; the bound only
  // guards against a runaway loop if the animation never settles.
  const limit = 1000 + Math.ceil((900 + 90 * host.children.length) / 16)
  for (let frame = 0; queue.length > 0 && frame < limit; frame += 1) {
    clock += 16
    for (const callback of queue.splice(0)) {
      callback(clock)
    }
  }
  expect(queue).toHaveLength(0)
}
