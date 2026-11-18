/**
 * Kansview design tokens (docs/design/README.md, approved 2026-11-18) mapped onto a Mantine theme.
 * Navy is the primary colour; red is reserved for emergency actions/views and arrears.
 */
import { createTheme, type MantineColorsTuple } from '@mantine/core';

export const tokens = {
  navy: '#1f3a6e',
  ink: '#1d2433',
  paper: '#f6f3ee',
  line: '#d8d2c7',
  red: '#b3261e',
  success: '#dff0e3',
  warning: '#fbf0d4',
  muted: '#5b6272',
} as const;

// Shade 7 is the token value; lighter shades for pills/hover, darker for pressed.
const navy: MantineColorsTuple = ['#eef2f9', '#dbe3f1', '#b4c3e0', '#8aa1cd', '#6684bd', '#4a6aa3', '#2f4f88', '#1f3a6e', '#192f59', '#122244'];
const emergency: MantineColorsTuple = ['#fbeceb', '#f6d6d4', '#ecaaa6', '#e17d77', '#d65750', '#cb3e36', '#c0302a', '#b3261e', '#931f18', '#721812'];
const sand: MantineColorsTuple = ['#fbfaf7', '#f6f3ee', '#ede8df', '#e3ddd2', '#d8d2c7', '#bdb5a6', '#9e9584', '#7d7564', '#5f584a', '#423d33'];

export const theme = createTheme({
  colors: { navy, red: emergency, sand },
  primaryColor: 'navy',
  primaryShade: 7,
  black: tokens.ink,
  white: '#ffffff',
  fontFamily: '"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif',
  fontFamilyMonospace: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
  headings: {
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif',
    fontWeight: '600',
    sizes: {
      h1: { fontSize: '30px', lineHeight: '1.2' },
      h2: { fontSize: '20px', lineHeight: '1.3' },
      h3: { fontSize: '16px', lineHeight: '1.35' },
      h4: { fontSize: '16px', lineHeight: '1.35' },
      h5: { fontSize: '14px', lineHeight: '1.4' },
    },
  },
  // Type scale 12 / 14 / 16 / 20 / 30.
  fontSizes: { xs: '12px', sm: '14px', md: '16px', lg: '20px', xl: '30px' },
  // 8 px spacing unit.
  spacing: { xs: '8px', sm: '12px', md: '16px', lg: '24px', xl: '32px' },
  radius: { xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px' },
  defaultRadius: 'sm',
  components: {
    Button: { defaultProps: { size: 'sm' } },
    Card: { defaultProps: { withBorder: true, radius: 'md', padding: 'md' } },
    Paper: { defaultProps: { radius: 'md' } },
    Badge: { defaultProps: { radius: 'xl', variant: 'light' } },
    Switch: { defaultProps: { color: 'navy' } },
    Checkbox: { defaultProps: { color: 'navy' } },
    Table: { defaultProps: { verticalSpacing: 'sm', horizontalSpacing: 'md' } },
  },
});
