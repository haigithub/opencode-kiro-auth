import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { getUsageStatusPath } from './config/loader.js'
import * as logger from './logger.js'
import { summarizeUsage } from './usage.js'

// The server plugin and the TUI run in different processes, so the server hands the
// current account's usage to the TUI through a small JSON file next to kiro.db.

export interface UsageStatus {
  text: string
  email?: string
  used: number
  limit: number
  pct: number
  updatedAt: number
}

/** Same numbers as the usage toast, without the email: `Usage: 12.5/1000 (1%)`. */
export function formatUsageStatus(usedCount: number, limitCount: number): string {
  const { used, limit, pct } = summarizeUsage(usedCount, limitCount)
  return limit > 0 ? `Usage: ${used}/${limit} (${pct}%)` : `Usage: ${used}`
}

let lastWriteError = ''

export function writeUsageStatus(account: {
  email?: string
  usedCount?: number
  limitCount?: number
}): void {
  const path = getUsageStatusPath()
  const { used, limit, pct } = summarizeUsage(account.usedCount ?? 0, account.limitCount ?? 0)
  const status: UsageStatus = {
    text: formatUsageStatus(account.usedCount ?? 0, account.limitCount ?? 0),
    email: account.email,
    used,
    limit,
    pct,
    updatedAt: Date.now()
  }
  try {
    mkdirSync(dirname(path), { recursive: true })
    // Write then rename, so the TUI never reads a half-written file.
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(status), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    const message = `Could not write usage status to ${path}: ${String(error)}`
    if (message !== lastWriteError) {
      lastWriteError = message
      logger.warn(message)
    }
  }
}

/** Status-bar text from the status file, or undefined when it is missing or unreadable. */
export function readUsageStatusText(path = getUsageStatusPath()): string | undefined {
  try {
    const status = JSON.parse(readFileSync(path, 'utf8')) as Partial<UsageStatus>
    return typeof status.text === 'string' && status.text ? status.text : undefined
  } catch {
    return undefined
  }
}

/**
 * Polls the status file and calls `onChange` with the new text whenever it changes.
 * Only the file's mtime is checked between reads. Returns a function that stops polling.
 */
export function watchUsageStatus(
  onChange: (text: string | undefined) => void,
  intervalMs = 2000,
  path = getUsageStatusPath()
): () => void {
  let lastMtime = -1
  let lastText: string | undefined
  const check = () => {
    let mtime = 0
    try {
      mtime = statSync(path).mtimeMs
    } catch {
      mtime = 0
    }
    if (mtime === lastMtime) return
    lastMtime = mtime
    const text = mtime ? readUsageStatusText(path) : undefined
    if (text !== lastText) {
      lastText = text
      onChange(text)
    }
  }
  check()
  const timer = setInterval(check, intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
