import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Either } from 'effect'
import { ReturnTarget } from 'pebble-configuration'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'
import { LiftSettings, Lifts, PhoneSettings } from 'watch-lifts-core-js'

import { readPageUrl } from './page-url.ts'
import { WeightsPage } from './weights-page.tsx'

afterEach(() => {
  cleanup()
})

describe('WeightsPage', () => {
  it('should show the default weights when opened without any', () => {
    // Act
    renderPage(PAGE_URL)

    // Assert
    expect(tableValues()).toStrictEqual(LiftSettings.DEFAULT.weights)
  })

  it('should show the default weights when the ones it was opened with are not the settings', () => {
    // Act
    renderPage(`${PAGE_URL}?${PhoneSettings.PARAM}=${encodeURIComponent('{"weights":[[1]]}')}`)

    // Assert
    expect(tableValues()).toStrictEqual(LiftSettings.DEFAULT.weights)
  })

  it('should show the weights it was opened with, each in its person and exercise cell', () => {
    // Act
    renderPage(PhoneSettings.configurationUrl(PAGE_URL, SAVED))

    // Assert
    expect(tableValues()).toStrictEqual(SAVED.weights)
    expect(weightInput("Chloe's Deadlift weight, lbs").value).toBe('205')
  })

  it('should hand the edited weights back to return_to', async () => {
    // Arrange
    const user = userEvent.setup()
    const returnTo = 'pebblejs://close#'
    const navigate = renderPage(
      `${PhoneSettings.configurationUrl(PAGE_URL, SAVED)}&${ReturnTarget.PARAM}=${encodeURIComponent(returnTo)}`
    )
    const squat = weightInput("Ruth's Squat weight, lbs")

    // Act
    await user.clear(squat)
    await user.type(squat, '135')
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    const edited = { weights: [[135, 110, 95, 75, 185], SAVED.weights[1]] }
    expect(navigate).toHaveBeenCalledExactlyOnceWith(
      `${returnTo}${encodeURIComponent(LiftSettings.toJson(edited))}`
    )
    const [url = ''] = navigate.mock.lastCall ?? []
    const handedBack = LiftSettings.fromJson(decodeURIComponent(url.slice(returnTo.length)))
    expect(handedBack).toStrictEqual(Either.right(edited))
  })

  it('should name every bad weight and save nothing', async () => {
    // Arrange
    const user = userEvent.setup()
    const navigate = renderPage(PAGE_URL)
    const bench = weightInput("Chloe's Bench Press weight, lbs")
    const deadlift = weightInput("Ruth's Deadlift weight, lbs")

    // Act
    await user.clear(bench)
    await user.type(bench, '52.5')
    await user.clear(deadlift)
    await user.type(deadlift, String(Lifts.MAX_WEIGHT + 1))
    await user.click(screen.getByRole('button', { name: 'Save to watch' }))

    // Assert
    expect(navigate).not.toHaveBeenCalled()
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain("Chloe's Bench Press, Ruth's Deadlift")
    expect(bench.getAttribute('aria-invalid')).toBe('true')
    expect(deadlift.getAttribute('aria-invalid')).toBe('true')
    expect(weightInput("Ruth's Squat weight, lbs").getAttribute('aria-invalid')).toBe('false')
  })

  it('should refuse to send the weights anywhere but the Pebble app', () => {
    // Act
    renderPage(
      `${PAGE_URL}?${ReturnTarget.PARAM}=${encodeURIComponent('https://collector.example/#')}`
    )

    // Assert
    expect(screen.getByText(/not the Pebble app/)).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Save to watch' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})

// Helpers

const PAGE_URL = 'https://wildflowerhealth.io/watch-lifts/'

const SAVED: LiftSettings.Type = {
  weights: [
    [115, 110, 95, 75, 185],
    [120, 90, 85, 60, 205],
  ],
}

/** Renders the page as `main.tsx` does for `url`, returning its `navigate`. */
const renderPage = (url: string): ReturnType<typeof vi.fn<(url: string) => void>> => {
  const navigate = vi.fn<(url: string) => void>()
  const { settings, returnTarget } = readPageUrl(new URL(url))
  render(<WeightsPage settings={settings} returnTarget={returnTarget} navigate={navigate} />)
  return navigate
}

const weightInput = (name: string): HTMLInputElement =>
  screen.getByRole<HTMLInputElement>('textbox', { name })

/** Every cell's value, read by its label, as `weights[person][exercise]`. */
const tableValues = (): ReadonlyArray<ReadonlyArray<number>> =>
  Lifts.PEOPLE.map((person) =>
    Lifts.EXERCISES.map((exercise) =>
      Number(weightInput(`${person}'s ${exercise} weight, lbs`).value)
    )
  )
