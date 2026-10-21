import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ThreadsView } from '../types'
import type { FileRef, Message } from './parse'
import {
  applyMentions,
  emojiOf,
  messageLink,
  parseFiles,
  parsePermalink,
  parseReactions,
  permalinkOf,
  shortTime,
  slackToMarkdown,
  slackToPlain,
  titleOf,
} from './parse'
import { cachedTranslation, forgetThread, loadCache, remember } from './cache'
import type { Lang, ModelChoice, Style, TranslateOptions } from './translate'
import { LANGS, MODELS, STYLES, translate } from './translate'
import { downloadFile, findServer, readPage, readSince, sendReply } from './slack'
import type { Thread } from './store'
import { isUnread, loadThreads, saveThreads, threadId } from './store'

const PANE = 'slack-threads'
const TICK_MS = 30_000
const OTHERS_EVERY = 4 // the other threads are checked every 4th tick, about every two minutes
// A thread opens on its newest replies; older ones come a page at a time on request.
const PAGE = 5

const viewAtom = atom({ plugin: 'slack-threads', key: 'view' } as const, 'list' as ThreadsView)
const threadAtom = atom({ plugin: 'slack-threads', key: 'threadId' } as const, '')

// Drawing state: rebuilt after a reload, which only loses unsent drafts and the loaded messages.
const messages = new Map<string, Message[]>()
const drafts = new Map<string, string>()
const broadcast = new Set<string>()
// The cursor to each thread's replies before the loaded ones; absent once the first reply is loaded.
const older = new Map<string, string>()
const loadingOlder = new Set<string>()
let pending: { id: string; text: string } | null = null
let notice: { text: string; tone: 'ok' | 'warn' | 'error' } | null = null
let isBusy = false
let isPaneOpen = false
let ticks = 0
let connector: string | null | undefined
const addForm = { link: '' }
// Translations by "<thread id>|<message ts>|<profile>"; one in flight shows as loading.
const translations = new Map<string, { state: 'loading' | 'done' | 'error'; text: string }>()
// The translation settings, kept in the mod's store so they outlive a reload and a session.
let settings: TranslateOptions = { lang: 'vi', model: 'sonnet', style: 'balanced' }
let isSettingsLoaded = false
const loadSettings = async ($: EngineInterface) => {
  if (isSettingsLoaded) return
  isSettingsLoaded = true
  const stored = (await $.store.get('settings').catch(() => undefined)) as Partial<TranslateOptions> | undefined
  settings = {
    lang: stored?.lang && stored.lang in LANGS ? stored.lang : settings.lang,
    model: stored?.model && stored.model in MODELS ? stored.model : settings.model,
    style: stored?.style && stored.style in STYLES ? stored.style : settings.style,
  }
}
const saveSettings = async ($: EngineInterface, patch: Partial<TranslateOptions>) => {
  settings = { ...settings, ...patch }
  await $.store.set('settings', settings).catch(() => undefined)
  await redraw($)
}
// What made a translation: a change of language, model or style asks for a new one.
const profile = () => `${settings.lang}|${settings.model}|${settings.style}`
// Where the app gives a mod no clipboard (a remote surface), the text is shown here to copy by hand, by key.
const copyBoxes = new Map<string, string>()

const trKey = (threadId: string, ts: string) => `${threadId}|${ts}|${profile()}`

// The AI run log: every step of every translation, with the seconds since the log was started.
const aiLog: { at: number; text: string; tone?: 'error' }[] = []
let aiLogStart = 0
let isLogOpen = false
// One switch for the whole thread: draw every message in its translation, or as written.
let showTranslated = false
let aiRunning = 0
const logStep = ($: EngineInterface, text: string, tone?: 'error') => {
  if (aiLog.length === 0) aiLogStart = Date.now()
  aiLog.push({ at: Date.now() - aiLogStart, text, tone })
  if (aiLog.length > 300) aiLog.splice(0, aiLog.length - 300)
  void redraw($)
}

const translateOne = async ($: EngineInterface, threadId: string, m: Message) => {
  const key = trKey(threadId, m.ts)
  if (translations.get(key)?.state === 'loading') return
  translations.set(key, { state: 'loading', text: '' })
  aiRunning++
  // Runs overlap, so every line names its message: "[Bob Tran 16:00]".
  const tag = `[${m.userName} ${shortTime(m.ts)}]`
  const options = settings
  const made = profile()
  logStep($, `${tag} Dịch sang ${LANGS[options.lang]}`)
  try {
    const text = await translate($, slackToMarkdown(m.text), options, (t, tone) => logStep($, `${tag} ${t}`, tone))
    translations.set(key, { state: 'done', text })
    void remember($, threadId, m.ts, made, m.text, text)
    logStep($, `${tag} Xong · bản dịch ${text.length.toLocaleString('en')} ký tự`)
  } catch (error) {
    translations.set(key, { state: 'error', text: String(error).slice(0, 200) })
    logStep($, `${tag} Lỗi: ${String(error).slice(0, 200)}`, 'error')
  } finally {
    aiRunning--
  }
  await redraw($)
}

