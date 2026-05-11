import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'

/**
 * Shared base. Both `vite.config.web.ts` and `vite.config.embedded.ts`
 * extend this with bundle-specific plugins / build options.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source'] },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
})
