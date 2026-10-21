export type ThreadsView = 'list' | 'thread' | 'settings'

declare module 'claude-code' {
  interface PluginState {
    'slack-threads': { view: ThreadsView; threadId: string }
  }
}
