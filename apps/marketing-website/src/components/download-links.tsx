import type { JSX } from 'react'

import versionsData from '../../public/versions.json' with { type: 'json' }
import styles from './download-links.module.css'
import layout from './layout.module.css'

const PLATFORM_LABELS = [
  { key: 'darwin-universal', label: 'macOS' },
  { key: 'windows-x86_64', label: 'Windows' },
  { key: 'linux-x86_64', label: 'Linux' },
] as const

type PlatformKey = (typeof PLATFORM_LABELS)[number]['key']

type Versions = {
  readonly version: string
  readonly platforms: Readonly<Record<PlatformKey, { readonly url: string }>>
}

const versions = versionsData as Versions

/**
 * The FHIR server row's per-platform download block: one bold link per
 * platform over a quiet mono line naming the version. Mirrors the
 * `Launcher` block that sits below it (bold link + mono note), so the two
 * read as one column of calls-to-action.
 *
 * The version and each platform's installer URL are baked into the bundle
 * at build time from `apps/marketing-website/public/versions.json`, which
 * the `tauri-release-prepare` workflow rewrites on every version bump.
 */
function DownloadLinks(): JSX.Element {
  return (
    <div className={styles['downloads']}>
      <ul className={styles['downloads__list']}>
        {PLATFORM_LABELS.map(({ key, label }) => (
          <li key={key}>
            <a className={styles['downloads__link']} href={versions.platforms[key].url}>
              {label} &darr;
            </a>
          </li>
        ))}
      </ul>
      <span className={layout['mono-note']}>Download v{versions.version}</span>
    </div>
  )
}

export { DownloadLinks }
