export type ColorMode = 'light' | 'dark'

export const DEFAULT_COLOR_MODE: ColorMode = 'light'

export function isColorMode(v: string | null | undefined): v is ColorMode {
  return v === 'light' || v === 'dark'
}

export function applyColorMode(mode: ColorMode) {
  document.documentElement.dataset.theme = mode
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) {
    meta.setAttribute('content', mode === 'light' ? '#e5ddd0' : '#070b12')
  }
}
