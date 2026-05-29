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
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
