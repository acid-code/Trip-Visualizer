import { useEffect, useRef, useState } from 'react'

/** Reveals `text` character-by-character; calls onDone when finished. */
export function TypewriterText({
  text,
  active = true,
  cps = 38,
  onDone,
}: {
  text: string
  active?: boolean
  cps?: number
  onDone?: () => void
}) {
  const [shown, setShown] = useState(active ? '' : text)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone

  useEffect(() => {
    if (!active) {
      setShown(text)
      onDoneRef.current?.()
      return
    }
    setShown('')
    let i = 0
    const ms = Math.max(12, Math.floor(1000 / cps))
    const id = window.setInterval(() => {
      i += 1
      setShown(text.slice(0, i))
      if (i >= text.length) {
        window.clearInterval(id)
        onDoneRef.current?.()
      }
    }, ms)
    return () => window.clearInterval(id)
  }, [text, active, cps])

  return <span>{shown}</span>
}
