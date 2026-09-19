/**
 * Render assistant/user chat text with readable paragraphs and lists.
 */

import type { ReactNode } from 'react'

export type ChatBlock =
  | { type: 'p'; text: string }
  | { type: 'ol'; items: string[] }
  | { type: 'ul'; items: string[] }

const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/
const BULLET = /^\s*[•*\-–—]\s+(.*)$/

/** Split free-form chat text into paragraphs and lists. */
export function parseChatBlocks(text: string): ChatBlock[] {
  const raw = text.replace(/\r\n/g, '\n').trim()
  if (!raw) return []

  const lines = raw.split('\n')
  const blocks: ChatBlock[] = []
  let para: string[] = []
  let ol: string[] | null = null
  let ul: string[] | null = null

  const flushPara = () => {
    if (!para.length) return
    const t = para.join(' ').replace(/\s+/g, ' ').trim()
    if (t) blocks.push({ type: 'p', text: t })
    para = []
  }
  const flushOl = () => {
    if (ol?.length) blocks.push({ type: 'ol', items: ol })
    ol = null
  }
  const flushUl = () => {
    if (ul?.length) blocks.push({ type: 'ul', items: ul })
    ul = null
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      flushPara()
      flushOl()
      flushUl()
      continue
    }
    const num = trimmed.match(NUMBERED)
    if (num) {
      flushPara()
      flushUl()
      if (!ol) ol = []
      ol.push(num[2]!.trim())
      continue
    }
    const bullet = trimmed.match(BULLET)
    if (bullet) {
      flushPara()
      flushOl()
      if (!ul) ul = []
      ul.push(bullet[1]!.trim())
      continue
    }
    flushOl()
    flushUl()
    para.push(trimmed)
  }
  flushPara()
  flushOl()
  flushUl()
  return blocks
}

/** Extract choice labels from the last numbered list (for quick-reply chips). */
export function extractChoiceChips(text: string): string[] {
  const blocks = parseChatBlocks(text)
  const ol = [...blocks].reverse().find((b) => b.type === 'ol')
  if (!ol || ol.type !== 'ol') return []
  return ol.items.filter((i) => i.length >= 2 && i.length <= 140).slice(0, 6)
}

type Props = {
  text: string
  /** Soften contrast for user bubbles on violet. */
  onAccent?: boolean
  className?: string
}

export function ChatBubbleText({ text, onAccent, className = '' }: Props) {
  const blocks = parseChatBlocks(text)
  if (!blocks.length) return null

  const muted = onAccent ? 'text-white/80' : 'text-violet-100/70'
  const strong = onAccent ? 'text-white' : 'text-violet-50'

  const nodes: ReactNode[] = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.type === 'p') {
      nodes.push(
        <p key={`p-${i}`} className={`${strong} ${i > 0 ? 'mt-2.5' : ''}`}>
          {b.text}
        </p>,
      )
    } else if (b.type === 'ol') {
      nodes.push(
        <ol
          key={`ol-${i}`}
          className={`mt-2.5 list-decimal space-y-1.5 pl-4 ${strong}`}
        >
          {b.items.map((item, j) => (
            <li key={j} className="pl-0.5 leading-snug">
              {item}
            </li>
          ))}
        </ol>,
      )
    } else {
      nodes.push(
        <ul
          key={`ul-${i}`}
          className={`mt-2.5 list-none space-y-1.5 ${strong}`}
        >
          {b.items.map((item, j) => (
            <li key={j} className="flex gap-2 leading-snug">
              <span className={`shrink-0 ${muted}`} aria-hidden>
                •
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>,
      )
    }
  }

  return <div className={`text-sm leading-relaxed ${className}`}>{nodes}</div>
}
