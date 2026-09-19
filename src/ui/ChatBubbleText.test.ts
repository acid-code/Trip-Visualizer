import { describe, expect, it } from 'vitest'
import { extractChoiceChips, parseChatBlocks } from '../ui/ChatBubbleText'

describe('parseChatBlocks', () => {
  it('keeps paragraphs and numbered lists separate', () => {
    const blocks = parseChatBlocks(
      'Your Journey changed.\n\n1. Keep Nice?\n2. Or switch to Lyon?',
    )
    expect(blocks[0]).toEqual({ type: 'p', text: 'Your Journey changed.' })
    expect(blocks[1]).toEqual({
      type: 'ol',
      items: ['Keep Nice?', 'Or switch to Lyon?'],
    })
  })

  it('parses bullet lists', () => {
    const blocks = parseChatBlocks('Pick one:\n• Stay zones\n• Pace')
    expect(blocks[1]?.type).toBe('ul')
    if (blocks[1]?.type === 'ul') {
      expect(blocks[1].items).toEqual(['Stay zones', 'Pace'])
    }
  })
})

describe('extractChoiceChips', () => {
  it('returns numbered options', () => {
    expect(
      extractChoiceChips('Hmm.\n1. First option here\n2. Second option here'),
    ).toEqual(['First option here', 'Second option here'])
  })
})
