import { describe, expect, test } from 'claude-code/testing'

import {
  applyMentions,
  emojiOf,
  messageLink,
  nextCursor,
  parseFiles,
  parsePermalink,
  parseReactions,
  parseThread,
  slackToMarkdown,
  slackToPlain,
  titleOf,
} from '../hooks/parse'

const LISTING = [
  '=== THREAD PARENT MESSAGE ===',
  'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
  'Time: 2026-07-22 15:02:27 +07',
  'Message TS: 1784707347.615469',
  '<@U0BBB2222|Bob Tran>',
  'Please review the *plan* in <https://example.com/doc|the doc>.',
  'Reactions: eyes (1)',
  'Files: plan.pdf (ID: F01, application/pdf, 1 KB)',
  '',
  '=== THREAD REPLIES (2 total) ===',
  '',
  '--- Reply 1 of 2 ---',
  'From: Bob Tran <bob@example.com> (U0BBB2222)',
  'Time: 2026-07-22 16:00:00 +07',
  'Message TS: 1784710800.000100',
  'Looks good.',
  'Second line.',
  '',
  '--- Reply 2 of 2 ---',
  'From: Alice Nguyen <alice@example.com> (U0AAA1111)',
  'Time: 2026-07-23 09:00:00 +07',
  'Message TS: 1784772000.000200',
  'Thanks <@U0BBB2222|Bob Tran>!',
].join('\n')

describe('parsePermalink', () => {
  test('reads the root of a thread from a link to the root', () => {
    expect(parsePermalink('https://acme.slack.com/archives/C0AE5EE86KT/p1784707347615469')).toEqual({
      workspace: 'acme',
      channelId: 'C0AE5EE86KT',
      threadTs: '1784707347.615469',
    })
  })

  test('takes the root from thread_ts in a link to a reply', () => {
    const ref = parsePermalink(
      'https://acme.slack.com/archives/C0AE5EE86KT/p1788861018380769?thread_ts=1784707347.615469&cid=C0AE5EE86KT',
    )
    expect(ref?.threadTs).toBe('1784707347.615469')
  })

  test('rejects anything that is not a Slack message link', () => {
    expect(parsePermalink('https://example.com/x')).toBe(null)
  })
})

describe('parseThread', () => {
  const messages = parseThread(LISTING)

  test('reads the parent and every reply in order', () => {
    expect(messages.map(m => [m.ts, m.userName, m.isParent])).toEqual([
      ['1784707347.615469', 'Alice Nguyen', true],
      ['1784710800.000100', 'Bob Tran', false],
      ['1784772000.000200', 'Alice Nguyen', false],
    ])
  })

  test('keeps multi-line text, and reactions and files apart from it', () => {
    expect(messages[1]?.text).toBe('Looks good.\nSecond line.')
    expect(messages[0]?.reactions).toBe('eyes (1)')
    expect(messages[0]?.files.startsWith('plan.pdf')).toBe(true)
    expect(messages[0]?.text.includes('Reactions')).toBe(false)
  })

  test('finds the next page cursor', () => {
    expect(nextCursor('There are more messages. To view the next page, use cursor: `abc123`')).toBe('abc123')
    expect(nextCursor('')).toBe(undefined)
  })
})

describe('text', () => {
  test('draws mentions, groups, channels and links by name, without bold that could run on', () => {
    expect(slackToMarkdown('<@U0BBB2222|Bob Tran> see <https://example.com|this> in <#C1|general> ~old~')).toBe(
      '@Bob Tran see [this](https://example.com) in #general ~~old~~',
    )
    expect(slackToMarkdown('mail <mailto:a@example.com|a@example.com> or <!subteam^S01|@devs> <!subteam^S02>')).toBe(
      'mail [a@example.com](mailto:a@example.com) or @devs @nhóm',
    )
  })

  test('keeps every line break as Slack shows it, and turns *bold* into Markdown bold', () => {
    expect(slackToMarkdown('■ *Kết quả*\n・dòng 1\n・dòng 2\n\nđoạn mới')).toBe(
      '■ **Kết quả**  \n・dòng 1  \n・dòng 2\n\nđoạn mới',
    )
  })

  test('leaves fenced code as written', () => {
    expect(slackToMarkdown('```\na *b*\nc\n```')).toBe('```\na *b*\nc\n```')
  })

  test('copies a message as plain text', () => {
    expect(slackToPlain('<@U0BBB2222|Bob Tran> <mailto:a@example.com|a@example.com> &amp; <https://x.io|docs>')).toBe(
      '@Bob Tran a@example.com & docs (https://x.io)',
    )
  })

  test('turns @Name of a known participant into a real mention, longest name first', () => {
    const people = new Map([
      ['Bob Tran', 'U0BBB2222'],
      ['Bob', 'U0CCC3333'],
    ])
    expect(applyMentions('@Bob Tran ok, cc @Bob.', people)).toBe('<@U0BBB2222> ok, cc <@U0CCC3333>.')
    expect(applyMentions('mail bob@example.com', people)).toBe('mail bob@example.com')
  })

  test('titles a thread by its first real line', () => {
    expect(titleOf('<@U0BBB2222|Bob Tran>\nPlease review the plan.')).toBe('Please review the plan.')
  })

  test('reads reactions and files', () => {
    expect(parseReactions('eyes (1), gratitude-thank-you (2), +1 (3)')).toEqual([
      { name: 'eyes', count: 1 },
      { name: 'gratitude-thank-you', count: 2 },
      { name: '+1', count: 3 },
    ])
    // Slack writes a skin tone after the name; the chip keeps the reaction and its tone.
    expect(parseReactions('+1::skin-tone-2 (1), bow::skin-tone-2 (2), +1 (1)')).toEqual([
      { name: '+1::skin-tone-2', count: 1 },
      { name: 'bow::skin-tone-2', count: 2 },
      { name: '+1', count: 1 },
    ])
    expect(emojiOf('+1::skin-tone-2')).toBe('👍🏻')
    expect(emojiOf('man-bowing::skin-tone-4')).toBe('🙇🏽‍♂️')
    expect(emojiOf('custom-thing')).toBe(':custom-thing:')
    expect(
      parseFiles('plan.pdf (ID: F0BK3666S12, application/pdf, 810.4 KB), a b.txt (ID: F02, text/plain, 1 KB)'),
    ).toEqual([
      { name: 'plan.pdf', id: 'F0BK3666S12', type: 'application/pdf', size: '810.4 KB' },
      { name: 'a b.txt', id: 'F02', type: 'text/plain', size: '1 KB' },
    ])
    expect([emojiOf('eyes'), emojiOf('custom-one')]).toEqual(['👀', ':custom-one:'])
  })

  test('links one message of the thread as Slack does', () => {
    const ref = { workspace: 'acme', channelId: 'C1', threadTs: '1784707347.615469' }
    expect(messageLink(ref, '1784707347.615469')).toBe('https://acme.slack.com/archives/C1/p1784707347615469')
    expect(messageLink(ref, '1784710800.000100')).toBe(
      'https://acme.slack.com/archives/C1/p1784710800000100?thread_ts=1784707347.615469&cid=C1',
    )
  })
})
