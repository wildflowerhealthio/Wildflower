import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import { Option } from 'effect'
import type { ComponentProps, JSX } from 'react'
import Markdown, { type Components, type ExtraProps } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import styles from './reply-markdown.module.css'

/**
 * `url` when it is an absolute `https:` URL, else `null`, which drops the
 * attribute: links and nothing else reach outside the page, and only over
 * https.
 */
const httpsOnly = (url: string): string | null =>
  Option.liftThrowable(() => new URL(url))().pipe(
    Option.filter((parsed) => parsed.protocol === 'https:'),
    Option.match({ onNone: () => null, onSome: () => url })
  )

/**
 * A link that opens in a new tab, without a hold on this one; one whose
 * URL was dropped ({@link httpsOnly}) is its text alone.
 */
const ReplyLink = ({ href, children }: ComponentProps<'a'> & ExtraProps): JSX.Element =>
  href === undefined ? (
    <span>{children}</span>
  ) : (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )

const REPLY_COMPONENTS: Components = { a: ReplyLink }

/** Props for {@link ReplyMarkdown}: the Markdown, and any other `<div>` prop. */
interface ReplyMarkdownProps extends Omit<ComponentProps<'div'>, 'children'> {
  /** The reply's text, as the model wrote it. */
  readonly markdown: string
}

/**
 * Claude's reply text rendered as GitHub-flavoured Markdown (tables, task
 * lists, strikethrough).
 *
 * @remarks
 * Raw HTML in the text is skipped, never rendered. Links keep only `https:`
 * URLs and open in a new tab. Images are not rendered at all: an image
 * loads by itself, so a reply could otherwise send whatever its URL carries
 * to another site without a click.
 */
const ReplyMarkdown = ({ markdown, className, ...rootProps }: ReplyMarkdownProps): JSX.Element => (
  <div {...rootProps} className={cn(styles['reply-markdown'], className)}>
    <Markdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      urlTransform={httpsOnly}
      disallowedElements={['img']}
      components={REPLY_COMPONENTS}
    >
      {markdown}
    </Markdown>
  </div>
)

export { ReplyMarkdown }
export type { ReplyMarkdownProps }
