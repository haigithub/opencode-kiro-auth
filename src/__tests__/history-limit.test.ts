import { describe, expect, test } from 'bun:test'
import { KIRO_CONSTANTS } from '../constants.js'
import {
  fitHistoryToEntryLimit,
  fitHistoryWithStage
} from '../infrastructure/transformers/history-builder.js'
import { DEFAULT_CONFIG, KiroConfigSchema } from '../plugin/config/schema.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { CodeWhispererMessage } from '../plugin/types'

const MODEL_ID = 'claude-opus-5.5'

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function user(content: string, toolResultIds: string[] = []): CodeWhispererMessage {
  return {
    userInputMessage: {
      content,
      modelId: MODEL_ID,
      origin: 'AI_EDITOR',
      ...(toolResultIds.length
        ? {
            userInputMessageContext: {
              toolResults: toolResultIds.map((id) => ({
                toolUseId: id,
                status: 'success',
                content: [{ text: `out ${id}` }]
              }))
            }
          }
        : {})
    }
  }
}

function asst(content: string, toolUseIds: string[] = []): CodeWhispererMessage {
  return {
    assistantResponseMessage: {
      content,
      ...(toolUseIds.length
        ? { toolUses: toolUseIds.map((id) => ({ toolUseId: id, name: 'bash', input: { id } })) }
        : {})
    }
  }
}

function agentLoop(steps: number, prefix = 't'): CodeWhispererMessage[] {
  const out: CodeWhispererMessage[] = []
  for (let i = 0; i < steps; i++) {
    out.push(asst(i === 0 ? 'Running.' : '[system: tool calling continues]', [`${prefix}${i}`]))
    out.push(user('Tool results provided.', [`${prefix}${i}`]))
  }
  return out
}

function assertWellFormed(history: CodeWhispererMessage[]) {
  expect(history[0]?.userInputMessage).toBeDefined()
  for (let i = 0; i < history.length; i++) {
    const e = history[i]!
    expect(!!e.userInputMessage !== !!e.assistantResponseMessage).toBe(true)
    if (i > 0) {
      expect(!!history[i - 1]!.userInputMessage).not.toBe(!!e.userInputMessage)
    }
    const results = e.userInputMessage?.userInputMessageContext?.toolResults
    if (results?.length) {
      const prevUses = new Set(
        (history[i - 1]?.assistantResponseMessage?.toolUses || []).map((u) => u.toolUseId)
      )
      for (const r of results) expect(prevUses.has(r.toolUseId)).toBe(true)
    }
  }
}

const toolUseIds = (h: CodeWhispererMessage[]) =>
  h.flatMap((e) => e.assistantResponseMessage?.toolUses || []).map((u) => u.toolUseId)

describe('fitHistoryToEntryLimit', () => {
  test('returns history unchanged when within the limit', () => {
    const history = [user('SYSTEM\n\nhello'), ...agentLoop(10)]
    expect(fitHistoryToEntryLimit(history, 198)).toBe(history)
  })

  test('folds oldest tool loop pairs without losing any tool call or result', () => {
    const history = [user('SYSTEM\n\nhello'), ...agentLoop(150), asst('done'), user('next')]
    const fitted = fitHistoryToEntryLimit(history, 198)

    expect(fitted.length).toBeLessThanOrEqual(198)
    assertWellFormed(fitted)
    expect(toolUseIds(fitted)).toEqual(toolUseIds(history))
    expect(fitted[0]).toBe(history[0])
    expect(fitted.at(-1)).toBe(history.at(-1))
    expect(fitted.at(-2)).toBe(history.at(-2))
    const resultIds = fitted.flatMap(
      (e) => e.userInputMessage?.userInputMessageContext?.toolResults?.map((r) => r.toolUseId) || []
    )
    expect(resultIds).toEqual(toolUseIds(history))
  })

  test('only folds as much as needed and keeps recent pairs untouched', () => {
    const history = [user('SYSTEM\n\nhello'), ...agentLoop(100)]
    const fitted = fitHistoryToEntryLimit(history, 198)

    expect(fitted.length).toBe(197)
    expect(fitted.slice(-150)).toEqual(history.slice(-150))
  })

  test('keeps real assistant text when folding pairs', () => {
    const history = [
      user('SYSTEM\n\nhello'),
      asst('first look', ['a']),
      user('Tool results provided.', ['a']),
      asst('found a bug', ['b']),
      user('Tool results provided.', ['b']),
      ...agentLoop(5, 'x')
    ]
    const fitted = fitHistoryToEntryLimit(history, history.length - 2)
    expect(fitted[1]!.assistantResponseMessage!.content).toBe('first look\n\nfound a bug')
    expect(fitted[1]!.assistantResponseMessage!.toolUses!.map((u) => u.toolUseId)).toEqual([
      'a',
      'b'
    ])
  })

  test('does not fold across a turn that carries real user text', () => {
    const history = [
      user('SYSTEM\n\nhello'),
      asst('', ['a']),
      user('please also check logs', ['a']),
      asst('', ['b']),
      user('Tool results provided.', ['b']),
      asst('', ['c']),
      user('Tool results provided.', ['c'])
    ]
    const fitted = fitHistoryToEntryLimit(history, 5)
    expect(fitted).toHaveLength(5)
    expect(fitted[2]).toBe(history[2])
    expect(fitted[3]!.assistantResponseMessage!.toolUses!.map((u) => u.toolUseId)).toEqual([
      'b',
      'c'
    ])
    assertWellFormed(fitted)
  })

  test('drops oldest turns when folding is not enough, keeping the system prompt turn', () => {
    const history: CodeWhispererMessage[] = [user('SYSTEM\n\nfirst')]
    for (let i = 0; i < 150; i++) {
      history.push(asst(`answer ${i}`))
      history.push(user(`question ${i}`))
    }
    const fitted = fitHistoryToEntryLimit(history, 198)

    expect(fitted.length).toBeLessThanOrEqual(198)
    assertWellFormed(fitted)
    expect(fitted[0]).toBe(history[0])
    expect(fitted[1]!.assistantResponseMessage!.content).toContain('earlier conversation turns')
    expect(fitted.at(-1)).toBe(history.at(-1))
  })

  test('never leaves a tool result without its tool call after dropping', () => {
    const history: CodeWhispererMessage[] = [user('SYSTEM\n\nfirst')]
    for (let i = 0; i < 120; i++) {
      history.push(asst(`step ${i}`, [`t${i}`]))
      history.push(user(`real feedback ${i}`, [`t${i}`]))
    }
    for (const limit of [198, 197, 51, 50, 3]) {
      const fitted = fitHistoryToEntryLimit(history, limit)
      expect(fitted.length).toBeLessThanOrEqual(limit)
      assertWellFormed(fitted)
    }
  })
})

