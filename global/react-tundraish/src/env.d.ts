declare module '*.module.css' {
  const classes: Readonly<Record<string, string>>
  export default classes
}

declare module '*.css'

// `tundra-css` is a bare specifier whose package export is a stylesheet;
// `styles.ts` imports it for its side effect only.
declare module 'tundra-css'