// Translate every listed message not yet in the current language, a few at a time (a long thread all at once would
// trip the model's rate limit), logged as one run.
const PARALLEL = 4
const translateMissing = async ($: EngineInterface, threadId: string, list: readonly Message[]) => {
  // A store that cannot be read only costs a fresh translation.
  await loadCache($, threadId).catch(() => undefined)
  const unknown = list.filter(m => !translations.has(trKey(threadId, m.ts)) && m.text.trim())
  const missing = unknown.filter(m => {
    const text = cachedTranslation(threadId, m.ts, profile(), m.text)
    if (text !== undefined) translations.set(trKey(threadId, m.ts), { state: 'done', text })
    return text === undefined
  })
  if (missing.length < unknown.length) {
    logStep($, `Lấy ${unknown.length - missing.length} tin từ bản dịch đã lưu, không gọi model`)
  }
  if (missing.length === 0) return
  const startedAt = Date.now()
  logStep(
    $,
    `Bắt đầu dịch ${missing.length} tin sang ${LANGS[settings.lang]}, ${Math.min(PARALLEL, missing.length)} tin cùng lúc`,
  )
  const queue = [...missing]
  let isStopped = false
  const worker = async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      if (!showTranslated) {
        if (!isStopped) logStep($, 'Dừng: đã chuyển về bản gốc, các tin còn lại không dịch nữa')
        isStopped = true
        return
      }
      await translateOne($, threadId, m)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, missing.length) }, worker))
  if (isStopped) return
  const failed = missing.filter(m => translations.get(trKey(threadId, m.ts))?.state === 'error').length
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  logStep(
    $,
    failed
      ? `Xong sau ${seconds}s: dịch được ${missing.length - failed}/${missing.length} tin, ${failed} tin lỗi (đang hiện bản gốc)`
      : `Xong sau ${seconds}s: dịch được ${missing.length}/${missing.length} tin`,
    failed ? 'error' : undefined,
  )
}

// Copy through the app's clipboard; where it cannot (a remote surface has no clipboard path yet), show the text in
// a box under the message so it can be selected and copied by hand.
const copy = async ($: EngineInterface, key: string, text: string, what: string) => {
  const done = await $.ui.copy({ text }).catch(() => ({ isCopied: false as const }))
  if (done.isCopied) {
    copyBoxes.delete(key)
    return say($, `Đã copy ${what}.`)
  }
  copyBoxes.set(key, text)
  say($, `App chưa cho mod ghi clipboard ở đây: ${what} hiện trong khung bên dưới để bôi đen rồi copy.`, 'warn')
}

// A full-width 1px hairline for rows and section heads on desktop; its colour follows light / dark.
const RULE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4000" height="1" viewBox="0 0 4000 1" preserveAspectRatio="none">' +
  '<style>rect{fill:#d0d7de}@media (prefers-color-scheme: dark){rect{fill:#30363d}}</style>' +
  '<rect width="4000" height="1"/></svg>'

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const say = ($: EngineInterface, text: string, tone: 'ok' | 'warn' | 'error' = 'ok') => {
  notice = { text, tone }
  void redraw($)
}

const currentThread = async ($: EngineInterface) => {
  const id = await read($, threadAtom)
  return (await loadThreads($)).find(t => t.id === id) ?? null
}

// Reload one thread's messages; while it is the one on screen, reading it also marks it read. A poll reads only what
// came after the last message it knows; `isFull` (opening, Làm mới) reads the newest page again, edits and reactions
// included, and keeps any older replies already loaded.
const refreshThread = async ($: EngineInterface, thread: Thread, isOnScreen: boolean, isFull = false) => {
  const known = messages.get(thread.id)
  const since = isFull ? undefined : (known?.at(-1)?.ts ?? (isOnScreen ? undefined : thread.lastReplyTs || undefined))
  let fresh: Message[]
  if (since) fresh = await readSince($, thread, since)
  else {
    const page = await readPage($, thread, { limit: PAGE })
    fresh = page.messages
    if (!known) setOlder(thread.id, page.older)
  }
  const list = known ? mergeByTs(known, fresh) : since ? undefined : fresh
  if (list) messages.set(thread.id, list)
  const newer = since ? fresh.filter(m => Number(m.ts) > Number(since)).length : 0
  const last = (list ?? fresh).at(-1)
  const threads = await loadThreads($)
  await saveThreads(
    $,
    threads.map(t =>
      t.id !== thread.id
        ? t
        : {
            ...t,
            title: t.title || titleOf((list ?? fresh)[0]?.text ?? ''),
            replyCount: list ? Math.max(t.replyCount, list.length - 1) : t.replyCount + newer,
            hasOlder: list ? older.has(t.id) : t.hasOlder,
            lastReplyTs: last?.ts ?? t.lastReplyTs,
            lastSeenTs: isOnScreen ? (last?.ts ?? t.lastSeenTs) : t.lastSeenTs,
          },
    ),
  )
}

const setOlder = (id: string, cursor: string | undefined) => {
  if (cursor) older.set(id, cursor)
  else older.delete(id)
}

