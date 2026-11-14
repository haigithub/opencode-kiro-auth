import { createElement, effect, insert, setProp } from '@opentui/solid'
import { createSignal } from 'solid-js'
import { loadConfig } from './plugin/config/loader.js'
import * as logger from './plugin/logger.js'
import { watchUsageStatus } from './plugin/usage-status.js'

/**
 * TUI part of the plugin: shows the current Kiro account's usage in the status bar when
 * `usage_in_status_bar` is enabled. The server part publishes the usage to a status file
 * (see usage-status.ts); this module polls that file and renders the text.
 *
 * One default export serves both OpenCode generations, like the server entry:
 * - OpenCode V1 calls `tui(api)`; the text goes into the `session_prompt_right` slot, at
 *   the right end of the prompt's agent/model row.
 * - OpenCode V2 calls `setup(ctx)`; the text is appended to the `prompt.footer` slot,
 *   after the context usage and the `ctrl+p commands` hint.
 *
 * It is plain TypeScript rather than TSX: OpenCode applies its Solid JSX transform only
 * to plugin files outside node_modules, so a TSX entry would break npm installs. The
 * `solid-js` and `@opentui/solid` imports resolve to the host's own module instances.
 */

// Minimal shapes of the host APIs this module uses.
interface V1Api {
  state: { path: { directory: string } }
  theme: { readonly current: { textMuted: unknown } }
  slots: { register(plugin: { order?: number; slots: Record<string, () => unknown> }): string }
  lifecycle: { onDispose(fn: () => void): () => void }
}

interface V2Context {
  location?: { directory?: string }
  theme: { text: { muted: unknown } }
  ui: {
    slot(claim: { append: string; render: (input: { mode?: string }) => unknown }): () => void
  }
}

function statusBarEnabled(directory: string | undefined): boolean {
  try {
    return loadConfig(directory || process.cwd()).usage_in_status_bar === true
  } catch (error) {
    logger.warn(`Usage status bar disabled: could not load config: ${String(error)}`)
    return false
  }
}

/** A reactive `<text>` node that renders nothing while there is no usage to show. */
function usageText(
  text: () => string | undefined,
  color: () => unknown,
  visible: () => boolean = () => true
): () => unknown {
  return () => {
    const value = text()
    if (!value || !visible()) return null
    const node = createElement('text')
    setProp(node, 'wrapMode', 'none')
    setProp(node, 'flexShrink', 0)
    effect(() => setProp(node, 'fg', color()))
    insert(node, value)
    return node
  }
}

function watchText(): { text: () => string | undefined; stop: () => void } {
  const [text, setText] = createSignal<string | undefined>(undefined)
  const stop = watchUsageStatus((value) => setText(() => value))
  return { text, stop }
}

export default {
  id: 'kiro-usage-status',

  async tui(api: V1Api): Promise<void> {
    if (!statusBarEnabled(api.state.path.directory)) return
    const { text, stop } = watchText()
    api.lifecycle.onDispose(stop)
    api.slots.register({
      order: 100,
      slots: {
        session_prompt_right: () => usageText(text, () => api.theme.current.textMuted)
      }
    })
  },

  setup(ctx: V2Context): (() => void) | void {
    if (!statusBarEnabled(ctx.location?.directory)) return
    const { text, stop } = watchText()
    const off = ctx.ui.slot({
      append: 'prompt.footer',
      // The built-in footer shows only `esc exit shell mode` in shell mode; match that.
      render: (input) =>
        usageText(
          text,
          () => ctx.theme.text.muted,
          () => input.mode !== 'shell'
        )
    })
    return () => {
      off()
      stop()
    }
  }
}
