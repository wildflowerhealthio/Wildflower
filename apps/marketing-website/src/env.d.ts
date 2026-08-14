// `tundra-css` resolves to a stylesheet imported for its side effects; declare
// the bare specifier so it type-checks (the `*.css` ambient decl doesn't match
// a name that doesn't end in `.css`). Mirrors the app's env.d.ts.
declare module 'tundra-css'
