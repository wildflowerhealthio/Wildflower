import type { JSX } from 'react'
import { useState } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './app-avatar.module.css'

interface AppAvatarProps {
  /** The app's display name — drives the monogram fallback and the img `alt`. */
  readonly name: string
  /**
   * The client's registered redirect URI. Its origin is where we look for the
   * app's `favicon.ico`. NOTE: rendering the favicon fires a request to the
   * third-party app's origin from the consent screen (before the user has
   * consented to anything) — an accepted tradeoff for showing a recognisable
   * app identity. A missing/blocked icon degrades to the monogram.
   */
  readonly redirectUri: string
}

/** The `<origin>/favicon.ico` URL for `redirectUri`, or `null` if it won't parse. */
const faviconUrl = (redirectUri: string): string | null => {
  try {
    return `${new URL(redirectUri).origin}/favicon.ico`
  } catch {
    return null
  }
}

/**
 * The app-identity avatar shown on the consent card: the app's favicon (scooped
 * from the redirect URI's origin) over a letter monogram fallback. The monogram
 * shows immediately when there's no parseable origin, and replaces the image if
 * the favicon fails to load (404, CSP block, transport error).
 */
const AppAvatar = ({ name, redirectUri }: AppAvatarProps): JSX.Element => {
  const src = faviconUrl(redirectUri)
  const [failed, setFailed] = useState(false)

  if (src === null || failed) {
    return (
      <div aria-hidden="true" className={cn(styles['avatar'], styles['monogram'])}>
        {name.slice(0, 1).toUpperCase()}
      </div>
    )
  }

  return (
    <img
      src={src}
      alt={`${name} logo`}
      className={cn(styles['avatar'], styles['favicon'])}
      onError={() => setFailed(true)}
    />
  )
}

export { AppAvatar }
export type { AppAvatarProps }
