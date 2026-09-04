import type { SponsorProgram } from 'medication-sponsorship-core'

interface ProgramDescription {
  /** A short plain-text summary of the program, in the program's own terms. */
  readonly text: string
  /** The program page the summary is drawn from (also the attribution link). */
  readonly source: string
}

/**
 * Patient-facing descriptions of each savings program, summarized from the
 * programs' own sites (linked as `source`). Copy, not data: revisit against
 * the sites when a program changes its offer.
 */
export const programDescriptions: Readonly<Record<SponsorProgram, ProgramDescription>> = {
  innovicares: {
    text:
      'A free prescription savings card used by millions of Canadians to lower the cost of ' +
      'original brand medications. Sign up online, and present the card at your pharmacy with ' +
      'a prescription for a covered medication — it works with or without insurance, never ' +
      'expires, and covers over 70 original brand medications.',
    source: 'https://innovicares.ca',
  },
  rxhelp: {
    text:
      'A free brand-name prescription savings card that connects Canadian patients to ' +
      'pharmaceutical manufacturers’ payment-assistance programs at no charge — helping you ' +
      'stay on your brand-name medicine for little or no cost over the generic, or offsetting ' +
      'out-of-pocket costs your drug plan does not cover. Accepted at most pharmacies in Canada.',
    source: 'https://www.rxhelp.ca',
  },
}

export type { ProgramDescription }
