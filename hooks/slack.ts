import type { EngineInterface } from 'claude-code'

import type { FileRef, Message, ThreadRef } from './parse'
import { nextCursor, parseThread } from './parse'

// The Slack connector is reached through its MCP tools, so the mod holds no token. Its server name carries an id
// that differs per person, so it is found by its tool's name instead of being written here.
let server: string | null = null
const READ = /^mcp__(.+)__slack_read_thread$/

export async function findServer($: EngineInterface): Promise<string | null> {
  if (server) return server
  const tools = await $.tool.list()
  const hit = tools.map(t => t.name.match(READ)?.[1]).find(Boolean)
  server = hit ?? null
  return server
}

// The tool's own output first: the text meant for the model can be cut or swapped for a file pointer when the
// thread is long, and that text is not the listing.
const outputOf = (result: unknown): string | undefined => {
  if (typeof result === 'string') return result
  const content = Array.isArray(result)
    ? result
    : result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : null
  const text = content
    ?.map(c =>
      c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string'
        ? (c as { text: string }).text
        : '',
    )
    .join('')
  return text || undefined
}

async function call(
  $: EngineInterface,
  tool: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = await findServer($)
  if (!name) throw new Error('Chưa thấy connector Slack trong phiên này (bật Slack ở + → Connectors).')
  const ran = await $.tool.call({ tool: `mcp__${name}__${tool}` as `mcp__${string}__${string}`, ...input })
  if (ran.deny !== undefined) throw new Error(`${tool}: ${ran.deny}`)
  if (ran.isError) throw new Error(`${tool}: ${(ran.text ?? '').slice(0, 300)}`)
  const text = outputOf(ran.result) ?? ran.text ?? ''
  const parsed = parseJson(text)
  if (parsed) return parsed
  // A reply over the model's token budget comes back as a pointer to the file Claude Code saved it to; that file holds
  // the whole reply.
  const saved = text.match(/saved to ((?:[A-Za-z]:)?[\\/][^\s]+?\.(?:txt|json))\b/)?.[1]
  if (saved && (await $.fs.exists(saved))) {
    const whole = await $.fs.read(saved)
    const json = parseJson(whole)
    const inner = Array.isArray(json) ? outputOf(json) : undefined
    if (inner !== undefined) return parseJson(inner) ?? { text: inner }
    return json ?? { text: whole }
  }
  return { text }
}

const parseJson = (text: string) => {
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export type ThreadPage = { messages: Message[]; older?: string }

// One page of a thread: the parent plus the newest `limit` replies (after `since`, when given), oldest first.
// `older` is the cursor to the replies before them. Pages stay small: a long Japanese thread in one reply overflows
// the token budget of a tool result.
export async function readPage(
  $: EngineInterface,
  ref: ThreadRef,
  options: { limit: number; cursor?: string; since?: string },
): Promise<ThreadPage> {
  const res = await call($, 'slack_read_thread', {
    channel_id: ref.channelId,
    message_ts: ref.threadTs,
    limit: options.limit,
    ...(options.since ? { oldest: options.since } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  })
  const listing = String(res.messages ?? res.text ?? '')
  const messages = parseThread(listing)
  // Nothing readable is an answer in another shape: say so instead of waiting on it forever.
  if (messages.length === 0) {
    throw new Error(`connector trả về nội dung không đọc được: ${listing.slice(0, 160).replace(/\s+/g, ' ')}`)
  }
  const older = nextCursor(typeof res.pagination_info === 'string' ? res.pagination_info : undefined)
  return { messages: messages.sort((a, b) => Number(a.ts) - Number(b.ts)), older }
}

// Every reply after `since`, oldest first, for a poll: usually one small page.
export async function readSince($: EngineInterface, ref: ThreadRef, since: string): Promise<Message[]> {
  const byTs = new Map<string, Message>()
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const next = await readPage($, ref, { limit: 10, since, cursor })
    for (const m of next.messages) byTs.set(m.ts, m)
    cursor = next.older
    if (!cursor) break
  }
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts))
}

export async function sendReply($: EngineInterface, ref: ThreadRef, text: string, isBroadcast: boolean) {
  await call($, 'slack_send_message', {
    channel_id: ref.channelId,
    thread_ts: ref.threadTs,
    message: text,
    ...(isBroadcast ? { reply_broadcast: true } : {}),
  })
}

const TEXT_MIME = /^text\/|json|xml|javascript|csv|markdown|yaml/

// What slack_read_file sent: a text file between <file_content_…> tags, a binary one as base64.
const fileBody = (res: Record<string, unknown>, fallbackMime: string) => {
  for (const key of ['base64', 'data', 'content_base64']) {
    const value = res[key]
    if (typeof value === 'string') return { body: value, isBase64: true }
  }
  if (typeof res.content === 'string') return { body: res.content, isBase64: res.encoding === 'base64' }
  const raw = String(res.text ?? '')
  const mime = raw.match(/^MIME Type: (.+)$/m)?.[1]?.trim() || fallbackMime
  const inner =
    raw.match(/<file_content_(\w+)>\n?([\s\S]*?)\n?<\/file_content_\1>/)?.[2] ??
    raw.match(/([A-Za-z0-9+/]{64,}={0,2})\s*$/)?.[1]
  if (inner === undefined) throw new Error(`connector trả về nội dung file không nhận ra: ${raw.slice(0, 120)}`)
  return { body: inner, isBase64: !TEXT_MIME.test(mime) && /^[A-Za-z0-9+/=\s]+$/.test(inner) }
}

// A name not yet taken in `dir`: "plan.pdf", then "plan (1).pdf", as a browser does.
async function freePath($: EngineInterface, dir: string, name: string): Promise<string> {
  const clean = name.normalize('NFC').replace(/[\\/:*?"<>|]/g, '_') || 'file'
  const dot = clean.lastIndexOf('.')
  const [stem, ext] = dot > 0 ? [clean.slice(0, dot), clean.slice(dot)] : [clean, '']
  for (let i = 0; i < 100; i++) {
    const path = `${dir}/${i ? `${stem} (${i})${ext}` : clean}`
    if (!(await $.fs.exists(path))) return path
  }
  throw new Error(`Downloads đã có quá nhiều file tên ${clean}`)
}

// One attachment into the Downloads folder, returning where it went. Text is written as sent; base64 is decoded by
// the system's own tool, as the mod can write only text. The connector reads files up to 10 MB.
export async function downloadFile($: EngineInterface, file: FileRef): Promise<string> {
  const { body, isBase64 } = fileBody(await call($, 'slack_read_file', { file_id: file.id }), file.type)
  const home = ((await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || '.').replace(/\\/g, '/')
  const path = await freePath($, `${home}/Downloads`, file.name)
  // Written first in either case: this creates the folder when it is missing.
  await $.fs.write(path, isBase64 ? '' : body)
  if (!isBase64) return path
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const argv = isWindows
    ? [
        'powershell',
        '-NoProfile',
        '-Command',
        '[IO.File]::WriteAllBytes($env:SLACK_OUT, [Convert]::FromBase64String([Console]::In.ReadToEnd()))',
      ]
    : ['sh', '-c', 'base64 -d > "$SLACK_OUT"']
  const ran = await $.process.run(argv, {
    stdin: body.replace(/\s+/g, ''),
    env: { SLACK_OUT: path },
    timeoutMs: 60_000,
  })
  if (ran.exitCode !== 0) throw new Error(`không giải mã được file: ${ran.stderr.slice(0, 200)}`)
  return path
}
