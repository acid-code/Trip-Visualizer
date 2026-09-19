import { describe, expect, it, beforeEach } from 'vitest'
import {
  clearChatSession,
  loadChatSession,
  saveChatSession,
} from './chatSession'

describe('chatSession', () => {
  beforeEach(() => {
    clearChatSession('T1')
  })

  it('round-trips user and assistant messages', () => {
    saveChatSession('T1', {
      messages: [
        { id: 'a', role: 'assistant', text: 'Hi' },
        { id: 'b', role: 'user', text: 'Birthday on Oct 3' },
        { id: 'c', role: 'assistant', text: 'Got it — centering Oct 3.' },
      ],
      modeLabel: 'Listening',
      reason: 'Heard the birthday date.',
      checklist: {
        vibe: true,
        route: false,
        stayZones: false,
        details: false,
        ready: false,
      },
    })
    const loaded = loadChatSession('T1')
    expect(loaded?.messages).toHaveLength(3)
    expect(loaded?.messages[1]?.role).toBe('user')
    expect(loaded?.messages[1]?.text).toMatch(/Birthday/)
    expect(loaded?.checklist.vibe).toBe(true)
    expect(loaded?.reason).toMatch(/birthday/i)
  })
})