describe('transformToSdkRequest history limit', () => {
  test('keeps long agent sessions under the Kiro history entry limit', () => {
    const messages: any[] = [{ role: 'user', content: 'Investigate the build' }]
    for (let i = 0; i < 160; i++) {
      messages.push({
        role: 'assistant',
        content: i % 20 === 0 ? `Checking step ${i}` : '',
        tool_calls: [
          { id: `call_${i}`, type: 'function', function: { name: 'bash', arguments: '{"c":1}' } }
        ]
      })
      messages.push({ role: 'tool', tool_call_id: `call_${i}`, content: `result ${i}` })
    }
    messages.push({ role: 'assistant', content: 'Build fixed.' })
    messages.push({ role: 'user', content: 'Thanks, now run tests' })

    const prepared: any = transformToSdkRequest(
      { system: 'You are helpful', messages, tools: [] },
      'claude-opus-5-5-thinking',
      auth,
      true
    )
    const history = prepared.conversationState.history as CodeWhispererMessage[]

    expect(history.length).toBeLessThanOrEqual(KIRO_CONSTANTS.MAX_HISTORY_ENTRIES)
    assertWellFormed(history)
    expect(history[0]!.userInputMessage!.content).toContain('You are helpful')
    expect(toolUseIds(history)).toHaveLength(160)
    expect(prepared.conversationState.currentMessage.userInputMessage.content).toBe(
      'Thanks, now run tests'
    )
  })
})

