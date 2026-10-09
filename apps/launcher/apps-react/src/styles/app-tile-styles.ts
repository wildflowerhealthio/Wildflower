import styles from './app-tiles.module.css'

/**
 * Hashed class names for the apps home's tile list (`app-tiles.module.css`):
 * the `app-tiles` list, each `app-tile`, its `app-tile__body` with the
 * `app-tile__launch` link reset, and the `app-tile__head` / `__name` /
 * `__subtitle` text. Exported so another apps list, the launcher's Home on a
 * plain SMART server, draws its launch links as the same tiles.
 */
const appTileStyles = styles

export { appTileStyles }
