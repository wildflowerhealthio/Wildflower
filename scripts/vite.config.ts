import { defineConfig } from 'vite-plus'
import base from '../vite.config.base.ts'

// Registers `scripts/` as its own Vitest project (wired into the root
// vite.config.ts `projects` list) so tests for repo-tooling scripts — which
// live outside every workspace package — actually run under `vp test`.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['**/*.test.ts'],
  },
})
