import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineConfig } from 'vite-plus'
import base from '../../../vite.config.base.ts'

export default defineConfig({
  ...base,
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: './src',
      generatedRouteTree: './src/routeTree.gen.ts',
      virtualRouteConfig: './src/routes-config.ts',
    }),
    ...(base.plugins ?? []),
  ],
  pack: {
    dts: { tsgo: true },
    platform: 'browser',
    exports: false,
    entry: { index: 'src/index.ts' },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
