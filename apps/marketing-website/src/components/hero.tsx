import type { JSX } from 'react'

import styles from './hero.module.css'
import layout from './layout.module.css'

/**
 * A single staccato line at the top of the hero. Rendered as its own
 * paragraph rather than a bullet — the notes read as a manifesto, not a
 * list.
 */
type HeroLine = {
  /** The plain sentence for this line. `emphasis`, if given, is italicised inside it. */
  readonly text: string
  /** Optional word or phrase from `text` to render in italics. */
  readonly emphasis?: string
}

const HERO_LINES: readonly HeroLine[] = [
  {
    text: "I've worked at three different health-tech startups that wanted to be the one place for all your health needs.",
  },
  { text: "I've got health data stored with eight different websites." },
  { text: 'I can record my vaccination history in five of them.' },
  { text: 'I built the vaccination history tool in one of them.', emphasis: 'built' },
  {
    text: 'My vaccination history is a JPEG attached to an email from my mom, because why would I bother typing it in somewhere.',
  },
]

/**
 * The opening banner: a single manifesto title and the five short, punchy
 * lines that set up the essay. Deliberately spare — no portrait, no stats,
 * no CTA. Those live in the "I'm Ruth" section immediately below.
 */
function Hero(): JSX.Element {
  return (
    <section className={styles['hero']} id="top">
      <div className={`${layout['column']} ${styles['hero__inner']}`}>
        <h2 className={styles['hero__title']}>
          Patients <i>deserve</i> health data freedom
        </h2>
        <div className={styles['hero__lines']}>
          {HERO_LINES.map((line) => (
            <p key={line.text} className={styles['hero__line']}>
              {renderLine(line)}
            </p>
          ))}
        </div>
      </div>
    </section>
  )
}

/**
 * Renders a hero line, italicising `emphasis` in place if it appears in
 * `text`. Falls back to plain text so a typo in `emphasis` never drops the
 * sentence.
 */
function renderLine(line: HeroLine): JSX.Element | string {
  if (line.emphasis === undefined) return line.text
  const index = line.text.indexOf(line.emphasis)
  if (index === -1) return line.text
  const before = line.text.slice(0, index)
  const after = line.text.slice(index + line.emphasis.length)
  return (
    <>
      {before}
      <i>{line.emphasis}</i>
      {after}
    </>
  )
}

export { Hero }
