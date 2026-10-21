// Pure helpers for the Slack connector's text: permalinks, the thread listing slack_read_thread prints,
// Slack mrkdwn → Markdown for drawing, and @Name → <@U…> for sending.

export type ThreadRef = { channelId: string; threadTs: string; workspace: string }

// https://<ws>.slack.com/archives/C123/p1784707347615469[?thread_ts=1784707347.615469&cid=C123]
// A link to a reply carries the thread root in thread_ts; a link to the root has none.
export const parsePermalink = (url: string): ThreadRef | null => {
  const m = url.trim().match(/^https?:\/\/([\w-]+)\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(?:\?(\S*))?$/)
  if (!m) return null
  const [, workspace, channelId, secs, micros, query] = m
  const fromQuery = new URLSearchParams(query ?? '').get('thread_ts')
  const threadTs = fromQuery && /^\d+\.\d+$/.test(fromQuery) ? fromQuery : `${secs}.${micros}`
  return { channelId: channelId ?? '', threadTs, workspace: workspace ?? '' }
}

export const permalinkOf = (ref: ThreadRef) =>
  `https://${ref.workspace}.slack.com/archives/${ref.channelId}/p${ref.threadTs.replace('.', '')}`

export type Message = {
  ts: string
  userId: string
  userName: string
  time: string
  text: string
  reactions: string
  files: string
  isParent: boolean
}

const HEADER = /^(=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)$/

// slack_read_thread prints one block per message: a header, From / Time / Message TS lines, the text, then
// optional Reactions / Files lines. Anything that is not such a block (the replies banner, blanks) is skipped.
export const parseThread = (listing: string): Message[] => {
  const out: Message[] = []
  let current: (Message & { body: string[] }) | null = null
  const close = () => {
    if (current?.ts) out.push({ ...current, text: current.body.join('\n').trim() })
    current = null
  }
  for (const line of listing.split('\n')) {
    const header = line.match(HEADER)
    if (header) {
      close()
      current = {
        ts: '',
        userId: '',
        userName: '',
        time: '',
        text: '',
        reactions: '',
        files: '',
        isParent: line.startsWith('==='),
        body: [],
      }
      continue
    }
    if (line.startsWith('=== ')) {
      close()
      continue
    }
    if (!current) continue
    const from = !current.ts && line.match(/^From: (.*?) (?:<[^>]*> )?\((U[A-Z0-9]+|B[A-Z0-9]+)\)\s*$/)
    if (from) {
      current.userName = from[1] ?? ''
      current.userId = from[2] ?? ''
      continue
    }
    const time = !current.ts && line.match(/^Time: (.+)$/)
    if (time) {
      current.time = time[1] ?? ''
      continue
    }
    const ts = !current.ts && line.match(/^Message TS: (\d+\.\d+)\s*$/)
    if (ts) {
      current.ts = ts[1] ?? ''
      continue
    }
    if (current.ts && line.startsWith('Reactions: ')) {
      current.reactions = line.slice('Reactions: '.length)
      continue
    }
    if (current.ts && line.startsWith('Files: ')) {
      current.files = line.slice('Files: '.length)
      continue
    }
    if (current.ts) current.body.push(line)
  }
  close()
  return out
}

// The next-page cursor slack_read_thread mentions in its pagination text, if any.
export const nextCursor = (pagination: string | undefined) => pagination?.match(/cursor: `([^`]+)`/)?.[1]

const decodeEntities = (text: string) => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Slack's own markup, resolved for reading: people and groups by name, channels by name, links with their label.
const resolveSlack = (text: string, link: (url: string, label: string) => string) =>
  text
    .replace(/<@([UW][A-Z0-9]+)\|([^>]+)>/g, '@$2')
    .replace(/<@([UW][A-Z0-9]+)>/g, '@$1')
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, '$1')
    .replace(/<!subteam\^[A-Z0-9]+>/g, '@nhóm')
    .replace(/<#([CG][A-Z0-9]+)\|([^>]*)>/g, '#$2')
    .replace(/<!(here|channel|everyone)>/g, '@$1')
    .replace(/<((?:https?|mailto|tel):[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) => link(url, label))
    .replace(/<((?:https?|mailto|tel):[^>]+)>/g, (_, url: string) => link(url, url.replace(/^mailto:/, '')))

// Slack mrkdwn for drawing as Markdown, line for line as Slack shows it: *bold*, ~strike~, and every single line
// break kept (Markdown would fold one into a space). Fenced code is left as written.
export const slackToMarkdown = (text: string) => {
  let isCode = false
  const lines = resolveSlack(text, (url, label) => `[${label}](${url})`)
    .split('\n')
    .map(line => {
      const isFence = line.trim().startsWith('```')
      const inCode = isCode || isFence
      if (isFence) isCode = !isCode
      if (inCode) return { line, inCode }
      return {
        line: decodeEntities(
          line
            .replace(/(^|[\s(（「])\*([^*\n]+?)\*(?=$|[\s.,:;!?)）」、。])/g, '$1**$2**')
            .replace(/(^|[\s(（「])~([^~\n]+?)~(?=$|[\s.,:;!?)）」、。])/g, '$1~~$2~~'),
        ),
        inCode,
      }
    })
  // A hard break ("  " before the newline) between two non-empty prose lines; code keeps its own lines.
  return lines
    .map((cur, i) => {
      const next = lines[i + 1]
      return !cur.inCode && next && !next.inCode && cur.line.trim() && next.line.trim() ? `${cur.line}  ` : cur.line
    })
    .join('\n')
}

