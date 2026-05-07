import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Absolute path to the built `dist-web/` directory, exported so the host app
// (wildflower-node) can pass it to a static-file middleware without
// hardcoding workspace-relative paths. At source-condition runtime this
// resolves from `apps/wildflower-react/src/` up to `apps/wildflower-react/`,
// then into `dist-web`.
const here = dirname(fileURLToPath(import.meta.url))
const webAssetsDir = resolve(here, '..', 'dist-web')

export { webAssetsDir }
