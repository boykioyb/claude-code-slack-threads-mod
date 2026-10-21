import type { EngineInterface } from 'claude-code'

import type { ThreadRef } from './parse'

// The followed threads, in one JSON file under ~/.local/share/slack-threads. No shell command is run, so the same
// code works on every platform; $.fs.write creates the folder itself.
export type Thread = ThreadRef & {
  id: string
  title: string
  lastReplyTs: string
  lastSeenTs: string
  replyCount: number
  // Older replies exist that the pane has not loaded, so replyCount is a lower bound.
  hasOlder?: boolean
  addedAt: string
}

let fileCache: string | null = null
let threads: Thread[] | null = null

async function file($: EngineInterface) {
  if (fileCache) return fileCache
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.'
  fileCache = `${home.replace(/\\/g, '/')}/.local/share/slack-threads/threads.json`
  return fileCache
}

export async function loadThreads($: EngineInterface): Promise<Thread[]> {
  if (threads) return threads
  const path = await file($)
  threads = (await $.fs.exists(path))
    ? ((JSON.parse(await $.fs.read(path)) as { threads?: Thread[] }).threads ?? [])
    : []
  return threads
}

export async function saveThreads($: EngineInterface, next: Thread[]) {
  threads = next
  await $.fs.write(await file($), `${JSON.stringify({ threads: next }, null, 2)}\n`)
}

export const threadId = (ref: ThreadRef) => `${ref.channelId}:${ref.threadTs}`

export const isUnread = (t: Thread) => Number(t.lastReplyTs) > Number(t.lastSeenTs)
