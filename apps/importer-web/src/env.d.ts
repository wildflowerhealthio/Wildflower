/// <reference types="vite/client" />

// Bare-specifier / CSS side-effect imports carry no type declarations of their
// own; declare them so the design-system + font imports in `main.tsx` typecheck.
declare module 'tundra-css'
declare module 'react-tundraish/styles.css'

declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'
