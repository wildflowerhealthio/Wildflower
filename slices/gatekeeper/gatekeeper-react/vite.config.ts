import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      autoCodeSplitting: false,
      // Colocated `*.test.tsx` files live beside the route modules they
      // exercise; without this the route generator would treat them as
      // routes and pollute `routeTree.gen.ts`.
      routeFileIgnorePattern: '\\.(test|spec)\\.',
    }),
  ],
  pack: {
    dts: { tsgo: true },
    platform: 'neutral',
    exports: false,
    entry: {
      index: 'src/index.ts',
      'web-bridge': 'src/web-bridge.ts',
    },
  },
  test: {
    ...base.test,
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
