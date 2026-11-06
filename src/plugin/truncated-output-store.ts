import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as logger from './logger.js'

// OpenCode keeps oversized tool output in <data>/opencode/tool-output and its default
// permissions let the model Read/Grep there without an external_directory prompt. It also
// deletes `tool_*` files there once they are 7 days old, so no cleanup of our own is needed.
const FILE_PREFIX = 'tool_kiro_'
// Re-touch a file at most this often while it keeps appearing in transcripts, so the
// 7-day cleanup never removes a file that is still referenced.
const TOUCH_INTERVAL_MS = 60 * 60 * 1000

const lastTouched = new Map<string, number>()
let lastWarning = ''

/** Same base directory OpenCode uses (xdg-basedir data dir on every platform). */
export function getToolOutputDir(): string {
  const dataHome = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'tool-output')
}

/**
 * Save the full text of a truncated transcript item and return its path, or undefined
 * when it cannot be written. The file name is derived from the content, so the same item
 * maps to the same path on every request and the rendered transcript stays byte-identical.
 */
export function saveTruncatedText(text: string): string | undefined {
  return saveContent(text, '')
}

/**
 * Save an image from a condensed or dropped turn so the model can Read it back later.
 * The extension follows the Kiro image format (png, jpeg, gif, webp) so OpenCode's Read
 * tool returns it as an image attachment.
 */
export function saveHistoryImage(bytes: Uint8Array, format: string): string | undefined {
  const extension = /^[a-z0-9]{1,8}$/i.test(format) ? `.${format.toLowerCase()}` : ''
  return saveContent(bytes, extension)
}

function saveContent(content: string | Uint8Array, extension: string): string | undefined {
  const dir = getToolOutputDir()
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 32)
  const path = join(dir, `${FILE_PREFIX}${hash}${extension}`)
  const now = Date.now()
  const touched = lastTouched.get(path)
  if (touched !== undefined && now - touched < TOUCH_INTERVAL_MS && existsSync(path)) return path

  try {
    mkdirSync(dir, { recursive: true })
    try {
      writeFileSync(path, content, { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const time = new Date(now)
      utimesSync(path, time, time)
    }
    lastTouched.set(path, now)
    return path
  } catch (error) {
    const message = `Could not save condensed history content to ${dir}: ${String(error)}`
    if (message !== lastWarning) {
      lastWarning = message
      logger.warn(message)
    }
    return undefined
  }
}

export function resetTruncatedOutputCache(): void {
  lastTouched.clear()
  lastWarning = ''
}
