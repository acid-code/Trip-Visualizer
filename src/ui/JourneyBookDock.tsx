import type { ReactNode } from 'react'

export type TongueId = 'timeline' | 'charts' | 'insert' | 'ai' | 'settings'

export type TongueDef = {
  id: TongueId
  label: string
}

type Props = {
  open: boolean
  pagesClassName: string
  tongues: TongueDef[]
  isTongueOn: (id: TongueId) => boolean
  isTongueDisabled: (id: TongueId) => boolean
  onTongue: (id: TongueId) => void
  tongueTitle: (id: TongueId) => string | undefined
  renderTongueLabel: (id: TongueId, label: string) => ReactNode
  insertHighlight?: boolean
  wide?: boolean
  children: ReactNode
}

/**
 * Binders sit in their own row under the sheet so they are never covered by
 * page content — tapping any tongue always switches / toggles.
 */
export function JourneyBookDock({
  open,
  pagesClassName,
  tongues,
  isTongueOn,
  isTongueDisabled,
  onTongue,
  tongueTitle,
  renderTongueLabel,
  insertHighlight,
  wide,
  children,
}: Props) {
  return (
    <div
      className={`book-dock z-50 ${
        wide ? 'book-dock-wide' : ''
      }`}
    >
      <div className={`book-volume ${open ? 'book-volume-open' : ''}`}>
        <div className={`book-pages ${pagesClassName}`} aria-hidden={!open}>
          {children}
        </div>
      </div>
      <nav className="book-dividers" aria-label="Journey sections">
        {tongues.map((t, index) => {
          const on = isTongueOn(t.id)
          const disabled = isTongueDisabled(t.id)
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              style={{ ['--layer' as string]: index }}
              className={`book-divider ${on ? 'book-divider-on' : ''} ${
                t.id === 'insert' ? 'book-divider-plus' : ''
              } ${t.id === 'ai' ? 'book-divider-ai' : ''} ${
                t.id === 'insert' && insertHighlight ? 'ring-2 ring-orange-400' : ''
              } ${disabled ? 'opacity-40' : ''}`}
              onClick={() => {
                if (disabled) return
                onTongue(t.id)
              }}
              title={tongueTitle(t.id)}
            >
              {renderTongueLabel(t.id, t.label)}
            </button>
          )
        })}
      </nav>
    </div>
  )
}

export const JOURNEY_TONGUES: TongueDef[] = [
  { id: 'timeline', label: 'Steps' },
  { id: 'charts', label: 'Stats' },
  { id: 'insert', label: '+' },
  { id: 'ai', label: 'AI' },
  { id: 'settings', label: 'Settings' },
]
