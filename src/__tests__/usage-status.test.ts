import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountSelector } from '../core/account/account-selector.js'
import { AuthHandler } from '../core/auth/auth-handler.js'
import { getUsageStatusPath, loadConfig } from '../plugin/config/loader.js'
import { DEFAULT_CONFIG } from '../plugin/config/schema.js'
import {
  formatUsageStatus,
  readUsageStatusText,
  watchUsageStatus,
  writeUsageStatus
} from '../plugin/usage-status.js'

// Every test writes the status file (and any log lines) into a throwaway config dir.
const ENV_KEYS = ['XDG_CONFIG_HOME', 'APPDATA', 'KIRO_USAGE_IN_STATUS_BAR'] as const
let configHome = ''
let saved: (string | undefined)[] = []

beforeEach(() => {
  saved = ENV_KEYS.map((key) => process.env[key])
  configHome = mkdtempSync(join(tmpdir(), 'kiro-usage-status-'))
  process.env.XDG_CONFIG_HOME = configHome
  process.env.APPDATA = configHome
  delete process.env.KIRO_USAGE_IN_STATUS_BAR
})

afterEach(() => {
  ENV_KEYS.forEach((key, i) => {
    const value = saved[i]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  })
  rmSync(configHome, { recursive: true, force: true })
})

function account(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'acc-1',
    email: 'user@example.com',
    isHealthy: true,
    lastUsed: 0,
    usedCount: 950.456,
    limitCount: 1000,
    ...overrides
  }
}

describe('formatUsageStatus', () => {
  test('matches the toast numbers without the email', () => {
    expect(formatUsageStatus(950.456, 1000)).toBe('Usage: 950.46/1000 (95%)')
    expect(formatUsageStatus(2279.84, 1000)).toBe('Usage: 2279.84/1000 (228%)')
  })

  test('shows only the used amount when there is no limit', () => {
    expect(formatUsageStatus(12.5, 0)).toBe('Usage: 12.5')
  })
})

describe('usage status file', () => {
  test('is written next to kiro.json with mode 0600 and read back', () => {
    writeUsageStatus(account())
    const path = getUsageStatusPath()
    expect(path).toBe(join(configHome, 'opencode', 'kiro-usage-status.json'))
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      text: 'Usage: 950.46/1000 (95%)',
      email: 'user@example.com',
      used: 950.46,
      limit: 1000,
      pct: 95
    })
    expect(readUsageStatusText()).toBe('Usage: 950.46/1000 (95%)')
  })

  test('reads as undefined when missing or malformed', () => {
    expect(readUsageStatusText()).toBeUndefined()
    writeUsageStatus(account())
    writeFileSync(getUsageStatusPath(), '{not json')
    expect(readUsageStatusText()).toBeUndefined()
  })

  test('watcher reports the current text and later changes', async () => {
    const seen: (string | undefined)[] = []
    writeUsageStatus(account({ usedCount: 10 }))
    const stop = watchUsageStatus((text) => seen.push(text), 20)
    try {
      expect(seen).toEqual(['Usage: 10/1000 (1%)'])
      await Bun.sleep(30)
      writeUsageStatus(account({ usedCount: 20 }))
      await Bun.sleep(80)
      expect(seen.at(-1)).toBe('Usage: 20/1000 (2%)')
      rmSync(getUsageStatusPath())
      await Bun.sleep(80)
      expect(seen.at(-1)).toBeUndefined()
    } finally {
      stop()
    }
  })
})

describe('usage_in_status_bar config', () => {
  test('defaults to false', () => {
    expect(DEFAULT_CONFIG.usage_in_status_bar).toBe(false)
    expect(loadConfig(configHome).usage_in_status_bar).toBe(false)
  })

  test('can be enabled in kiro.json or with KIRO_USAGE_IN_STATUS_BAR', () => {
    const userConfig = join(configHome, 'opencode', 'kiro.json')
    loadConfig(configHome) // writes the default template
    const template = JSON.parse(readFileSync(userConfig, 'utf8'))
    writeFileSync(userConfig, JSON.stringify({ ...template, usage_in_status_bar: true }))
    expect(loadConfig(configHome).usage_in_status_bar).toBe(true)

    process.env.KIRO_USAGE_IN_STATUS_BAR = 'false'
    expect(loadConfig(configHome).usage_in_status_bar).toBe(false)
  })
})

describe('AccountSelector high-usage notice', () => {
  function selector(acc: any, usageInStatusBar: boolean) {
    const manager: any = {
      getAccountCount: () => 1,
      getCurrentOrNext: () => acc,
      shouldShowUsageToast: () => true
    }
    return new AccountSelector(
      manager,
      {
        auto_sync_kiro_cli: false,
        account_selection_strategy: 'sticky',
        usage_in_status_bar: usageInStatusBar
      },
      async () => {},
      {} as any
    )
  }

  test('keeps the toast and writes no status file by default', async () => {
    const toasts: string[] = []
    await selector(account(), false).selectHealthyAccount((message) => toasts.push(message))
    expect(toasts).toEqual(['Usage (user@example.com): 950.46/1000 (95%)'])
    expect(existsSync(getUsageStatusPath())).toBe(false)
  })

  test('publishes to the status bar instead of toasting when enabled', async () => {
    const toasts: string[] = []
    await selector(account(), true).selectHealthyAccount((message) => toasts.push(message))
    expect(toasts).toEqual([])
    expect(readUsageStatusText()).toBe('Usage: 950.46/1000 (95%)')
  })
})

describe('AuthHandler startup usage summary', () => {
  function summarize(usageInStatusBar: boolean, accounts: any[]) {
    const handler = new AuthHandler({ usage_in_status_bar: usageInStatusBar }, {} as any)
    handler.setAccountManager({ getAccounts: () => accounts })
    const scheduled: number[] = []
    const realSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((_fn: () => void, ms?: number) => {
      scheduled.push(ms ?? 0)
      return 0
    }) as any
    try {
      ;(handler as any).logUsageSummary(() => {})
    } finally {
      globalThis.setTimeout = realSetTimeout
    }
    return scheduled
  }

  test('schedules the usage toast by default', () => {
    expect(summarize(false, [account()])).toEqual([3000])
    expect(existsSync(getUsageStatusPath())).toBe(false)
  })

  test('skips the toast and publishes the most recently used healthy account', () => {
    const scheduled = summarize(true, [
      account({ id: 'a', email: 'old@example.com', lastUsed: 1, usedCount: 1 }),
      account({ id: 'b', email: 'new@example.com', lastUsed: 2, usedCount: 2 }),
      account({ id: 'c', email: 'sick@example.com', lastUsed: 3, isHealthy: false })
    ])
    expect(scheduled).toEqual([])
    expect(JSON.parse(readFileSync(getUsageStatusPath(), 'utf8')).email).toBe('new@example.com')
  })
})
