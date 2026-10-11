// 上游错误状态策略：429 限流归一、11133 瞬时 400 退避重发
//
// CodeBuddy 网关的两类"可恢复"错误：
//   - 429：只返回状态码、body 为空（与 models.ts 注释的 "400 status code (no body)" 同源），
//     上层只能看到 "429 status code (no body)"；而 Pi 的 agent 级重试只看错误文案、
//     不读 Retry-After，于是盲打 4 次。
//   - 11133：偶发把上游厂商的瞬时校验失败包装成 11133 返回（服务端故障窗口，
//     同构请求稍后重发即成功）。body 为字符串 JSON 可幂等重发；400 到达即流未开始。

import type { CodeBuddyConfig } from './config.ts'
import { abortableSleep, headersWithoutEntity, jsonResponse, safeText } from './http-utils.ts'
import type { Logger } from './log.ts'

/** 11133 的退避序列（毫秒）。 */
const TRANSIENT_400_DELAYS_MS = [1000, 4000, 10000, 25000]

/**
 * 把限流头里的数值统一定位成"还需等待多少毫秒"。
 * 网关可能给相对秒（OpenAI）、相对毫秒（gRPC 风格）、秒/毫秒级 epoch，策略不同。
 */
function normalizeDelayMs(num: number): number {
  if (num > 1e12) return Math.max(0, num - Date.now()) // 毫秒级 epoch
  if (num > 1e9) return Math.max(0, (num - Date.now() / 1000) * 1000) // 秒级 epoch
  return Math.max(0, num * 1000) // 相对秒（小于 1e9 秒 ≈ 31 年，当成相对量安全）
}

