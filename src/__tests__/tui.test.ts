import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// OpenCode supplies these modules at runtime; stand-ins that record what gets rendered.
mock.module('solid-js', () => ({
  createSignal: <T>(value: T) => {
    let current = value
    return [
      () => current,
      (next: T | ((prev: T) => T)) =>
        (current = typeof next === 'function' ? (next as (prev: T) => T)(current) : next)
    ]
  }
}))
mock.module('@opentui/solid', () => ({
  createElement: (tag: string) => ({
    tag,
    props: {} as Record<string, unknown>,
    children: [] as unknown[]
  }),
  setProp: (node: any, name: string, value: unknown) => (node.props[name] = value),
  insert: (node: any, value: unknown) => node.children.push(value),
  effect: (fn: () => void) => fn()
}))

const { default: tuiPlugin } = await import('../tui.js')
const { writeUsageStatus } = await import('../plugin/usage-status.js')

let configHome = ''
let savedXdg: string | undefined

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME
  configHome = mkdtempSync(join(tmpdir(), 'kiro-tui-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
  rmSync(configHome, { recursive: true, force: true })
})

function enable(value: boolean) {
  mkdirSync(join(configHome, 'opencode'), { recursive: true })
  writeFileSync(
    join(configHome, 'opencode', 'kiro.json'),
    JSON.stringify({ usage_in_status_bar: value })
  )
}

function v1Api() {
  const registered: any[] = []
  const disposers: (() => void)[] = []
  const api = {
    state: { path: { directory: configHome } },
    theme: { current: { textMuted: 'muted-v1' } },
    slots: { register: (plugin: any) => (registered.push(plugin), 'id') },
    lifecycle: { onDispose: (fn: () => void) => (disposers.push(fn), () => {}) }
  }
  return { api, registered, disposers }
}

function v2Context() {
  const claims: any[] = []
  const ctx = {
    location: { directory: configHome },
    theme: { text: { muted: 'muted-v2' } },
    ui: { slot: (claim: any) => (claims.push(claim), () => {}) }
  }
  return { ctx, claims }
}

describe('TUI entry', () => {
  test('exports a module both OpenCode generations accept', () => {
    // V1 reads `tui` (and rejects modules that also export `server`); V2 reads `id` + `setup`.
    expect(typeof tuiPlugin.id).toBe('string')
    expect(typeof tuiPlugin.tui).toBe('function')
    expect(typeof tuiPlugin.setup).toBe('function')
    expect('server' in tuiPlugin).toBe(false)
  })

  test('registers nothing while usage_in_status_bar is off', async () => {
    enable(false)
    const v1 = v1Api()
    await tuiPlugin.tui(v1.api)
    expect(v1.registered).toEqual([])
    const v2 = v2Context()
    expect(tuiPlugin.setup(v2.ctx)).toBeUndefined()
    expect(v2.claims).toEqual([])
  })

  test('V1: renders the usage text in session_prompt_right', async () => {
    enable(true)
    writeUsageStatus({ email: 'a@b.c', usedCount: 12.5, limitCount: 1000 })
    const v1 = v1Api()
    await tuiPlugin.tui(v1.api)
    try {
      const slots = v1.registered[0].slots
      expect(Object.keys(slots)).toEqual(['session_prompt_right'])
      const node = (slots.session_prompt_right() as () => any)()
      expect(node).toMatchObject({
        tag: 'text',
        props: { fg: 'muted-v1', wrapMode: 'none', flexShrink: 0 },
        children: ['Usage: 12.5/1000 (1%)']
      })
    } finally {
      v1.disposers.forEach((fn) => fn())
    }
  })

  test('V2: appends to prompt.footer and hides in shell mode', () => {
    enable(true)
    writeUsageStatus({ email: 'a@b.c', usedCount: 12.5, limitCount: 1000 })
    const v2 = v2Context()
    const cleanup = tuiPlugin.setup(v2.ctx)
    try {
      expect(v2.claims).toHaveLength(1)
      const claim = v2.claims[0]
      expect(claim.append).toBe('prompt.footer')
      expect(claim.render({ mode: 'normal' })()).toMatchObject({
        props: { fg: 'muted-v2' },
        children: ['Usage: 12.5/1000 (1%)']
      })
      expect(claim.render({ mode: 'shell' })()).toBeNull()
    } finally {
      cleanup?.()
    }
  })

  test('renders nothing before the server has published usage', () => {
    enable(true)
    const v2 = v2Context()
    const cleanup = tuiPlugin.setup(v2.ctx)
    try {
      expect(v2.claims[0].render({ mode: 'normal' })()).toBeNull()
    } finally {
      cleanup?.()
    }
  })
})
