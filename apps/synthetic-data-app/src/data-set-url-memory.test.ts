import { DEFAULT_DATA_SET_URL } from 'synthetic-data-react'
import { beforeEach, describe, expect, it } from 'vite-plus/test'

import {
  DATA_SET_PARAM,
  rememberDataSetParam,
  rememberDataSetUrl,
  rememberedDataSetUrl,
} from './data-set-url-memory.ts'

beforeEach(() => {
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/synthetic-data-app/')
})

describe('rememberedDataSetUrl', () => {
  it('should be the published data set until one is kept', () => {
    expect(rememberedDataSetUrl(window.sessionStorage)).toBe(DEFAULT_DATA_SET_URL)
  })

  it('should be the URL last kept', () => {
    rememberDataSetUrl(window.sessionStorage, 'http://localhost:8000/')
    rememberDataSetUrl(window.sessionStorage, 'http://localhost:9000/')

    expect(rememberedDataSetUrl(window.sessionStorage)).toBe('http://localhost:9000/')
  })
})

describe('rememberDataSetParam', () => {
  it('should keep the page’s ?dataSet=', () => {
    window.history.replaceState(
      null,
      '',
      `/synthetic-data-app/?${DATA_SET_PARAM}=${encodeURIComponent('http://localhost:8000/')}`
    )

    rememberDataSetParam(window)

    expect(rememberedDataSetUrl(window.sessionStorage)).toBe('http://localhost:8000/')
  })

  it('should keep what the tab had when the page names no data set, as after the SMART redirect', () => {
    rememberDataSetUrl(window.sessionStorage, 'http://localhost:8000/')
    window.history.replaceState(null, '', '/synthetic-data-app/?code=abc&state=xyz')

    rememberDataSetParam(window)

    expect(rememberedDataSetUrl(window.sessionStorage)).toBe('http://localhost:8000/')
  })
})
