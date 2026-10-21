import { expect, mock, test } from 'claude-code/testing'

import { textHash } from '../hooks/cache'

const PANE = {
  plugin: 'slack-threads',
  component: 'Pane',
  requestId: 'slack-threads',
  props: {
    title: 'Slack threads',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

test('the thread list draws on the terminal and on desktop', async ($, on) => {
  // Nothing sits beneath the plugin: these hooks stand for the engine, with a Slack connector and no threads yet.
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Chưa theo dõi thread nào/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Chưa thấy connector Slack/ })) === undefined).toBe(true)
    if (surface === 'terminal') {
      const texts = await ui.findAll({ type: 'Text' })
      expect(texts.filter(t => t.props.color === undefined || t.props.dimColor === true).map(t => t.text)).toEqual([])
    }
    await ui.unmount()
  }
})

test('a thread opens and draws its messages and the reply box', async ($, on) => {
  const THREAD = {
    channelId: 'C0TEST1',
    threadTs: '1784707347.615469',
    workspace: 'acme',
    id: 'C0TEST1:1784707347.615469',
    title: 'Release plan',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-22 15:02:27 +07',
    'Message TS: 1784707347.615469',
    'Please review the release plan.',
    'Reactions: eyes (2)',
    'Files: plan.pdf (ID: F0TEST, application/pdf, 12 KB)',
    '',
    '=== THREAD REPLIES (1 total) ===',
    '',
    '--- Reply 1 of 1 ---',
    'From: Bob Tran <bob@example.com> (U0BBB2222)',
    'Time: 2026-07-22 16:00:00 +07',
    'Message TS: 1784710800.000100',
    'Looks good to me.',
  ].join('\n')
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({
    result: JSON.stringify({ messages: LISTING }),
    text: JSON.stringify({ messages: LISTING }),
  }))

  mock.store(on)
  on('model.complete', () => ({
    value: {
      isAnswered: true as const,
      text: 'Tôi thấy ổn.',
      usage: { input_tokens: 120, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: `open-${THREAD.id}` })
    expect((await ui.find({ type: 'Text', text: /^Bob Tran$/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /Tin gốc/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^Trả lời$/ })) !== undefined).toBe(true)
    // Slack-like extras: the reaction chip with its emoji, and the attachment card.
    expect((await ui.find({ type: 'Text', text: /👀 2/ })) !== undefined).toBe(true)
    expect((await ui.find({ type: 'Text', text: /^plan\.pdf$/ })) !== undefined).toBe(true)
    if (surface === 'desktop') {
      // The global switch: every message is drawn in its translation, in place, and each step lands in the AI log.
      await ui.press({ key: 'mode-translated' })
      // The chosen option of the group is the filled one; the other stays an outline.
      expect((await ui.find({ key: 'mode-translated' }))?.props.variant).toBe('primary')
      expect((await ui.find({ key: 'mode-original' }))?.props.variant).toBe('secondary')
      await ui.press({ key: 'ai-log' })
      expect(
        (await ui.find({ type: 'Text', text: /Bắt đầu dịch 2 tin sang Tiếng Việt, 2 tin cùng lúc/ })) !== undefined,
      ).toBe(true)
      expect((await ui.find({ type: 'Text', text: /\[Bob Tran [^\]]+\] Dịch sang/ })) !== undefined).toBe(true)
      expect((await ui.find({ type: 'Text', text: /Model trả lời sau/ })) !== undefined).toBe(true)
      expect((await ui.find({ type: 'Text', text: /đã dịch/ })) !== undefined).toBe(true)
      expect((await ui.find({ type: 'Text', text: /Bản dịch · / })) === undefined).toBe(true)
      // Back to the original: the same messages, as written.
      await ui.press({ key: 'mode-original' })
      expect((await ui.find({ key: 'mode-original' }))?.props.variant).toBe('primary')
      expect((await ui.find({ type: 'Text', text: /· đã dịch/ })) === undefined).toBe(true)
    }
    await ui.press({ key: 'back' })
    await ui.unmount()
  }
})

