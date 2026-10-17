import { fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vite-plus/test'

import {
  awaitFirstPage,
  fetchMock,
  handshakeMock,
  lastPage,
  readyHandshake,
  setUpEachAppTest,
  tabLink,
} from '../../../test-utils/app-fakes.ts'
import { renderApp } from '../../../test-utils/render-app.ts'

vi.mock('@wildflowerhealthio/fhir-r4-react/smart', async () =>
  (await import('../../../test-utils/app-fakes.ts')).smartModuleFake()
)
vi.mock('../interactions/-interaction-catalog.ts', async () =>
  (await import('../../../test-utils/app-fakes.ts')).interactionCatalogModuleFake()
)

setUpEachAppTest()

describe('Savings tab', () => {
  it('should show the province picker and the program sections', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp()
    await awaitFirstPage()

    // Act
    fireEvent.click(tabLink('Savings'))

    // Assert
    expect(await screen.findByRole('combobox', { name: 'Province' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'innoviCares' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'RxHelp' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'No known savings program' })).toBeDefined()
  })

  it('should keep the chosen province across tab changes', async () => {
    // Arrange
    handshakeMock.mockReturnValue(readyHandshake)
    fetchMock.mockResolvedValue(lastPage)
    renderApp({ route: 'patients/p1/savings' })
    await awaitFirstPage()
    fireEvent.change(await screen.findByRole('combobox', { name: 'Province' }), {
      target: { value: 'QC' },
    })

    // Act
    fireEvent.click(tabLink('Calendar'))
    await screen.findByRole('button', { name: 'Next month' })
    fireEvent.click(tabLink('Savings'))

    // Assert
    const picker = await screen.findByRole('combobox', { name: 'Province' })
    expect(picker instanceof HTMLSelectElement ? picker.value : undefined).toBe('QC')
  })
})
