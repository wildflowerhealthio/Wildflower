import { Option } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import { followableClientCallback } from './client-callback.ts'

describe('followableClientCallback', () => {
  test('follows an absolute http(s) callback', () => {
    for (const redirect of [
      'https://app.example/cb?code=c&state=s',
      'http://127.0.0.1:5173/cb?error=access_denied&state=s',
    ]) {
      expect(Option.map(followableClientCallback(redirect), (url) => url.href)).toEqual(
        Option.some(redirect)
      )
    }
  })

  test('refuses anything that is not an absolute http(s) URL', () => {
    for (const redirect of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'com.example.app:/cb?code=c',
      '/cb?code=c',
      '',
    ]) {
      expect(followableClientCallback(redirect)).toEqual(Option.none())
    }
  })
})