// The page of replies before the loaded ones, merged in above them.
const loadOlder = async ($: EngineInterface, thread: Thread) => {
  const cursor = older.get(thread.id)
  if (!cursor || loadingOlder.has(thread.id)) return
  loadingOlder.add(thread.id)
  await redraw($)
  try {
    const page = await readPage($, thread, { limit: PAGE, cursor })
    messages.set(thread.id, mergeByTs(messages.get(thread.id) ?? [], page.messages))
    setOlder(thread.id, page.older)
    if (!page.older) {
      const threads = await loadThreads($)
      await saveThreads(
        $,
        threads.map(t => (t.id === thread.id ? { ...t, hasOlder: false } : t)),
      )
    }
    if (showTranslated) void translateMissing($, thread.id, page.messages)
  } catch (error) {
    say($, `Không tải được tin cũ hơn: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    loadingOlder.delete(thread.id)
  }
  await redraw($)
}

// Where the settings view goes back to.
let settingsFrom: ThreadsView = 'list'
const openSettings = async ($: EngineInterface) => {
  settingsFrom = await read($, viewAtom)
  await update($, viewAtom, () => 'settings')
  await redraw($)
}
const closeSettings = async ($: EngineInterface) => {
  await update($, viewAtom, () => settingsFrom)
  await redraw($)
  // A new model or style asks for new translations of the thread on screen.
  const open = settingsFrom === 'thread' ? await currentThread($) : null
  if (open && showTranslated) void translateMissing($, open.id, messages.get(open.id) ?? [])
}

// The thread whose title is being edited, if any. An empty title goes back to the one taken from the parent.
let renaming: string | null = null
const renameThread = async ($: EngineInterface, thread: Thread, title: string) => {
  const parent = messages.get(thread.id)?.find(m => m.isParent)
  const next = title.trim() || titleOf(parent?.text ?? '')
  const threads = await loadThreads($)
  await saveThreads(
    $,
    threads.map(t => (t.id === thread.id ? { ...t, title: next } : t)),
  )
  renaming = null
  say($, title.trim() ? 'Đã đổi tên thread.' : 'Đã trả về tên lấy từ tin gốc.')
}

const downloading = new Set<string>()
const download = async ($: EngineInterface, file: FileRef) => {
  if (downloading.has(file.id)) return
  downloading.add(file.id)
  await redraw($)
  try {
    say($, `Đã tải ${file.name} về ${await downloadFile($, file)}.`)
  } catch (error) {
    const text = String(error)
    say(
      $,
      /file_too_large/.test(text)
        ? `${file.name} lớn hơn 10 MB, connector không tải được: mở trong Slack để tải.`
        : `Không tải được ${file.name}: ${text.slice(0, 300)}`,
      'error',
    )
  } finally {
    downloading.delete(file.id)
  }
  await redraw($)
}

const mergeByTs = (known: readonly Message[], fresh: readonly Message[]) =>
  [...new Map([...known, ...fresh].map(m => [m.ts, m] as const)).values()].sort((a, b) => Number(a.ts) - Number(b.ts))

// The open thread's load, one at a time; a failure is kept to show in place of "Đang tải…" until the next try.
const loading = new Set<string>()
const loadErrors = new Map<string, string>()
const loadThread = async ($: EngineInterface, thread: Thread, isFull = false) => {
  if (loading.has(thread.id)) return
  loading.add(thread.id)
  try {
    await refreshThread($, thread, true, isFull)
    loadErrors.delete(thread.id)
  } catch (error) {
    loadErrors.set(
      thread.id,
      String(error)
        .replace(/^Error: /, '')
        .slice(0, 300),
    )
  } finally {
    loading.delete(thread.id)
  }
  await redraw($)
}

const addThread = async ($: EngineInterface, link: string) => {
  const ref = parsePermalink(link)
  if (!ref)
    return say($, 'Không đọc được link. Dán permalink của một tin trong thread (Copy link trong Slack).', 'warn')
  const threads = await loadThreads($)
  const id = threadId(ref)
  if (threads.some(t => t.id === id)) return say($, 'Thread này đã có trong danh sách.', 'warn')
  const thread: Thread = {
    ...ref,
    id,
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: new Date().toISOString(),
  }
  await saveThreads($, [thread, ...threads])
  addForm.link = ''
  try {
    await refreshThread($, thread, false)
    say($, 'Đã thêm thread.')
  } catch (error) {
    say($, `Đã thêm, nhưng chưa đọc được thread: ${String(error).slice(0, 300)}`, 'error')
  }
}

const openThread = async ($: EngineInterface, id: string) => {
  await update($, threadAtom, () => id)
  await update($, viewAtom, () => 'thread')
  pending = null
  notice = null
  await redraw($)
  const thread = await currentThread($)
  if (!thread) return
  loadErrors.delete(thread.id)
  await loadThread($, thread, true)
  void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

const send = async ($: EngineInterface) => {
  const thread = await currentThread($)
  if (!thread || !pending || pending.id !== thread.id) return
  isBusy = true
  await redraw($)
  try {
    await sendReply($, thread, pending.text, broadcast.has(thread.id))
    drafts.delete(thread.id)
    pending = null
    await refreshThread($, thread, true)
    say($, 'Đã gửi trả lời.')
    void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
  } catch (error) {
    say($, `Gửi lỗi: ${String(error).slice(0, 300)}`, 'error')
  } finally {
    isBusy = false
    await redraw($)
  }
}

// Every tick: the open thread; every few ticks, a handful of the others for their unread mark.
const tick = async ($: EngineInterface) => {
  if (!isPaneOpen || isBusy) return
  ticks++
  const view = await read($, viewAtom)
  const open = view === 'thread' ? await currentThread($) : null
  try {
    if (open) {
      await loadThread($, open)
      if (showTranslated) void translateMissing($, open.id, messages.get(open.id) ?? [])
    }
    if (ticks % OTHERS_EVERY === 0) {
      const others = (await loadThreads($)).filter(t => t.id !== open?.id).slice(0, 3)
      for (const t of others) await refreshThread($, t, false)
    }
    await redraw($)
  } catch {
    // A failed poll is retried on the next tick; the pane shows what it last read.
  }
}

// --- the model's tools: read the open thread, draft a reply into the composer (never send) ---

const TOOLS = [
  {
    name: 'slack_thread_read',
    description:
      'Read the Slack thread open in the Slack threads panel: its title, link, and every message with author and time.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slack_thread_draft',
    description:
      'Put a reply draft into the composer of the Slack thread open in the panel. It is NOT sent: the user reviews it ' +
      'and sends it from the panel. Write @Full Name for people already in the thread; the panel turns those into mentions.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
] as const

const answer = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return { result: text, text }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'slack-threads', description: 'Mở panel theo dõi và trả lời thread Slack' })
    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    $.clock.every(TICK_MS, () => void tick($))
    return next(e)
  })

  on('command.run', { command: 'slack-threads' }, async $ => {
    try {
      await $.ui.open({ id: PANE, title: 'Slack threads' })
      isPaneOpen = true
      return { text: 'Đã mở panel Slack threads.' }
    } catch (error) {
      return { text: `Không mở được panel Slack threads: ${String(error).slice(0, 400)}` }
    }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__slack-threads__slack_thread_read' }, async $ => {
    const thread = await currentThread($)
    if (!thread) return answer('Chưa mở thread nào trong panel Slack threads.')
    const list = messages.get(thread.id) ?? (await readPage($, thread, { limit: PAGE })).messages
    return answer({
      title: thread.title,
      link: permalinkOf(thread),
      // The model reads what the pane has loaded; it says so when older replies are still behind the button.
      hasOlderReplies: older.has(thread.id),
      messages: list.map(m => ({ from: m.userName, time: m.time, text: slackToMarkdown(m.text) })),
    })
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'slack-threads: slack_thread_read failed' }))

  on('tool.call', { tool: 'mcp__slack-threads__slack_thread_draft' }, async ($, e) => {
    const thread = await currentThread($)
    if (!thread) return answer('Chưa mở thread nào trong panel Slack threads.')
    drafts.set(thread.id, String((e as { text?: string }).text ?? ''))
    pending = null
    await redraw($)
    return answer('Đã điền nháp vào ô trả lời; người dùng sẽ xem lại và tự gửi.')
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'slack-threads: slack_thread_draft failed' }))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    isPaneOpen = true
    if (e.surface === 'mobile') {
      const { Text } = $.ui.resolve(e)
      return <Text dimColor>Panel Slack threads cần ô nhập: mở trên Claude Desktop hoặc terminal.</Text>
    }
    const elements = $.ui.resolve(e)
    const { Box, Input, Markdown, Link, Code, Select } = elements

    // --- the same building blocks and rules as the log-time pane ---
    // Terminal: every run names a theme colour (`text` / `inactive`), the current choice is the accented button.
    // Desktop: the app's outline buttons only, hairline rules drawn as SVG.
    const isTerminal = e.surface === 'terminal'
    const BaseText = elements.Text
    const BaseButton = elements.Button
    const Svg = !isTerminal && 'Svg' in elements ? elements.Svg : null
    const Text = (props: Parameters<typeof BaseText>[0]) => {
      if (!isTerminal) return BaseText(props)
      const isSecondary = props.color === 'subtle' || (props.dimColor === true && props.color === undefined)
      return BaseText({ ...props, color: isSecondary ? 'inactive' : (props.color ?? 'text'), dimColor: false })
    }
    const Button = (props: Parameters<typeof BaseButton>[0]) => {
      if (!isTerminal) return BaseButton(props)
      const label = props.label
      return BaseButton({
        ...props,
        dimColor: false,
        ...(props.variant !== 'primary' && label ? { children: BaseText({ color: 'text', children: label }) } : {}),
      })
    }
    const Act = (props: { k: string; label: string; active?: boolean; dim?: boolean; onPress: () => void }) => (
      <Button
        key={props.k}
        variant={props.active ? 'primary' : 'secondary'}
        dimColor={props.dim}
        label={props.label}
        onPress={props.onPress}
      />
    )
    const Spacer = () => <Box flexGrow={1} />
    const columns = e.viewport?.columns ?? 80
    const Divider = () =>
      Svg ? (
        <Svg source={RULE} alt="─" height={1} />
      ) : (
        <Text dimColor wrap="truncate">
          {'─'.repeat(Math.max(10, Math.min(200, columns - 8)))}
        </Text>
      )
    // A block: title, one line saying what it is for, a rule, then its content.
    const Section = (props: { title: string; hint?: string; aside?: RenderChildren; children: RenderChildren }) => (
      <Box flexDirection="column" gap={1} borderStyle="round" paddingX={2} paddingY={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
            <Text weight="semibold">{props.title}</Text>
            {props.hint && (
              <Text size="footnote" color="subtle">
                {props.hint}
              </Text>
            )}
          </Box>
          {props.aside}
        </Box>
        <Divider />
        {props.children}
      </Box>
    )
    const toneColor = (tone: 'ok' | 'warn' | 'error') =>
      tone === 'error' ? 'error' : tone === 'warn' ? 'warning' : 'success'
    const noticeBanner = notice && (
      <Box
        flexDirection="row"
        gap={1}
        alignItems="center"
        borderStyle="round"
        borderColor={toneColor(notice.tone)}
        paddingX={2}
      >
        <Box flexGrow={1} flexShrink={1}>
          <Text color={toneColor(notice.tone)}>{notice.text}</Text>
        </Box>
        <Act
          k="notice-close"
          label="Đóng"
          onPress={() => {
            notice = null
            void redraw($)
          }}
        />
      </Box>
    )

    connector ??= await findServer($).catch(() => null)
    const threads = await loadThreads($)
    const view = await read($, viewAtom)
    const thread = view === 'thread' ? await currentThread($) : null
    const connectorLine = !connector && (
      <Box borderStyle="round" borderColor="warning" paddingX={2}>
        <Text color="warning">
          Chưa thấy connector Slack trong phiên này: bật Slack ở + → Connectors rồi mở lại panel.
        </Text>
      </Box>
    )

    await loadSettings($)
    const SettingsButton = () => <Act k="open-settings" label="Cài đặt" onPress={() => void openSettings($)} />

    // --- settings: model, style and language of the translations ---

    if (view === 'settings') {
      // One choice as a card: its name and what it is for, the chosen one outlined in the accent colour.
      const Option = (props: { k: string; title: string; hint: string; isOn: boolean; onPick: () => void }) => (
        <Box
          flexDirection="row"
          gap={2}
          alignItems="center"
          borderStyle="round"
          borderColor={props.isOn ? 'claude' : undefined}
          paddingX={2}
          paddingY={1}
        >
          <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
            <Text weight="semibold">{props.title}</Text>
            <Text size="footnote" color="subtle">
              {props.hint}
            </Text>
          </Box>
          <Act k={props.k} label={props.isOn ? 'Đang dùng' : 'Chọn'} active={props.isOn} onPress={props.onPick} />
        </Box>
      )
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Act
              k="settings-back"
              label={settingsFrom === 'thread' ? '‹ Thread' : '‹ Danh sách'}
              onPress={() => void closeSettings($)}
            />
            <Spacer />
          </Box>
          <Box flexDirection="column" gap={0}>
            <Text size="heading" weight="semibold">
              Cài đặt dịch
            </Text>
            <Text size="footnote" color="subtle">
              Lưu ngay khi chọn. Bản dịch đã có được giữ theo từng cách cài: chọn lại cách cũ thì dùng lại, không gọi
              model.
            </Text>
          </Box>
          <Section title="Model" hint="Model AI dùng cho mọi bản dịch.">
            <Box flexDirection="column" gap={1}>
              {(Object.keys(MODELS) as ModelChoice[]).map(k => (
                <Option
                  k={`model-${k}`}
                  title={MODELS[k].label}
                  hint={MODELS[k].hint}
                  isOn={settings.model === k}
                  onPick={() => void saveSettings($, { model: k })}
                />
              ))}
            </Box>
          </Section>
          <Section title="Phong cách dịch" hint="Áp dụng cho các bản dịch do AI tạo ra.">
            <Box flexDirection="column" gap={1}>
              {(Object.keys(STYLES) as Style[]).map(k => (
                <Option
                  k={`style-${k}`}
                  title={STYLES[k].label}
                  hint={STYLES[k].hint}
                  isOn={settings.style === k}
                  onPick={() => void saveSettings($, { style: k })}
                />
              ))}
            </Box>
          </Section>
          <Section title="Dịch sang" hint="Ngôn ngữ của bản dịch; đổi được cả ở đầu mỗi thread.">
            <Box flexDirection="column" gap={1}>
              {(Object.keys(LANGS) as Lang[]).map(k => (
                <Option
                  k={`lang-${k}`}
                  title={LANGS[k]}
                  hint={k === 'vi' ? 'Mặc định.' : `Bản dịch viết bằng ${LANGS[k]}.`}
                  isOn={settings.lang === k}
                  onPick={() => void saveSettings($, { lang: k })}
                />
              ))}
            </Box>
          </Section>
        </Box>
      )
    }

    // --- one thread ---

    if (thread) {
      const list = messages.get(thread.id) ?? []
      const visible = list
      const loadError = loadErrors.get(thread.id)
      // After a reload the pane comes back on this thread with nothing loaded: start the load here, not on the timer.
      if (!messages.has(thread.id) && !loading.has(thread.id) && !loadError) void loadThread($, thread)
      const people = new Map(list.map(m => [m.userName, m.userId] as const).filter(([name, id]) => name && id))
      const draft = drafts.get(thread.id) ?? ''
      const isBroadcast = broadcast.has(thread.id)
      const CopyBox = (props: { k: string }) => {
        const text = copyBoxes.get(props.k)
        if (text === undefined) return null
        return (
          <Box flexDirection="column" gap={0}>
            <Box flexDirection="row" alignItems="center">
              <Text size="footnote" color="subtle">
                Bôi đen rồi copy:
              </Text>
              <Spacer />
              <Act
                k={`close-${props.k}`}
                label="Đóng"
                dim
                onPress={() => {
                  copyBoxes.delete(props.k)
                  void redraw($)
                }}
              />
            </Box>
            <Code source={text} />
          </Box>
        )
      }
      const header = (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={1} alignItems="center">
            <Act
              k="back"
              label="‹ Danh sách"
              onPress={() => void update($, viewAtom, () => 'list').then(() => redraw($))}
            />
            <Spacer />
            <SettingsButton />
            <Act
              k="ai-log"
              label={aiRunning ? `Nhật ký AI · đang chạy` : `Nhật ký AI${aiLog.length ? ` (${aiLog.length})` : ''}`}
              active={isLogOpen}
              onPress={() => {
                isLogOpen = !isLogOpen
                void redraw($)
              }}
            />
            <Box flexDirection="row" gap={0}>
              <Act
                k="mode-original"
                label="Bản gốc"
                active={!showTranslated}
                onPress={() => {
                  showTranslated = false
                  void redraw($)
                }}
              />
              <Act
                k="mode-translated"
                label="Bản dịch"
                active={showTranslated}
                onPress={() => {
                  showTranslated = true
                  void redraw($)
                  void translateMissing($, thread.id, visible)
                }}
              />
            </Box>
            <Act
              k="copy-thread-link"
              label="Copy link thread"
              onPress={() => void copy($, 'thread-link', permalinkOf(thread), 'link thread')}
            />
            <Act
              k="refresh"
              label={isBusy || loading.has(thread.id) ? 'Đang tải…' : 'Làm mới'}
              onPress={() => void openThread($, thread.id)}
            />
          </Box>
          <Box flexDirection="row" gap={2} alignItems="center">
            <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
              {renaming === thread.id ? (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Box flexGrow={1} flexShrink={1}>
                    <Input
                      key={`title-${thread.id}`}
                      placeholder="Để trống để lấy lại tên từ tin gốc"
                      value={thread.title}
                      submitLabel="Lưu"
                      autoFocus
                      onSubmit={v => void renameThread($, thread, v)}
                    />
                  </Box>
                  <Act
                    k="rename-cancel"
                    label="Huỷ"
                    onPress={() => {
                      renaming = null
                      void redraw($)
                    }}
                  />
                </Box>
              ) : (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Box flexShrink={1}>
                    <Text size="heading" weight="semibold" wrap="truncate-end">
                      {thread.title || 'Thread'}
                    </Text>
                  </Box>
                  <Act
                    k="rename"
                    label="Đổi tên"
                    onPress={() => {
                      renaming = thread.id
                      void redraw($)
                    }}
                  />
                </Box>
              )}
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text size="footnote" color="subtle">
                  {list.length
                    ? `${Math.max(0, list.length - 1)}${older.has(thread.id) ? '+' : ''} trả lời · cập nhật ${shortTime(list[list.length - 1]?.ts ?? thread.lastReplyTs)} ·`
                    : loadError
                      ? 'Chưa đọc được ·'
                      : 'Đang tải… ·'}
                </Text>
                <Link href={permalinkOf(thread)} label="Mở trong Slack ↗" />
              </Box>
            </Box>
            <Select
              key="lang"
              label="Dịch sang"
              value={settings.lang}
              options={(Object.keys(LANGS) as Lang[]).map(l => ({ value: l, label: LANGS[l] }))}
              onSelect={v => {
                void saveSettings($, { lang: v as Lang }).then(() => {
                  if (showTranslated) void translateMissing($, thread.id, visible)
                })
              }}
            />
          </Box>
          {list.length === 0 && loadError && (
            <Box flexDirection="column" borderStyle="round" borderColor="error" paddingX={2} paddingY={1}>
              <Text color="error">Không đọc được thread: {loadError}</Text>
              <Text size="footnote" color="subtle">
                Bấm Làm mới để thử lại.
              </Text>
            </Box>
          )}
          <CopyBox k="thread-link" />
          {isLogOpen && (
            <Section
              title="Nhật ký AI"
              hint={`Từng bước của các lần dịch (${MODELS[settings.model].label}, ${STYLES[settings.style].label}), giây tính từ bước đầu tiên.`}
              aside={
                aiLog.length > 0 && (
                  <Act
                    k="ai-log-clear"
                    label="Xoá nhật ký"
                    dim
                    onPress={() => {
                      aiLog.length = 0
                      void redraw($)
                    }}
                  />
                )
              }
            >
              {aiLog.length === 0 ? (
                <Text dimColor>Chưa có lần dịch nào. Bấm Bản dịch để dịch cả thread.</Text>
              ) : (
                <Box flexDirection="column" gap={0}>
                  {aiLog.map(entry => (
                    <Box flexDirection="row" gap={1}>
                      <Box width={8} flexShrink={0}>
                        <Text size="footnote" mono tabular color="subtle">
                          {`${(entry.at / 1000).toFixed(1)}s`}
                        </Text>
                      </Box>
                      <Box flexShrink={1}>
                        <Text size="footnote" mono color={entry.tone}>
                          {entry.text}
                        </Text>
                      </Box>
                    </Box>
                  ))}
                  {aiRunning > 0 && (
                    <Text size="footnote" mono color="claude">
                      …
                    </Text>
                  )}
                </Box>
              )}
            </Section>
          )}
        </Box>
      )

      const messageCard = (m: Message) => {
        const tr = translations.get(trKey(thread.id, m.ts))
        const isShowingTranslation = showTranslated && tr?.state === 'done'
        const files = m.files ? parseFiles(m.files) : []
        const reactions = m.reactions ? parseReactions(m.reactions) : []
        return (
          <Box
            flexDirection="column"
            gap={1}
            borderStyle="round"
            borderColor={m.isParent ? 'claude' : undefined}
            paddingX={2}
            paddingY={1}
          >
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text weight="semibold">{m.userName}</Text>
              <Text size="footnote" color="subtle" tabular>
                {shortTime(m.ts)}
              </Text>
              {m.isParent && (
                <Text size="footnote" color="claude">
                  · Tin gốc
                </Text>
              )}
              {isShowingTranslation && (
                <Text size="footnote" color="subtle">
                  · đã dịch
                </Text>
              )}
              <Spacer />
              <Box flexDirection="row" gap={1} flexShrink={0}>
                <Act
                  k={`copy-${m.ts}`}
                  label="Copy"
                  dim
                  onPress={() =>
                    void copy(
                      $,
                      `orig-${m.ts}`,
                      isShowingTranslation && tr ? tr.text : slackToPlain(m.text),
                      isShowingTranslation ? 'bản dịch' : 'tin nhắn',
                    )
                  }
                />
                <Act
                  k={`link-${m.ts}`}
                  label="Copy link"
                  dim
                  onPress={() => void copy($, `link-${m.ts}`, messageLink(thread, m.ts), 'link tin nhắn')}
                />
              </Box>
            </Box>
            {showTranslated && tr?.state !== 'done' && (
              <Text size="footnote" color={tr?.state === 'error' ? 'error' : 'subtle'}>
                {tr?.state === 'error' ? `Dịch lỗi, đang hiện bản gốc: ${tr.text}` : 'Đang dịch… (đang hiện bản gốc)'}
              </Text>
            )}
            <Markdown text={(isShowingTranslation && tr ? tr.text : slackToMarkdown(m.text)) || ' '} />
            {files.length > 0 && (
              <Box flexDirection="column" gap={1}>
                {files.map(f => (
                  <Box flexDirection="row" gap={1} alignItems="center" borderStyle="round" paddingX={2}>
                    <Box flexDirection="column" gap={0} flexGrow={1} flexShrink={1}>
                      <Text weight="medium" wrap="truncate-end">
                        {f.name}
                      </Text>
                      <Text size="footnote" color="subtle">
                        {f.type} · {f.size}
                      </Text>
                    </Box>
                    <Act
                      k={`dl-${f.id}`}
                      label={downloading.has(f.id) ? 'Đang tải…' : 'Tải về'}
                      onPress={() => void download($, f)}
                    />
                    <Link href={messageLink(thread, m.ts)} label="Mở trong Slack ↗" />
                  </Box>
                ))}
              </Box>
            )}
            {reactions.length > 0 && (
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                {reactions.map(r => (
                  <Box borderStyle="round" paddingX={1}>
                    <Text tabular>
                      {emojiOf(r.name)} {r.count}
                    </Text>
                  </Box>
                ))}
              </Box>
            )}
            <CopyBox k={`orig-${m.ts}`} />
            <CopyBox k={`link-${m.ts}`} />
          </Box>
        )
      }

      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          {header}
          {connectorLine}
          {noticeBanner}
          {/* The parent stays on top; the older replies load between it and the ones already shown. */}
          {visible.filter(m => m.isParent).map(messageCard)}
          {older.has(thread.id) && (
            <Box flexDirection="row" justifyContent="center">
              <Act
                k="older"
                label={loadingOlder.has(thread.id) ? 'Đang tải tin cũ hơn…' : `Xem ${PAGE} tin cũ hơn`}
                onPress={() => void loadOlder($, thread)}
              />
            </Box>
          )}
          {visible.filter(m => !m.isParent).map(messageCard)}
          <Section
            title="Trả lời"
            hint={
              pending?.id === thread.id
                ? `Xem lại trước khi gửi vào thread${isBroadcast ? ' và cả kênh' : ''}.`
                : 'Enter để xem lại; @Tên của người trong thread sẽ thành mention.'
            }
          >
            {pending?.id === thread.id ? (
              <Box flexDirection="column" gap={1}>
                <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={2} paddingY={1}>
                  <Markdown text={slackToMarkdown(pending.text)} />
                </Box>
                <Box flexDirection="row" gap={1}>
                  <Spacer />
                  <Act
                    k="send-edit"
                    label="Sửa"
                    onPress={() => {
                      pending = null
                      void redraw($)
                    }}
                  />
                  <Act k="send-confirm" label={isBusy ? 'Đang gửi…' : 'Gửi'} active onPress={() => void send($)} />
                </Box>
              </Box>
            ) : (
              <Box flexDirection="column" gap={1}>
                <Input
                  key={`reply-${thread.id}`}
                  rows={4}
                  placeholder="Viết trả lời"
                  submitLabel="Xem lại"
                  value={draft}
                  onInput={v => {
                    drafts.set(thread.id, v)
                  }}
                  onSubmit={v => {
                    const text = applyMentions(v.trim(), people)
                    if (!text) return say($, 'Chưa có nội dung để gửi.', 'warn')
                    drafts.set(thread.id, v)
                    pending = { id: thread.id, text }
                    notice = null
                    void redraw($)
                  }}
                />
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Act
                    k="broadcast"
                    label={isBroadcast ? 'Gửi cả vào kênh: bật' : 'Gửi cả vào kênh: tắt'}
                    active={isBroadcast}
                    onPress={() => {
                      if (isBroadcast) broadcast.delete(thread.id)
                      else broadcast.add(thread.id)
                      void redraw($)
                    }}
                  />
                </Box>
              </Box>
            )}
          </Section>
        </Box>
      )
    }

    // --- the list of followed threads ---

    const unread = threads.filter(isUnread).length
    const COL = { mark: 3, replies: 10, updated: 12, actions: 16 }
    const head = (text: string, width?: number) => (
      <Box width={width} flexGrow={width ? 0 : 1} flexShrink={width ? 0 : 1}>
        <Text size="footnote" weight="medium" color="subtle">
          {text}
        </Text>
      </Box>
    )
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexDirection="column" gap={0} flexGrow={1}>
            <Text size="heading" weight="semibold">
              Slack threads
            </Text>
            <Text size="footnote" color="subtle">
              {threads.length} thread đang theo dõi{unread ? ` · ${unread} có tin mới` : ''}
            </Text>
          </Box>
          <SettingsButton />
          <Act
            k="refresh-all"
            label={isBusy ? 'Đang tải…' : 'Làm mới tất cả'}
            onPress={() => {
              if (isBusy) return
              isBusy = true
              void (async () => {
                try {
                  for (const t of await loadThreads($)) await refreshThread($, t, false, true)
                  say($, 'Đã làm mới.')
                } catch (error) {
                  say($, `Làm mới lỗi: ${String(error).slice(0, 300)}`, 'error')
                } finally {
                  isBusy = false
                  await redraw($)
                }
              })()
            }}
          />
        </Box>
        {connectorLine}
        {noticeBanner}
        <Section title="Theo dõi thread" hint="Dán link một tin trong thread (Copy link trong Slack) rồi Enter.">
          <Input
            key="add-link"
            placeholder="https://…slack.com/archives/…"
            submitLabel="Thêm"
            value={addForm.link}
            onInput={v => {
              addForm.link = v
            }}
            onSubmit={v => void addThread($, v)}
          />
        </Section>
        <Section title="Danh sách" hint="● có tin mới chưa đọc. Mở một thread để đọc và trả lời.">
          {threads.length === 0 ? (
            <Text dimColor>Chưa theo dõi thread nào.</Text>
          ) : (
            <Box flexDirection="column" gap={1}>
              <Box flexDirection="row" gap={2}>
                {head('', COL.mark)}
                {head('Thread')}
                {head('Trả lời', COL.replies)}
                {head('Cập nhật', COL.updated)}
                {head('', COL.actions)}
              </Box>
              {threads.map(t => [
                <Divider />,
                <Box flexDirection="row" gap={2} alignItems="center">
                  <Box width={COL.mark} flexShrink={0}>
                    <Text color={isUnread(t) ? 'claude' : 'subtle'}>{isUnread(t) ? '●' : '○'}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text weight={isUnread(t) ? 'semibold' : 'regular'} wrap="truncate-end">
                      {t.title || `${t.channelId} · ${t.threadTs}`}
                    </Text>
                  </Box>
                  <Box width={COL.replies} flexShrink={0}>
                    <Text tabular color="subtle">
                      {t.hasOlder ? `${t.replyCount}+` : t.replyCount}
                    </Text>
                  </Box>
                  <Box width={COL.updated} flexShrink={0}>
                    <Text tabular color="subtle">
                      {t.lastReplyTs ? shortTime(t.lastReplyTs) : '–'}
                    </Text>
                  </Box>
                  <Box width={COL.actions} flexShrink={0} flexDirection="row" gap={1} justifyContent="flex-end">
                    <Act k={`open-${t.id}`} label="Mở" active={isUnread(t)} onPress={() => void openThread($, t.id)} />
                    <Act
                      k={`drop-${t.id}`}
                      label="Bỏ"
                      dim
                      onPress={() =>
                        void saveThreads(
                          $,
                          threads.filter(x => x.id !== t.id),
                        )
                          .then(() => forgetThread($, t.id))
                          .then(() => say($, 'Đã bỏ theo dõi thread.'))
                      }
                    />
                  </Box>
                </Box>,
              ])}
            </Box>
          )}
        </Section>
      </Box>
    )
  })
}
