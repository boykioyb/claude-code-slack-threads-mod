import type { EngineInterface } from 'claude-code'

// Finished translations, kept in the mod's own store (one key per thread) so a reload or a new session does not ask
// the model again. Each entry remembers a hash of the text it came from: an edited message misses and is redone.
type Entry = { h: string; text: string }
type ThreadCache = Record<string, Entry>

const INDEX = 'tr-threads' // thread ids, most recently used first
const MAX_THREADS = 20 // the store holds 4 MiB in all; twenty long threads stay well under it
const MAX_PER_THREAD = 400

const loaded = new Map<string, ThreadCache>()
let writing: Promise<unknown> = Promise.resolve()

const storeKey = (threadId: string) => `tr:${threadId}`
const entryKey = (ts: string, profile: string) => `${ts}|${profile}`

export const textHash = (text: string) => {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Writes go one after another, so two translations finishing together cannot overwrite each other's save.
function queue(write: () => Promise<void>) {
  writing = writing.then(write).catch(() => undefined)
  return writing
}

export async function loadCache($: EngineInterface, threadId: string): Promise<void> {
  if (loaded.has(threadId)) return
  const stored = await $.store.get(storeKey(threadId))
  loaded.set(threadId, stored && typeof stored === 'object' ? (stored as ThreadCache) : {})
}

// `profile` names what made the translation (language, model, style): changing any of them misses.
export const cachedTranslation = (threadId: string, ts: string, profile: string, source: string) => {
  const entry = loaded.get(threadId)?.[entryKey(ts, profile)]
  return entry?.h === textHash(source) ? entry.text : undefined
}

export function remember(
  $: EngineInterface,
  threadId: string,
  ts: string,
  profile: string,
  source: string,
  text: string,
) {
  const cache = loaded.get(threadId) ?? {}
  loaded.set(threadId, cache)
  cache[entryKey(ts, profile)] = { h: textHash(source), text }
  const keys = Object.keys(cache)
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PER_THREAD))) delete cache[k]
  return queue(async () => {
    await $.store.set(storeKey(threadId), cache)
    const index = ((await $.store.get(INDEX)) as string[] | undefined) ?? []
    const next = [threadId, ...index.filter(id => id !== threadId)]
    for (const old of next.slice(MAX_THREADS)) {
      loaded.delete(old)
      await $.store.delete(storeKey(old))
    }
    await $.store.set(INDEX, next.slice(0, MAX_THREADS))
  })
}

export function forgetThread($: EngineInterface, threadId: string) {
  loaded.delete(threadId)
  return queue(async () => {
    await $.store.delete(storeKey(threadId))
    const index = ((await $.store.get(INDEX)) as string[] | undefined) ?? []
    await $.store.set(
      INDEX,
      index.filter(id => id !== threadId),
    )
  })
}