/** 读 Retry-After(-ms) / X-RateLimit-Reset* 提示，返回建议等待毫秒数。 */
export function parseRetryDelayMs(headers: Headers): number | undefined {
  const ms = headers.get('retry-after-ms')
  if (ms) {
    const v = Number.parseFloat(ms)
    if (Number.isFinite(v)) {
      // `retry-after-ms` 按惯例是相对毫秒；只有像 epoch 的巨大值才减当前时间。
      return v > 1e12 ? Math.max(0, v - Date.now()) : Math.max(0, v)
    }
  }
  for (const name of [
    'retry-after',
    'x-ratelimit-reset-requests',
    'x-ratelimit-reset-tokens',
    'x-ratelimit-reset'
  ]) {
    const raw = headers.get(name)
    if (!raw) continue
    const num = Number.parseFloat(raw)
    if (Number.isFinite(num)) return normalizeDelayMs(num)
    const date = Date.parse(raw)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return undefined
}

/**
 * 合成可读的 429 错误 body。
 * 关键：终态（配额窗口很远）文案里带 "quota exceeded"，命中 Pi 的
 * NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN → 立即失败；否则保留 "429 / rate limit"
 * 字样，交给 Pi 的退避重试。
 */
export function buildRateLimitMessage(
  hintMs: number | undefined,
  terminal: boolean,
  gatewayBody: string
): string {
  const hint =
    hintMs === undefined ? '无 Retry-After 提示' : `网关建议 ${Math.ceil(hintMs / 1000)}s 后重试`
  const extra = gatewayBody ? ` | 网关 body: ${gatewayBody.slice(0, 200)}` : ' | 网关未返回 body'
  if (terminal) {
    return `codebuddy: 上游配额超限（quota exceeded），${hint}，超出本地等待预算。等配额窗口过去或改用其他模型。${extra}`
  }
  return `codebuddy: 网关限流 HTTP 429（rate limit / too many requests），${hint}。降低并发或稍后重试。${extra}`
}

/** 重试循环所需的上下文：重新发请求 + 日志 + 调用方信号。 */
export interface RetryContext {
  request: () => Promise<Response>
  logger?: Logger
  signal?: AbortSignal | null
}

/** 错误 body 中的上游业务码（非 JSON 或缺失时返回 undefined）。 */
function errorCodeOf(text: string): unknown {
  try {
    return (JSON.parse(text) as { code?: unknown })?.code
  } catch {
    return undefined
  }
}

/** 按尝试次数取退避时长（超出序列长度时用最后一个值）。 */
function delayFor(attempt: number): number {
  return TRANSIENT_400_DELAYS_MS[Math.min(attempt, TRANSIENT_400_DELAYS_MS.length - 1)]!
}

/**
 * 处理上游 11133 瞬时 400：按退避序列重发，直到成功、耗尽次数、遇到非 11133 或中止。
 *
 * 返回重试后的最终响应，以及循环内已读过的 400 body（`lastText`）供调用方复用，
 * 避免二次 `response.text()` 抛 "Body is unusable"。
 */
export async function retryTransient400(
  response: Response,
  cfg: CodeBuddyConfig,
  ctx: RetryContext
): Promise<{ response: Response; lastText: string }> {
  const maxRetries = cfg.transient400Retries ?? 4
  let current = response
  let lastText = ''
  for (let attempt = 0; current.status === 400 && attempt < maxRetries; attempt++) {
    const text = await safeText(current)
    const code = errorCodeOf(text)
    if (code !== 11133) return { response: respWithText(text, current), lastText }
    lastText = text
    if (ctx.signal?.aborted) break
    ctx.logger?.warn(`upstream transient 400 (11133), retry ${attempt + 1}/${maxRetries}`)
    try {
      await abortableSleep(delayFor(attempt), ctx.signal)
    } catch {
      // 退避期间被中止：不再重发，由调用方用 lastText 重建 400（不向外抛）
      break
    }
    if (ctx.signal?.aborted) break
    current = await ctx.request()
  }
  return { response: current, lastText }
}

/** 用已读文本重建 400 响应（Content-Type 统一为 JSON）。 */
function respWithText(text: string, source: Response): Response {
  const h = new Headers(source.headers)
  h.set('Content-Type', 'application/json')
  return new Response(text, { status: 400, headers: h })
}

/** 429 处理结果：要么重试成功（response 非 429），要么需合成错误体。 */
export interface RateLimitOutcome {
  response: Response
  terminal: boolean
  hintMs: number | undefined
  gatewayBody: string
}

/**
 * 处理上游 429：有 Retry-After 且在预算内则就地幂等重发；否则收集提示信息，
 * 由调用方合成可读错误体（区分终态与可重试）。
 */
export async function handleRateLimit(
  response: Response,
  cfg: CodeBuddyConfig,
  ctx: RetryContext
): Promise<RateLimitOutcome> {
  let current = response
  let hintMs = parseRetryDelayMs(current.headers)
  let gatewayBody = await safeText(current)
  const retries = cfg.rateLimitRetries ?? 0
  for (let attempt = 0; current.status === 429 && attempt < retries; attempt++) {
    if (ctx.signal?.aborted) break
    if (hintMs === undefined || hintMs > cfg.rateLimitMaxWaitMs) break
    ctx.logger?.warn(
      `429 rate limited, waiting ${formatWait(hintMs)} then retrying (${attempt + 1}/${retries})`
    )
    try {
      await abortableSleep(hintMs, ctx.signal)
    } catch {
      break
    }
    current = await ctx.request()
    if (current.status === 429) {
      hintMs = parseRetryDelayMs(current.headers)
      gatewayBody = await safeText(current)
    }
  }
  const terminal =
    current.status === 429 && (hintMs === undefined ? false : hintMs > cfg.rateLimitMaxWaitMs)
  return { response: current, terminal, hintMs, gatewayBody }
}

/** 等待时长的可读形式（<1s 显示毫秒，否则显示秒）。 */
function formatWait(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${Math.ceil(ms / 1000)}s`
}

/** 把 429 归一为上层可读的错误响应（剥离实体会话头，避免误导 SDK）。 */
export function rateLimitErrorResponse(outcome: RateLimitOutcome): Response {
  const { response, terminal, hintMs, gatewayBody } = outcome
  return jsonResponse(
    {
      error: {
        message: buildRateLimitMessage(hintMs, terminal, gatewayBody),
        type: 'rate_limit_error',
        code: terminal ? 'quota_exceeded' : 'rate_limited',
        status: 429
      }
    },
    429,
    headersWithoutEntity(response.headers)
  )
}