// A message as plain text, for the clipboard: names instead of ids, a link as "label (url)" unless they match.
export const slackToPlain = (text: string) =>
  decodeEntities(
    resolveSlack(text, (url, label) => {
      const bare = url.replace(/^mailto:/, '')
      return label === url || label === bare ? bare : `${label} (${bare})`
    }),
  )

export type Reaction = { name: string; count: number }

// "eyes (1), gratitude-thank-you (2), +1::skin-tone-2 (1)": a skin tone rides on the name after "::".
export const parseReactions = (line: string): Reaction[] =>
  [...line.matchAll(/([\w+\-':]+) \((\d+)\)/g)].map(m => ({ name: m[1] ?? '', count: Number(m[2]) }))

export type FileRef = { name: string; id: string; type: string; size: string }

// "plan.pdf (ID: F0BK3666S12, application/pdf, 810.4 KB), notes.txt (ID: F02, text/plain, 1 KB)"
export const parseFiles = (line: string): FileRef[] =>
  [...line.matchAll(/\s*,?\s*(.+?) \(ID: (F[A-Z0-9]+), ([^,]+), ([^)]+)\)/g)].map(m => ({
    name: (m[1] ?? '').trim(),
    id: m[2] ?? '',
    type: m[3] ?? '',
    size: m[4] ?? '',
  }))

// The common reaction names as emoji; anything else (a workspace's custom emoji) shows by its :name:.
const EMOJI: Record<string, string> = {
  '+1': '👍',
  thumbsup: '👍',
  '-1': '👎',
  eyes: '👀',
  bow: '🙇',
  pray: '🙏',
  white_check_mark: '✅',
  heavy_check_mark: '✔️',
  heart: '❤️',
  tada: '🎉',
  raised_hands: '🙌',
  ok_hand: '👌',
  fire: '🔥',
  joy: '😂',
  smile: '😄',
  slightly_smiling_face: '🙂',
  thinking_face: '🤔',
  clap: '👏',
  rocket: '🚀',
  muscle: '💪',
  sweat_smile: '😅',
  wave: '👋',
  100: '💯',
  x: '❌',
  warning: '⚠️',
  memo: '📝',
  'man-bowing': '🙇‍♂️',
  'man-raising-hand': '🙋‍♂️',
  'woman-raising-hand': '🙋‍♀️',
  raising_hand: '🙋',
  sob: '😭',
  star: '⭐',
}
const SKIN_TONES: Record<string, string> = {
  'skin-tone-2': '\u{1F3FB}',
  'skin-tone-3': '\u{1F3FC}',
  'skin-tone-4': '\u{1F3FD}',
  'skin-tone-5': '\u{1F3FE}',
  'skin-tone-6': '\u{1F3FF}',
}

// The tone goes right after the first code point, in place of its presentation selector: 🙇 + 🏻 + ‍♂️.
export const emojiOf = (name: string) => {
  const [base = '', tone = ''] = name.split('::')
  const emoji = EMOJI[base]
  if (!emoji) return `:${name}:`
  const modifier = SKIN_TONES[tone]
  if (!modifier) return emoji
  const [first = '', ...rest] = [...emoji]
  return first + modifier + rest.join('').replace(/^\uFE0F/, '')
}

// A link to one message of the thread, as Slack's "Copy link" gives it.
export const messageLink = (ref: ThreadRef, ts: string) =>
  ts === ref.threadTs
    ? permalinkOf(ref)
    : `${permalinkOf({ ...ref, threadTs: ts })}?thread_ts=${ref.threadTs}&cid=${ref.channelId}`

// Before sending: "@Name" of anyone already in the thread becomes a real mention; the longest names go first so
// "@Bob Tran" wins over a "@Bob" that is someone else.
export const applyMentions = (text: string, people: ReadonlyMap<string, string>) => {
  const names = [...people.keys()].sort((a, b) => b.length - a.length)
  let out = text
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(^|[\\s(])@${escaped}(?=$|[\\s.,:;!?)])`, 'g'), `$1<@${people.get(name)}>`)
  }
  return out
}

// "1788913950.005089" → a local "09/09 07:32" (or "07:32" when it is today).
export const shortTime = (ts: string, now = new Date()) => {
  const d = new Date(Number(ts) * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === now.toDateString() ? hm : `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}`
}

// The first line of a message that says something (not only mentions), cleaned, as a thread's default title.
export const titleOf = (text: string) => {
  const first =
    slackToMarkdown(text)
      .split('\n')
      .find(l => l.replace(/@\S+(\s\S+)?/g, '').trim() !== '')
      ?.replace(/\*\*/g, '')
      .trim() ?? ''
  return first.length > 80 ? `${first.slice(0, 79)}…` : first
}
