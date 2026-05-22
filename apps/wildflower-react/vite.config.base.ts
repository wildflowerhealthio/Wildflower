import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
import monorepoBase from '../../vite.config.base.ts'

/**
 * Shared base. Both `vite.config.web.ts` and `vite.config.embedded.ts`
 * extend this with bundle-specific plugins / build options.
 */
export default defineConfig({
  ...monorepoBase,
  plugins: [react()],
})
