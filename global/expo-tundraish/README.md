# expo-tundraish

Tundra-inspired shared UI primitives, theme tokens, and hooks for Expo/React Native apps.

## Scope

This package targets **Expo native runtimes (iOS / Android) only**. It does not ship a web build:

- Hooks rely on Metro's platform-specific resolution (e.g. `*.ios.tsx`, `*.android.tsx`); `vp pack` follows the static import graph and has no equivalent.
- `dist/index.js` is emitted with `platform: 'neutral'` and bundles the React Native variants directly.
- Consumers using non-Metro bundlers (Next.js, plain Vite for web) are not supported.

If a consuming Expo app drops the `web` platform from `app.json`, this package will continue to work without changes.

## Main exports

- **Components**: `AnimatedHeaderBackground`, `IconSymbol`, `ThemedButton`, `ThemedText`, `ThemedView`
- **Hooks**: `useColorScheme`, `useThemeColors`
- **Theme tokens**: `Colors`, `Palette`, `Spacing`, `FontSize`, `FontWeight`, `LineHeight`, `LetterSpacing`, `Borders`, `Shadows`

## Development

```bash
vp install   # install dependencies
vp check     # format + lint + typecheck
vp pack      # build dist/
```
