import { KIRO_CONSTANTS } from '../../constants.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import { getContentText } from './message-transformer.js'
import { deduplicateToolResults } from './tool-transformer.js'

/**
 * Collapse agentic loop sequences in the built history.
 *
 * Each agentic iteration gets a fresh conversationId, so the model re-derives its preamble
 * (intent detection, greeting) every iteration. When replayed for the next user turn, the
 * model sees duplicate preambles and gets confused.
 *
 * Strips text from intermediate ASST(toolUses)→USER(toolResults) pairs, keeping only the
 * first assistant text and all tool_use/tool_result pairs.
 */
export function collapseAgenticLoops(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  if (history.length < 4) return history

  const result: CodeWhispererMessage[] = []
  let i = 0

  while (i < history.length) {
    const entry = history[i]

    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const seqStart = i

      let j = i
      while (j < history.length) {
        const asst = history[j]
        if (!asst?.assistantResponseMessage?.toolUses) break
        const nextUser = j + 1 < history.length ? history[j + 1] : null
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break
        j += 2
      }

      const seqEnd = j
      const pairCount = (seqEnd - seqStart) / 2

      if (pairCount > 1) {
        for (let k = seqStart; k < seqEnd; k += 2) {
          const asst = history[k]
          const user = history[k + 1]

          if (k === seqStart) {
            result.push(asst!)
          } else {
            result.push({
              assistantResponseMessage: {
                content: '[system: tool calling continues]',
                toolUses: asst!.assistantResponseMessage!.toolUses
              }
            })
          }
          result.push(user!)
        }
      } else {
        for (let k = seqStart; k < seqEnd; k++) {
          result.push(history[k]!)
        }
      }

      i = seqEnd
    } else {
      result.push(entry!)
      i++
    }
  }

  return result
}

