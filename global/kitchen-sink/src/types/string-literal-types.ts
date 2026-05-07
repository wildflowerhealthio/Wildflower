type LowercaseLetter =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z'
type UppercaseLetter =
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z'

type Digit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'

type AlphanumericCharacter = UppercaseLetter | LowercaseLetter | Digit

const isDigit = (s: string): s is Digit => /^[0-9]$/.test(s)

const endsWithDigit = (s: string): s is `${string}${Digit}` => /\d$/.test(s)

const endsWithAlphanumericCharacter = (s: string): s is `${string}${AlphanumericCharacter}` =>
  /[a-zA-Z0-9]$/.test(s)

export { isDigit, endsWithDigit, endsWithAlphanumericCharacter }
export type { LowercaseLetter, UppercaseLetter, Digit, AlphanumericCharacter }
