import styles from './page-layout.module.css'

/** Class-name keys exported by the shared {@link pageLayoutStyles} CSS module. */
type PageLayoutClassName = 'page' | 'error'

/**
 * Hashed class names for the shared page-layout primitives — the centered
 * `.page` shell used as a top-level container, and the red-tinted `.error`
 * panel rendered by `<PageBodyError>`. Re-exported so slices can build their
 * own screens with the same baseline without re-declaring the CSS rules.
 */
const pageLayoutStyles = styles as Readonly<Record<PageLayoutClassName, string>>

export { pageLayoutStyles }
export type { PageLayoutClassName }