export function buildHistory(msgs: any[], resolved: string): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: getContentText(p.content || p) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
          uim.images = images
          if (omitted > 0) {
            uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`
          }
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: getContentText(m) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
        }
      })
    } else if (m.role === 'assistant') {
      const arm: any = { content: '' }
      const tus: any[] = []
      let th = ''
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') arm.content += p.text || ''
          else if (p.type === 'thinking') th += p.thinking || p.text || ''
          else if (p.type === 'tool_use')
            tus.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      } else arm.content = getContentText(m)
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          tus.push({
            input:
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments,
            name: tc.function?.name,
            toolUseId: tc.id
          })
        }
      }
      if (th)
        arm.content = arm.content
          ? `<thinking>${th}</thinking>\n\n${arm.content}`
          : `<thinking>${th}</thinking>`
      if (tus.length) arm.toolUses = tus

      if (!arm.content && !arm.toolUses) {
        continue
      }

      const prevMsg = history[history.length - 1]
      if (prevMsg && prevMsg.assistantResponseMessage) {
        // Merge consecutive assistant messages instead of injecting synthetic user turn
        const prev = prevMsg.assistantResponseMessage
        if (arm.content) {
          prev.content = prev.content ? `${prev.content}\n\n${arm.content}` : arm.content
        }
        if (arm.toolUses) {
          prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses]
        }
      } else {
        history.push({ assistantResponseMessage: arm })
      }
    }
  }
  return collapseAgenticLoops(history)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMsg = history.find((h) => !!h.userInputMessage)
  if (firstUserMsg && firstUserMsg.userInputMessage) {
    const oldContent = firstUserMsg.userInputMessage.content || ''
    firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
}

const TOOL_RESULTS_PLACEHOLDER = 'Tool results provided.'
const TOOL_CONTINUES_PLACEHOLDER = '[system: tool calling continues]'
const OMITTED_HISTORY_NOTE =
  '[system: earlier conversation turns were omitted to fit the Kiro history limit]'

function isToolCallPair(history: CodeWhispererMessage[], i: number): boolean {
  const asst = history[i]?.assistantResponseMessage
  const user = history[i + 1]?.userInputMessage
  return !!(
    asst?.toolUses?.length &&
    user?.userInputMessageContext?.toolResults?.length &&
    !user.images?.length
  )
}

function isPlaceholderToolResultTurn(entry: CodeWhispererMessage | undefined): boolean {
  const content = entry?.userInputMessage?.content?.trim() ?? ''
  return content === '' || content === TOOL_RESULTS_PLACEHOLDER
}

function mergeToolCallPairs(
  first: [CodeWhispererMessage, CodeWhispererMessage],
  second: [CodeWhispererMessage, CodeWhispererMessage]
): [CodeWhispererMessage, CodeWhispererMessage] {
  const [asstA, userA] = first
  const [asstB, userB] = second
  const textB = asstB.assistantResponseMessage!.content?.trim() ?? ''
  const contentA = asstA.assistantResponseMessage!.content ?? ''
  const content =
    textB && textB !== TOOL_CONTINUES_PLACEHOLDER
      ? contentA
        ? `${contentA}\n\n${textB}`
        : textB
      : contentA
  return [
    {
      assistantResponseMessage: {
        content,
        toolUses: [
          ...asstA.assistantResponseMessage!.toolUses!,
          ...asstB.assistantResponseMessage!.toolUses!
        ]
      }
    },
    {
      userInputMessage: {
        ...userB.userInputMessage!,
        userInputMessageContext: {
          ...userB.userInputMessage!.userInputMessageContext,
          toolResults: [
            ...userA.userInputMessage!.userInputMessageContext!.toolResults!,
            ...userB.userInputMessage!.userInputMessageContext!.toolResults!
          ]
        }
      }
    }
  ]
}

/**
 * Fold consecutive tool-call/tool-result pairs (oldest first) into single pairs carrying
 * several toolUses/toolResults. Lossless for content: only the per-step interleaving of
 * older tool loops is flattened. Recent pairs are left untouched once the limit is met.
 */
function foldToolCallPairs(history: CodeWhispererMessage[], maxEntries: number) {
  const result: CodeWhispererMessage[] = []
  let excess = history.length - maxEntries
  let i = 0
  while (i < history.length) {
    if (excess > 0 && i > 0 && isToolCallPair(history, i)) {
      let pair: [CodeWhispererMessage, CodeWhispererMessage] = [history[i]!, history[i + 1]!]
      i += 2
      while (excess > 0 && isPlaceholderToolResultTurn(pair[1]) && isToolCallPair(history, i)) {
        pair = mergeToolCallPairs(pair, [history[i]!, history[i + 1]!])
        i += 2
        excess -= 2
      }
      result.push(...pair)
    } else {
      result.push(history[i]!)
      i++
    }
  }
  return result
}

/**
 * Text of the reply to the first user turn when that reply is about to be dropped and
 * carries no tool calls. After OpenCode compacts a session this entry holds the summary,
 * so drop mode carries it over instead of losing it.
 */
function droppedLeadReply(history: CodeWhispererMessage[], start: number): string {
  if (start <= 1) return ''
  const reply = history[1]?.assistantResponseMessage
  if (!reply || reply.toolUses?.length) return ''
  return transcriptText(reply.content)
}

/**
 * Drop the oldest turns while keeping the first user message (it carries the injected
 * system prompt). The kept tail starts at an assistant entry so every retained toolResult
 * still follows the assistant toolUses it answers.
 */
function dropOldestTurns(history: CodeWhispererMessage[], maxEntries: number) {
  const head = history[0]?.userInputMessage ? [history[0]] : []
  let start = history.length - (maxEntries - head.length)
  while (start < history.length && !history[start]?.assistantResponseMessage) start++
  // Unreachable for alternating histories. Sending the input unchanged makes Kiro reject it
  // visibly instead of silently losing the system prompt or orphaning a toolResult.
  if (start >= history.length) return history

  const first = history[start]!.assistantResponseMessage!
  const lead = head.length ? droppedLeadReply(history, start) : ''
  const content = [lead, OMITTED_HISTORY_NOTE, first.content].filter(Boolean).join('\n\n')
  return [...head, { assistantResponseMessage: { ...first, content } }, ...history.slice(start + 1)]
}

const TRANSCRIPT_OPEN =
  '<earlier_conversation note="Older turns condensed into text to fit the Kiro history limit. ' +
  'Tool calls listed here already ran; do not repeat them or imitate this format.">'
const TRANSCRIPT_CLOSE = '</earlier_conversation>'
const PLACEHOLDER_CONTENTS = new Set([
  TOOL_RESULTS_PLACEHOLDER,
  TOOL_CONTINUES_PLACEHOLDER,
  '[system: conversation continues]'
])

function transcriptText(content: string | undefined): string {
  const text = (content ?? '').replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim()
  return PLACEHOLDER_CONTENTS.has(text) ? '' : text
}

function stringifyToolInput(input: unknown): string {
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input ?? {})
  } catch {
    return String(input)
  }
}

function escapeTranscriptTags(text: string): string {
  return text.replace(/<(\/?earlier_conversation)/gi, '&lt;$1')
}

/** Persists the full text of a truncated item; returns its path, or undefined on failure. */
export type TruncatedTextSaver = (text: string) => string | undefined

/**
 * Keep the head and tail of text longer than maxChars around a truncation marker, cutting
 * at line breaks when one falls in the outer half of each budget (whole lines read better
 * than a split line), otherwise at a character boundary that never splits a surrogate
 * pair. When `save` stores the full text, the marker points at the file so the model can
 * read the omitted middle. maxChars <= 0 (or non-finite) disables the cap.
 */
export function truncateMiddle(text: string, maxChars: number, save?: TruncatedTextSaver): string {
  if (!(maxChars > 0) || !Number.isFinite(maxChars) || text.length <= maxChars) return text
  const headBudget = Math.ceil(maxChars / 2)
  const tailBudget = Math.floor(maxChars / 2)
  const headEnd = headCut(text, headBudget)
  const tailStart = tailCut(text, text.length - tailBudget, tailBudget)
  const omitted = tailStart - headEnd
  const path = save?.(text)
  const marker = path
    ? `[... ${omitted} chars truncated; full content saved to ${path} (use Read with offset/limit or Grep) ...]`
    : `[... ${omitted} chars truncated ...]`
  return `${text.slice(0, headEnd)}\n${marker}\n${text.slice(tailStart)}`
}

function headCut(text: string, budget: number): number {
  const newline = text.lastIndexOf('\n', budget - 1)
  if (newline >= Math.floor(budget / 2)) return newline
  return isHighSurrogate(text.charCodeAt(budget - 1)) ? budget - 1 : budget
}

function tailCut(text: string, start: number, budget: number): number {
  const newline = text.indexOf('\n', start)
  if (newline !== -1 && newline < start + Math.ceil(budget / 2)) return newline + 1
  return isLowSurrogate(text.charCodeAt(start)) ? start + 1 : start
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

interface TranscriptLimits {
  toolResultMaxChars: number
  toolInputMaxChars: number
  save?: TruncatedTextSaver
}

function renderTranscript(entries: CodeWhispererMessage[], limits: TranscriptLimits): string {
  const lines: string[] = []
  for (const entry of entries) {
    const asst = entry.assistantResponseMessage
    if (asst) {
      const text = transcriptText(asst.content)
      if (text) lines.push(`Assistant: ${text}`)
      for (const use of asst.toolUses ?? []) {
        lines.push(
          `Assistant tool call ${use.name} (id ${use.toolUseId}) input: ${truncateMiddle(stringifyToolInput(use.input), limits.toolInputMaxChars, limits.save)}`
        )
      }
      continue
    }
    const user = entry.userInputMessage
    if (!user) continue
    for (const result of user.userInputMessageContext?.toolResults ?? []) {
      const output = truncateMiddle(
        result.content.map((c) => c.text ?? '').join('\n'),
        limits.toolResultMaxChars,
        limits.save
      )
      const status = result.status && result.status !== 'success' ? ` [${result.status}]` : ''
      lines.push(`Tool result (id ${result.toolUseId})${status}: ${output}`)
    }
    const text = transcriptText(user.content)
    if (text) lines.push(`User: ${text}`)
    if (user.images?.length) lines.push(`User: [${user.images.length} image(s) omitted]`)
  }
  return lines.join('\n\n')
}

/**
 * Like dropOldestTurns, but the removed turns are rendered as a text transcript
 * appended to the first user turn, so their content stays visible to the model.
 * Tool calls become plain text: Kiro requires every toolResult to follow its
 * toolUses, which cannot hold once the turns no longer exist as entries.
 */
function compressOldestTurns(
  history: CodeWhispererMessage[],
  maxEntries: number,
  limits: TranscriptLimits
) {
  const head = history[0]?.userInputMessage
  if (!head) return dropOldestTurns(history, maxEntries)
  let start = history.length - (maxEntries - 1)
  while (start < history.length && !history[start]?.assistantResponseMessage) start++
  if (start >= history.length) return dropOldestTurns(history, maxEntries)

  const transcript = escapeTranscriptTags(renderTranscript(history.slice(1, start), limits))
  const content = transcript
    ? `${head.content}\n\n${TRANSCRIPT_OPEN}\n${transcript}\n${TRANSCRIPT_CLOSE}`
    : head.content
  return [{ userInputMessage: { ...head, content } }, ...history.slice(start)]
}

export type HistoryFitStage = 'none' | 'fold' | 'drop' | 'compress'

export interface HistoryFitOptions {
  compressOverflow?: boolean
  /** Compress mode: max chars per old tool result in the transcript (0 = no cap). */
  toolResultMaxChars?: number
  /** Compress mode: max chars per old tool call input in the transcript (0 = no cap). */
  toolInputMaxChars?: number
  /** Compress mode: stores the full text of truncated items so the marker can link to it. */
  saveTruncatedText?: TruncatedTextSaver
}

// Smallest limit that still leaves the system-prompt turn plus one assistant entry.
const MIN_HISTORY_ENTRIES = 3

function normalizeMaxEntries(maxEntries: number): number {
  if (!Number.isFinite(maxEntries)) return KIRO_CONSTANTS.MAX_HISTORY_ENTRIES
  return Math.max(MIN_HISTORY_ENTRIES, Math.floor(maxEntries))
}

export function fitHistoryWithStage(
  history: CodeWhispererMessage[],
  requestedMaxEntries: number = KIRO_CONSTANTS.MAX_HISTORY_ENTRIES,
  options: HistoryFitOptions = {}
): { history: CodeWhispererMessage[]; stage: HistoryFitStage } {
  const maxEntries = normalizeMaxEntries(requestedMaxEntries)
  if (history.length <= maxEntries) return { history, stage: 'none' }
  const folded = foldToolCallPairs(history, maxEntries)
  if (folded.length <= maxEntries) return { history: folded, stage: 'fold' }
  if (options.compressOverflow) {
    const limits = {
      toolResultMaxChars:
        options.toolResultMaxChars ?? KIRO_CONSTANTS.COMPRESS_TOOL_RESULT_MAX_CHARS,
      toolInputMaxChars: options.toolInputMaxChars ?? KIRO_CONSTANTS.COMPRESS_TOOL_INPUT_MAX_CHARS,
      save: options.saveTruncatedText
    }
    return { history: compressOldestTurns(folded, maxEntries, limits), stage: 'compress' }
  }
  return { history: dropOldestTurns(folded, maxEntries), stage: 'drop' }
}

export function fitHistoryToEntryLimit(
  history: CodeWhispererMessage[],
  maxEntries: number = KIRO_CONSTANTS.MAX_HISTORY_ENTRIES,
  options: HistoryFitOptions = {}
): CodeWhispererMessage[] {
  return fitHistoryWithStage(history, maxEntries, options).history
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses) {
      for (const tu of h.assistantResponseMessage.toolUses) {
        if (tu.name) toolNames.add(tu.name)
      }
    }
  }
  return toolNames
}
