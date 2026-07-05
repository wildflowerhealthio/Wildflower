import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite-plus'
import monorepoBase from '../../vite.config.base.ts'
import { routes } from './routes.config.ts'

/**
 * Shared base. Both `vite.config.web.ts` and `vite.config.single-web.ts`
 * extend this with bundle-specific plugins / build options.
 *
 * `tanstackRouter` must run before `react()` so the generated route tree
 * is in place before the React transform. It reads the virtual config in
 * `routes.config.ts`, which mounts each slice's route directory into the
 * app tree, and writes `src/routeTree.gen.ts`.
 */
export default defineConfig({
  ...monorepoBase,
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      virtualRouteConfig: routes,
      autoCodeSplitting: false,
      // Colocated `*.test.tsx` files live beside the route modules they
      // exercise (here and in the slice route dirs mounted via
      // `physical()`); without this the route generator would treat them
      // as routes and pollute `routeTree.gen.ts`.
      routeFileIgnorePattern: '\\.(test|spec)\\.',
    }),
    react(),
  ],
})
