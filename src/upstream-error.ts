// 上游错误体解析与用户可读文案
//
// CodeBuddy 网关的失败响应是结构化 JSON，且自带面向用户的本地化文案：
//
//   {"code":11151,
//    "msg":"a message has empty content, please check the conversation history and retry",
//    "displayMsg": {"en":"…", "zh":"存在空白消息，请补全后重试", "zh-hant":"…"},
//    "displayTips":{"en":"…", "zh":"对话里有内容为空的消息，模型无法处理。…"},
//    "actions":["NEW_CONVERSATION","SUBMIT_FEEDBACK"]}
//
// 直接透传原始 JSON 会让用户看到一长串英文与字段名。本项目文案以中文为主，
// 故 displayMsg / displayTips 按 zh → zh-hant → en 取第一个非空值。
//
// 少数失败不是 JSON：网关前置代理在凭据无效时返回 HTML（401），
// 此时没有可解析的信息，只能给状态码与简短说明。

/** displayMsg / displayTips 的本地化结构（上游固定给 en / zh / zh-hant） */
type LocalizedText = Record<string, unknown>

export interface UpstreamError {
  /** 上游业务码（数字或字符串）；无法解析时 undefined */
  code?: number | string
  /** 上游英文原文 */
  msg?: string
  /** 面向用户的短提示（优先简体中文） */
  display?: string
  /** 可操作建议（同语言优先级） */
  tips?: string
  /** 是否为可识别的上游错误 JSON（false 表示 HTML / 纯文本 / 无结构） */
  structured: boolean
}

/**
 * 少数错误码未给 displayMsg，或文案不足以说明处理方式，在此补充。
 * 12403 是客户端标识被拒——意味着本扩展的版本常量可能已过期，使用者无从判断。
 */
const CODE_HINTS: Record<number, string> = {
  12403: '上游拒绝了客户端标识（IDE / APP 版本常量可能已过期）'
}

const LANGUAGES = ['zh', 'zh-hant', 'en'] as const

/** 从多语言字段取第一个非空文案 */
function pickText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (!value || typeof value !== 'object') return undefined
  const record = value as LocalizedText
  for (const lang of LANGUAGES) {
    const text = record[lang]
    if (typeof text === 'string' && text.trim()) return text.trim()
  }
  return undefined
}

function pickCode(value: unknown): number | string | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

function hintFor(code: number | string | undefined): string | undefined {
  return typeof code === 'number' ? CODE_HINTS[code] : undefined
}

/** 解析上游错误体。非 JSON、空体、或结构里没有任何可用字段时 structured 为 false。 */
export function parseUpstreamError(text: string): UpstreamError {
  if (!text.trim()) return { structured: false }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { structured: false }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { structured: false }
  const root = body as Record<string, unknown>
  // 少数网关把错误包在 error 下（OpenAI 风格）
  const nested =
    root.error && typeof root.error === 'object' && !Array.isArray(root.error)
      ? (root.error as Record<string, unknown>)
      : undefined
  const code = pickCode(root.code) ?? pickCode(nested?.code)
  const msg = pickText(root.msg) ?? pickText(root.message) ?? pickText(nested?.message)
  const display = pickText(root.displayMsg)
  const tips = pickText(root.displayTips)
  if (code === undefined && msg === undefined && display === undefined) return { structured: false }
  return { code, msg, display, tips, structured: true }
}

/**
 * 组装面向用户的错误文案。
 *
 * 结构化的上游错误优先用 displayMsg（给用户的结论），其次 msg；
 * 再附一条可操作建议：已知错误码的内置提示优先于上游 displayTips。
 * 非结构化（HTML / 纯文本）只给状态码与截断原文，避免把标签塞给用户。
 */
export function formatUpstreamError(info: UpstreamError, status: number, raw: string): string {
  if (!info.structured) return formatUnstructured(status, raw)
  const codeSuffix = info.code === undefined ? '' : `（上游错误码 ${info.code}）`
  const lines = [`codebuddy: ${info.display ?? info.msg ?? '上游请求失败'}${codeSuffix}`]
  const advice = hintFor(info.code) ?? info.tips
  if (advice) lines.push(advice)
  return lines.join('\n')
}

function formatUnstructured(status: number, raw: string): string {
  const snippet = raw.trim()
  if (!snippet) return `codebuddy: 上游 ${status} 未返回响应体`
  if (snippet.startsWith('<')) {
    return `codebuddy: 上游 ${status} 返回 HTML 而非 JSON（可能是网关或代理拒绝）——检查凭据或稍后重试`
  }
  return `codebuddy: 上游 ${status}：${snippet.slice(0, 200)}`
}

/**
 * 429 也可能表示额度 / 余额用尽而非短时限流，此时重试无意义。
 *
 * 只收「计费类」词：短时限流（rate limit / too many requests）与「本周期额度已满但会重置」
 * 仍应交给重试。参照 Magpie 的 brokeWords（internal/gateway/routing.go）与 Pi 自身的
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN（insufficient_quota / available balance）。
 */
const CREDIT_EXHAUSTED =
  /insufficient.?(?:balance|credit|fund|quota)|available balance|\bcredits? (?:are )?exhausted\b|out of credit|billing|余额不足|欠费|请充值/i

/** 响应体是否表示额度 / 余额已耗尽 */
export function isCreditExhausted(text: string): boolean {
  return CREDIT_EXHAUSTED.test(text)
}