test('a translation kept in the store is reused, unless the message changed since', async ($, on) => {
  const THREAD = {
    channelId: 'C0CACHE',
    threadTs: '1784800000.000100',
    workspace: 'acme',
    id: 'C0CACHE:1784800000.000100',
    title: 'Cache',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-23 09:00:00 +07',
    'Message TS: 1784800000.000100',
    'Ship it on Friday.',
    '',
    '--- Reply 1 of 1 ---',
    'From: Bob Tran <bob@example.com> (U0BBB2222)',
    'Time: 2026-07-23 09:30:00 +07',
    'Message TS: 1784801800.000200',
    'Friday works, edited.',
  ].join('\n')
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({
    result: JSON.stringify({ messages: LISTING }),
    text: JSON.stringify({ messages: LISTING }),
  }))
  // Saved by an earlier session: the parent as it still reads, the reply as it read before it was edited.
  mock.store(on, {
    [`tr:${THREAD.id}`]: {
      '1784800000.000100|vi|sonnet|balanced': { h: textHash('Ship it on Friday.'), text: 'Phát hành vào thứ Sáu.' },
      '1784801800.000200|vi|sonnet|balanced': { h: textHash('Friday works.'), text: 'Thứ Sáu được.' },
    },
  })
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls++
    return {
      value: {
        isAnswered: true as const,
        text: 'Thứ Sáu được, đã sửa.',
        usage: { input_tokens: 50, output_tokens: 8, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  await ui.press({ key: 'mode-translated' })
  await ui.press({ key: 'ai-log' })
  expect(modelCalls).toBe(1)
  expect((await ui.find({ type: 'Text', text: /Lấy 1 tin từ bản dịch đã lưu/ })) !== undefined).toBe(true)
  // The kept one and the redone one both draw in place.
  const drawn = (await ui.findAll({ type: 'Markdown' })).map(n => n.props.text)
  expect(drawn).toContain('Phát hành vào thứ Sáu.')
  expect(drawn).toContain('Thứ Sáu được, đã sửa.')
  await ui.unmount()
})

test('a thread the connector answers in an unreadable shape says so instead of loading forever', async ($, on) => {
  const THREAD = {
    channelId: 'C0BROKE',
    threadTs: '1784900000.000100',
    workspace: 'acme',
    id: 'C0BROKE:1784900000.000100',
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({ result: 'Output too large, saved to a file.', text: 'Output too large, saved to a file.' }))
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  expect(
    (await ui.find({ type: 'Text', text: /Không đọc được thread: connector trả về nội dung không đọc được/ })) !==
      undefined,
  ).toBe(true)
  expect((await ui.find({ type: 'Text', text: /Đang tải/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a long thread whose reply was saved to a file is read from that file', async ($, on) => {
  const THREAD = {
    channelId: 'C0LONG',
    threadTs: '1785000000.000100',
    workspace: 'acme',
    id: 'C0LONG:1785000000.000100',
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const SAVED = '/home/test/.claude/projects/x/tool-results/mcp-slack_read_thread-1.txt'
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-24 09:00:00 +07',
    'Message TS: 1785000000.000100',
    'A very long message.',
  ].join('\n')
  const pointer =
    'Error: result (59,650 characters across 1 line) exceeds maximum allowed tokens. ' +
    `Output has been saved to ${SAVED}`
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', (_, e) => ({
    value: e.path === SAVED ? JSON.stringify({ messages: LISTING }) : JSON.stringify({ threads: [THREAD] }),
  }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({ result: pointer, text: pointer }))
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  expect((await ui.findAll({ type: 'Markdown' })).map(n => n.props.text)).toContain('A very long message.')
  expect((await ui.find({ type: 'Text', text: /Không đọc được thread/ })) === undefined).toBe(true)
  await ui.unmount()
})

test('a thread opens on its newest replies and loads older ones on request', async ($, on) => {
  const THREAD = {
    channelId: 'C0PAGE',
    threadTs: '1785100000.000100',
    workspace: 'acme',
    id: 'C0PAGE:1785100000.000100',
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const parent = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-25 09:00:00 +07',
    'Message TS: 1785100000.000100',
    'The parent.',
  ]
  const reply = (i: number) => [
    `--- Reply ${i} of 7 ---`,
    'From: Bob Tran <bob@example.com> (U0BBB2222)',
    'Time: 2026-07-25 10:00:00 +07',
    `Message TS: 17851000${String(i).padStart(2, '0')}.000100`,
    `Reply number ${i}.`,
  ]
  // The connector pages newest first: replies 3-7 now, then 1-2 behind the cursor.
  const pages: Record<string, { messages: string; pagination_info: string }> = {
    first: {
      messages: [...parent, '', ...[3, 4, 5, 6, 7].flatMap(reply)].join('\n'),
      pagination_info: 'There are more messages in this thread. To view the next page, use cursor: `older-1`',
    },
    'older-1': {
      messages: [...parent, '', ...[1, 2].flatMap(reply)].join('\n'),
      pagination_info: 'There are no more messages in this thread.',
    },
  }
  const asked: { limit?: unknown; cursor?: unknown }[] = []
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', (_, e) => {
    const input = e as unknown as { limit?: unknown; cursor?: unknown }
    asked.push({ limit: input.limit, cursor: input.cursor })
    const page = JSON.stringify(pages[typeof input.cursor === 'string' ? input.cursor : 'first'])
    return { result: page, text: page }
  })
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  const drawn = async () => (await ui.findAll({ type: 'Markdown' })).map(n => n.props.text)
  expect(asked[0]).toEqual({ limit: 5, cursor: undefined })
  expect(await drawn()).toEqual([
    'The parent.',
    'Reply number 3.',
    'Reply number 4.',
    'Reply number 5.',
    'Reply number 6.',
    'Reply number 7.',
  ])
  expect((await ui.find({ type: 'Text', text: /^5\+ trả lời/ })) !== undefined).toBe(true)

  await ui.press({ key: 'older' })
  expect(asked.at(-1)).toEqual({ limit: 5, cursor: 'older-1' })
  expect((await drawn()).slice(0, 3)).toEqual(['The parent.', 'Reply number 1.', 'Reply number 2.'])
  // Everything is loaded: the button goes and the count is exact.
  expect((await ui.find({ key: 'older' })) === undefined).toBe(true)
  expect((await ui.find({ type: 'Text', text: /^7 trả lời/ })) !== undefined).toBe(true)
  await ui.unmount()
})

test('an attachment downloads into the Downloads folder: text as sent, binary decoded', async ($, on) => {
  const THREAD = {
    channelId: 'C0FILES',
    threadTs: '1785200000.000100',
    workspace: 'acme',
    id: 'C0FILES:1785200000.000100',
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-26 09:00:00 +07',
    'Message TS: 1785200000.000100',
    'Two files.',
    'Files: notes.txt (ID: F0TEXT, text/plain, 1 KB), shot.png (ID: F0BIN, image/png, 2 KB)',
  ].join('\n')
  const FILES: Record<string, string> = {
    F0TEXT: 'File ID: F0TEXT\nMIME Type: text/plain\n\n<file_content_ab12>\nhello\nworld\n</file_content_ab12>',
    F0BIN: 'File ID: F0BIN\nMIME Type: image/png\n\n<file_content_cd34>\niVBORw0KGgo=\n</file_content_cd34>',
  }
  const written: Record<string, string> = {}
  const decoded: { argv: readonly string[]; stdin?: string; out?: string }[] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/test' : undefined }))
  on('fs.exists', (_, e) => ({ value: !e.path.includes('/Downloads/') || e.path in written }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', (_, e) => {
    const input = e as unknown as { tool: string; file_id?: string }
    const out = input.tool.endsWith('slack_read_file')
      ? (FILES[input.file_id ?? ''] ?? '')
      : JSON.stringify({ messages: LISTING })
    return { result: out, text: out }
  })
  on('process.run', (_, e) => {
    decoded.push({ argv: e.argv, stdin: e.init?.stdin, out: e.init?.env?.SLACK_OUT })
    return {
      value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    }
  })
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  await ui.press({ key: 'dl-F0TEXT' })
  expect(written['/home/test/Downloads/notes.txt']).toBe('hello\nworld')
  expect(
    (await ui.find({ type: 'Text', text: /Đã tải notes\.txt về \/home\/test\/Downloads\/notes\.txt/ })) !== undefined,
  ).toBe(true)
  // A second download of the same name does not overwrite the first.
  await ui.press({ key: 'dl-F0TEXT' })
  expect(written['/home/test/Downloads/notes (1).txt']).toBe('hello\nworld')

  await ui.press({ key: 'dl-F0BIN' })
  expect(decoded).toEqual([
    { argv: ['sh', '-c', 'base64 -d > "$SLACK_OUT"'], stdin: 'iVBORw0KGgo=', out: '/home/test/Downloads/shot.png' },
  ])
  await ui.unmount()
})

test('a thread can be renamed, and an empty name goes back to the parent', async ($, on) => {
  const THREAD = {
    channelId: 'C0NAME',
    threadTs: '1785300000.000100',
    workspace: 'acme',
    id: 'C0NAME:1785300000.000100',
    title: '',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-27 09:00:00 +07',
    'Message TS: 1785300000.000100',
    'Release checklist for Friday',
  ].join('\n')
  let saved = JSON.stringify({ threads: [THREAD] })
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: saved }))
  on('fs.write', (_, e) => {
    saved = e.text
    return { value: undefined }
  })
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({
    result: JSON.stringify({ messages: LISTING }),
    text: JSON.stringify({ messages: LISTING }),
  }))
  mock.store(on)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  expect((await ui.find({ type: 'Text', text: /^Release checklist for Friday$/ })) !== undefined).toBe(true)
  await ui.press({ key: 'rename' })
  await ui.input({ key: `title-${THREAD.id}`, text: 'UAT 22/10', kind: 'submit' })
  expect((await ui.find({ type: 'Text', text: /^UAT 22\/10$/ })) !== undefined).toBe(true)
  expect(JSON.parse(saved).threads[0].title).toBe('UAT 22/10')
  await ui.press({ key: 'rename' })
  await ui.input({ key: `title-${THREAD.id}`, text: '  ', kind: 'submit' })
  expect(JSON.parse(saved).threads[0].title).toBe('Release checklist for Friday')
  await ui.unmount()
})

