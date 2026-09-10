import { useEffect, useState } from 'react'

/** True when viewport is phone-width (Tailwind `md` breakpoint = 768px). */
export function useIsNarrow(maxWidthPx = 767): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia(`(max-width: ${maxWidthPx}px)`).matches
      : false,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${maxWidthPx}px)`)
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  }, [maxWidthPx])

  return narrow
}
