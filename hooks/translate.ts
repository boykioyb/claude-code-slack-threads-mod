import type { EngineInterface } from 'claude-code'

export type Lang = 'vi' | 'en' | 'ja'

export const LANGS: Record<Lang, string> = { vi: 'Tiếng Việt', en: 'English', ja: '日本語' }

const NAMES: Record<Lang, string> = { vi: 'Vietnamese', en: 'English', ja: 'Japanese' }

export type ModelChoice = 'haiku' | 'sonnet' | 'opus'

export const MODELS: Record<ModelChoice, { label: string; hint: string }> = {
  haiku: { label: 'Haiku', hint: 'Nhanh và rẻ nhất, hợp với tin ngắn.' },
  sonnet: { label: 'Sonnet', hint: 'Cân bằng giữa tốc độ và chất lượng.' },
  opus: { label: 'Opus', hint: 'Kỹ nhất nhưng chậm hơn, hợp với tin dài hoặc khó.' },
}

export type Style = 'exact' | 'balanced' | 'creative'

export const STYLES: Record<Style, { label: string; hint: string; rule: string }> = {
  exact: {
    label: 'Chính xác',
    hint: 'Theo sát nghĩa gốc, phù hợp tài liệu kỹ thuật.',
    rule: 'Stay as close to the original as the target language allows: keep its sentence order, its terms and every detail, even where that reads a little stiff.',
  },
  balanced: {
    label: 'Cân bằng',
    hint: 'Tự nhiên hơn nhưng vẫn giữ đủ ý chính.',
    rule: 'Read naturally in the target language while keeping every point and detail of the original.',
  },
  creative: {
    label: 'Sáng tạo',
    hint: 'Diễn đạt mượt hơn cho nội dung hội thoại.',
    rule: 'Write it the way a native speaker would say it in a chat: rephrase and reorder freely, as long as the meaning stays.',
  },
}

export type TranslateOptions = { lang: Lang; model: ModelChoice; style: Style }

export type StepLog = (text: string, tone?: 'error') => void

// One Slack message into the chosen language, as Markdown. Mentions, links, code, numbers and proper names stay as
// written; a message already in that language comes back unchanged. Each step is reported to `log`.
export async function translate(
  $: EngineInterface,
  markdown: string,
  options: TranslateOptions,
  log: StepLog = () => undefined,
): Promise<string> {
  const name = NAMES[options.lang]
  const system =
    `You translate one Slack message into ${name}. Reply with the translation only, as Markdown, keeping the ` +
    'line breaks and list structure. Keep @mentions, #channels, URLs, e-mail addresses, code, file names, numbers ' +
    'and product or person names exactly as written. Keep the tone (polite business Japanese becomes polite ' +
    `${name}). ${STYLES[options.style].rule} If the message is already in ${name}, return it unchanged.`
  log(
    `Gửi cho model ${MODELS[options.model].label}, phong cách ${STYLES[options.style].label} ` +
      `(${markdown.length.toLocaleString('en')} ký tự)…`,
  )
  const startedAt = Date.now()
  const reply = await $.model.complete({
    model: options.model,
    system,
    prompt: markdown,
    maxTokens: 4000,
    timeoutMs: 90000,
  })
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  if (!reply.isAnswered) throw new Error(`model không trả lời sau ${seconds}s (${reply.reason})`)
  log(`Model trả lời sau ${seconds}s · ${reply.usage.input_tokens} token vào, ${reply.usage.output_tokens} token ra`)
  return reply.text.trim()
}