test('settings pick the model and the style, kept in the store and used by the next translation', async ($, on) => {
  const THREAD = {
    channelId: 'C0SET',
    threadTs: '1785400000.000100',
    workspace: 'acme',
    id: 'C0SET:1785400000.000100',
    title: 'Settings',
    lastReplyTs: '',
    lastSeenTs: '',
    replyCount: 0,
    addedAt: '2026-10-21T00:00:00.000Z',
  }
  const LISTING = [
    '=== THREAD PARENT MESSAGE ===',
    'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
    'Time: 2026-07-28 09:00:00 +07',
    'Message TS: 1785400000.000100',
    'Please confirm by Friday.',
  ].join('\n')
  on('env.get', () => ({ value: '/home/test' }))
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: JSON.stringify({ threads: [THREAD] }) }))
  on('fs.write', () => ({ value: undefined }))
  on('tool.list', () => ({ value: [{ name: 'mcp__abc-123__slack_read_thread', description: '', mcp: true }] }))
  on('tool.call', () => ({
    result: JSON.stringify({ messages: LISTING }),
    text: JSON.stringify({ messages: LISTING }),
  }))
  // A store of our own, to see what the settings write.
  const store = new Map<string, unknown>()
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  const asked: { model: string; system: string }[] = []
  on('model.complete', (_, e) => {
    asked.push({ model: e.model, system: String(e.system ?? '') })
    return {
      value: {
        isAnswered: true as const,
        text: 'Vui lòng xác nhận trước thứ Sáu.',
        usage: { input_tokens: 40, output_tokens: 9, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: `open-${THREAD.id}` })
  await ui.press({ key: 'open-settings' })
  expect((await ui.find({ key: 'model-sonnet' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'style-balanced' }))?.props.variant).toBe('primary')
  await ui.press({ key: 'model-opus' })
  await ui.press({ key: 'style-exact' })
  expect((await ui.find({ key: 'model-opus' }))?.props.variant).toBe('primary')
  expect((await ui.find({ key: 'model-sonnet' }))?.props.variant).toBe('secondary')
  expect(store.get('settings')).toEqual({ lang: 'vi', model: 'opus', style: 'exact' })

  await ui.press({ key: 'settings-back' })
  await ui.press({ key: 'mode-translated' })
  expect(asked.at(-1)?.model).toBe('opus')
  expect(asked.at(-1)?.system.includes('Stay as close to the original')).toBe(true)
  await ui.unmount()
})