describe('compress_overflow_history', () => {
  function longChat(turns: number): CodeWhispererMessage[] {
    const history: CodeWhispererMessage[] = [user('SYSTEM\n\nfirst')]
    for (let i = 0; i < turns; i++) {
      history.push(asst(`answer ${i}`, [`t${i}`]))
      history.push(user(`question ${i}`, [`t${i}`]))
    }
    return history
  }

  test('is off by default in config', () => {
    expect(DEFAULT_CONFIG.compress_overflow_history).toBe(false)
    expect(KiroConfigSchema.parse({}).compress_overflow_history).toBe(false)
    expect(
      KiroConfigSchema.parse({ compress_overflow_history: true }).compress_overflow_history
    ).toBe(true)
  })

  test('disabled keeps the original drop behaviour', () => {
    const history = longChat(150)
    const off = fitHistoryWithStage(history, 198)
    expect(off.stage).toBe('drop')
    expect(off.history).toEqual(fitHistoryToEntryLimit(history, 198, { compressOverflow: false }))
    expect(off.history[1]!.assistantResponseMessage!.content).toContain(
      'earlier conversation turns'
    )
  })

  test('folding alone is reported as fold, and compression is not applied', () => {
    const history = [user('SYSTEM\n\nfirst'), ...agentLoop(150)]
    const fit = fitHistoryWithStage(history, 198, { compressOverflow: true })
    expect(fit.stage).toBe('fold')
    expect(fit.history[0]).toBe(history[0])
  })

  test('enabled keeps removed turns as a transcript in the first user turn', () => {
    const history = longChat(150)
    const fit = fitHistoryWithStage(history, 198, { compressOverflow: true })

    expect(fit.stage).toBe('compress')
    expect(fit.history.length).toBeLessThanOrEqual(198)
    assertWellFormed(fit.history)

    const head = fit.history[0]!.userInputMessage!.content
    expect(head.startsWith('SYSTEM\n\nfirst')).toBe(true)
    expect(head).toContain('<earlier_conversation')
    expect(head).toContain('Assistant: answer 0')
    expect(head).toContain('Assistant tool call bash (id t0) input: {"id":"t0"}')
    expect(head).toContain('Tool result (id t0): out t0')
    expect(head).toContain('User: question 0')
    expect(fit.history.at(-1)).toBe(history.at(-1))

    const kept = new Set(toolUseIds(fit.history))
    for (let i = 0; i < 150; i++) {
      const inTranscript = head.includes(`(id t${i})`)
      expect(inTranscript || kept.has(`t${i}`)).toBe(true)
      expect(inTranscript && kept.has(`t${i}`)).toBe(false)
    }
  })

  test('transcript skips placeholders and thinking, and cannot be parsed as a tool call', () => {
    const history: CodeWhispererMessage[] = [user('SYSTEM')]
    history.push(asst('<thinking>secret plan</thinking>\n\nvisible', ['a']))
    history.push(user('Tool results provided.', ['a']))
    for (let i = 0; i < 10; i++) {
      history.push(asst(`answer ${i}`))
      history.push(user(`question ${i}`))
    }
    const fit = fitHistoryWithStage(history, 5, { compressOverflow: true })
    const head = fit.history[0]!.userInputMessage!.content

    expect(fit.history.length).toBeLessThanOrEqual(5)
    assertWellFormed(fit.history)
    expect(head).toContain('Assistant: visible')
    expect(head).not.toContain('secret plan')
    expect(head).not.toContain('User: Tool results provided.')
    expect(head).not.toMatch(/\[Called\s+\w+\s+with\s+args:/)
  })

  test('is wired through transformToSdkRequest', () => {
    const messages: any[] = [{ role: 'user', content: 'Remember the code word is PELICAN-42' }]
    for (let i = 0; i < 120; i++) {
      messages.push({ role: 'assistant', content: `answer ${i}` })
      messages.push({ role: 'user', content: `question ${i}` })
    }
    const body = { system: 'You are helpful', messages, tools: [] }
    const run = (compressOverflowHistory: boolean) =>
      (
        transformToSdkRequest(body, 'claude-opus-5-5', auth, false, 20000, undefined, {
          compressOverflowHistory
        }) as any
      ).conversationState.history as CodeWhispererMessage[]

    const compressed = run(true)
    expect(compressed.length).toBeLessThanOrEqual(KIRO_CONSTANTS.MAX_HISTORY_ENTRIES)
    assertWellFormed(compressed)
    expect(compressed[0]!.userInputMessage!.content).toContain('PELICAN-42')
    expect(compressed[0]!.userInputMessage!.content).toContain('User: question 0')

    const dropped = run(false)
    expect(dropped[0]!.userInputMessage!.content).toContain('PELICAN-42')
    expect(dropped[0]!.userInputMessage!.content).not.toContain('question 0')
  })
})

describe('max_history_entries', () => {
  const body = () => {
    const messages: any[] = [{ role: 'user', content: 'start' }]
    for (let i = 0; i < 120; i++) {
      messages.push({ role: 'assistant', content: `answer ${i}` })
      messages.push({ role: 'user', content: `question ${i}` })
    }
    return { system: 'You are helpful', messages, tools: [] }
  }
  const historyFor = (maxHistoryEntries?: number) =>
    (
      transformToSdkRequest(body(), 'claude-opus-5-5', auth, false, 20000, undefined, {
        maxHistoryEntries
      }) as any
    ).conversationState.history as CodeWhispererMessage[]

  test('defaults to 198 and matches KIRO_CONSTANTS', () => {
    expect(DEFAULT_CONFIG.max_history_entries).toBe(198)
    expect(KiroConfigSchema.parse({}).max_history_entries).toBe(198)
    expect(DEFAULT_CONFIG.max_history_entries).toBe(KIRO_CONSTANTS.MAX_HISTORY_ENTRIES)
  })

  test('rejects out-of-range or fractional values', () => {
    expect(KiroConfigSchema.safeParse({ max_history_entries: 9 }).success).toBe(false)
    expect(KiroConfigSchema.safeParse({ max_history_entries: 10001 }).success).toBe(false)
    expect(KiroConfigSchema.safeParse({ max_history_entries: 150.5 }).success).toBe(false)
    expect(KiroConfigSchema.parse({ max_history_entries: 150 }).max_history_entries).toBe(150)
  })

  test('caps the history sent to Kiro at the configured value', () => {
    expect(historyFor().length).toBeLessThanOrEqual(198)
    expect(historyFor().length).toBeGreaterThan(150)
    for (const limit of [150, 100, 51]) {
      const history = historyFor(limit)
      expect(history.length).toBeLessThanOrEqual(limit)
      assertWellFormed(history)
    }
    expect(historyFor(1000).length).toBe(body().messages.length - 1)
  })
})
