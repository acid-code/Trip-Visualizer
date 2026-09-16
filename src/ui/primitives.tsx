import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`ui-panel ${className}`}>{children}</div>
}

export function Chip({
  children,
  on,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button
      type="button"
      className={`ui-chip ${on ? 'ui-chip-on' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`ui-icon-btn ${className}`} {...rest}>
      {children}
    </button>
  )
}

export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className = '',
}: {
  value: T
  options: { id: T; label: string }[]
  onChange: (id: T) => void
  ariaLabel?: string
  className?: string
}) {
  return (
    <div className={`ui-seg ${className}`} role="tablist" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.id}
          type="button"
          role="tab"
          aria-selected={value === opt.id}
          className={`ui-seg-btn ${value === opt.id ? 'ui-seg-btn-on' : ''}`}
          onClick={() => onChange(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
