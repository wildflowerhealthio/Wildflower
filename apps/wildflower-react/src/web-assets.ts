import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Absolute path to the built `dist-web/` directory, exported so the host app
// (wildflower-node) can pass it to a static-file middleware without
// hardcoding workspace-relative paths. At source-condition runtime this
// resolves from `apps/wildflower-react/src/` up to `apps/wildflower-react/`,
// then into `dist-web`.
//
// Source-only export: `package.json` declares only the `source` condition for
// `./web-assets` because `import.meta.url` is meaningful only against the
// real source file. There's no built-artifact equivalent — consumers must
// resolve with `--conditions=source` (which `wildflower-node`'s `dev`/`start`
// scripts already do). A built bundle that statically inlines `import.meta.url`
// would point at the bundle, not the asset directory, and silently break.
export const webAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist-web')
