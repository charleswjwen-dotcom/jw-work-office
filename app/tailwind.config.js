/** @type {import('tailwindcss').Config} */
import tailwindcssAnimate from 'tailwindcss-animate'

export default {
  content: ['./src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        'surface-raised': 'var(--bg-raised)',
        'surface-hover': 'var(--bg-hover)',
        'surface-active': 'var(--bg-active)',
        'border-sub': 'var(--border-sub)',
        border: 'var(--border)',
        'border-strong': 'var(--border-strong)',
        'text-faint': 'var(--fg-faint)',
        'text-muted': 'var(--fg-muted)',
        'text-body': 'var(--fg-body)',
        'text-head': 'var(--fg-head)',
        accent: 'var(--accent)',
        'accent-dim': 'var(--accent-dim)',
        'accent-hover': 'var(--accent-dim)',
        'accent-soft': 'var(--accent-soft)',
        'accent-text': 'var(--accent-text)',
        green: 'var(--green)',
        'green-soft': 'var(--green-soft)',
        amber: 'var(--amber)',
        'amber-soft': 'var(--amber-soft)',
        red: 'var(--red)',
        'red-soft': 'var(--red-soft)'
      },
      borderRadius: {
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius)',
        lg: 'var(--radius-lg)'
      },
      boxShadow: {
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-md)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)'
      },
      fontFamily: {
        sans: 'var(--font-sans)',
        mono: 'var(--font-mono)'
      }
    }
  },
  plugins: [tailwindcssAnimate]
}
