// Types for the host modules the TUI entry imports. OpenCode resolves these imports to
// its own runtime instances when it loads the plugin's TUI part, so they are not
// dependencies of this package. Only the members src/tui.ts uses are declared.

declare module 'solid-js' {
  export function createSignal<T>(value: T): [get: () => T, set: (value: T | ((prev: T) => T)) => T]
}

declare module '@opentui/solid' {
  export function createElement(tag: string): unknown
  export function setProp<T>(node: unknown, name: string, value: T): T
  export function insert(parent: unknown, accessor: unknown): unknown
  export function effect(fn: () => void): void
}
