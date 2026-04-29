/**
 * Tundra-inspired design tokens for the Wildflower app.
 * Based on https://github.com/joshdales/tundra-css
 *
 * Light-mode-first, minimal aesthetic: white background, near-black text,
 * thin 1.5px borders, 6px border radius, system fonts.
 */

// --- Color Scales ---

const neutral = {
  1: '#161616',
  2: '#2e2e2e',
  3: '#484848',
  4: '#636363',
  5: '#808080',
  6: '#9e9e9e',
  7: '#bebebe',
  8: '#dedede',
  9: '#f5f5f5',
} as const

const blue = {
  1: '#000d49',
  2: '#002774',
  3: '#004495',
  4: '#1762b6',
  5: '#3a81d7',
  6: '#59a0f9',
  7: '#85c1ff',
  8: '#bfe1ff',
  9: '#e6f7ff',
} as const

const red = {
  1: '#380000',
  2: '#620000',
  3: '#910006',
  4: '#c20010',
  5: '#ee0b2a',
  6: '#ff5655',
  7: '#ff9890',
  8: '#ffccc5',
  9: '#ffece9',
} as const

const green = {
  1: '#001f0e',
  2: '#003b22',
  3: '#005939',
  4: '#007950',
  5: '#009b69',
  6: '#00bb87',
  7: '#41dca5',
  8: '#6afdc5',
  9: '#c4ffe8',
} as const

const yellow = {
  1: '#241100',
  2: '#432700',
  3: '#643f00',
  4: '#875900',
  5: '#ac7400',
  6: '#ce9200',
  7: '#f0b135',
  8: '#ffd470',
  9: '#fff1c2',
} as const

// --- Theme Colors ---

const Colors = {
  light: {
    background: '#ffffff',
    foreground: neutral[1],
    accent: blue[5],
    accentPressed: blue[3],
    accentSubtle: blue[9],
    border: neutral[6],
    borderSubtle: neutral[8],
    icon: neutral[5],
    textSecondary: neutral[4],
    textMuted: neutral[5],
    destructive: red[5],
    destructiveSubtle: red[9],
    success: green[5],
    successSubtle: green[9],
    warning: yellow[7],
    warningSubtle: yellow[9],
    cardBackground: '#ffffff',
    surfacePressed: neutral[9],
  },
  dark: {
    background: neutral[1],
    foreground: neutral[9],
    accent: blue[6],
    accentPressed: blue[7],
    accentSubtle: blue[1],
    border: neutral[4],
    borderSubtle: neutral[3],
    icon: neutral[6],
    textSecondary: neutral[7],
    textMuted: neutral[6],
    destructive: red[6],
    destructiveSubtle: red[1],
    success: green[6],
    successSubtle: green[1],
    warning: yellow[7],
    warningSubtle: yellow[2],
    cardBackground: neutral[2],
    surfacePressed: neutral[2],
  },
} as const

Colors.light satisfies Record<keyof typeof Colors.dark, string>
Colors.dark satisfies Record<keyof typeof Colors.light, string>

type ColorToken = keyof typeof Colors.light

// --- Spacing ---

const Spacing = {
  s1: 4,
  s2: 8,
  s3: 12,
  s4: 14,
  s5: 16,
  s6: 18,
  s7: 20,
  s8: 24,
  s9: 28,
  s10: 32,
  s11: 40,
  s12: 48,
  s13: 64,
} as const

// --- Typography ---

const FontSize = {
  xs: 12,
  sm: 14,
  base: 16,
  md: 18,
  lg: 20,
  xl: 24,
  '2xl': 28,
  '3xl': 32,
  '4xl': 48,
} as const

const FontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
}

const LineHeight = {
  tight: 1.0,
  snug: 1.15,
  normal: 1.25,
  relaxed: 1.5,
}

const LetterSpacing = {
  tighter: -0.04,
  tight: -0.02,
  normal: 0,
  wide: 0.02,
  wider: 0.04,
}

// --- Borders ---

const Borders = {
  width: 1.5,
  radius: 6,
  radiusSm: 3,
  radiusMd: 12,
  radiusLg: 24,
  radiusFull: 48,
} as const

// --- Shadows ---

const Shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.1,
    shadowRadius: 6,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 4, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 8,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 8, height: 8 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
    elevation: 6,
  },
} as const

// --- Raw color scales (for direct access when needed) ---

const Palette = { neutral, blue, red, green, yellow } as const

export {
  Borders,
  Colors,
  FontSize,
  FontWeight,
  LetterSpacing,
  LineHeight,
  Palette,
  Shadows,
  Spacing,
}
export type { ColorToken }
