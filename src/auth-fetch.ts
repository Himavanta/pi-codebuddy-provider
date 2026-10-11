// 自定义 fetch 拦截器（编排层）：路径匹配 → 认证注入 → 401/403 刷新重试 →
// 11133 / 429 策略调用 → SSE 思考泄漏改写。
//
// 具体策略实现已拆分：
//   - http-utils.ts    通用 HTTP 原语（URL 归一、响应构造、可中止等待）
//   - retry-policy.ts  上游错误状态策略（429 限流、11133 瞬时 400）
import type { AuthState } from './auth-state.ts'
import type { CodeBuddyConfig, ServerInfo } from './config.ts'
import {
  headersWithoutEntity,
  jsonResponse,
  resolveRequestUrl,
  textResponse
} from './http-utils.ts'
import type { Identity, JwtPayload } from './jwt.ts'
import type { Logger } from './log.ts'
import {
  createLeakState,
  isEventStreamResponse,
  rewriteLeakedReasoningStream,
  summarizeLeakRewrite
} from './reasoning-leak.ts'
import {
  handleRateLimit,
  rateLimitErrorResponse,
  retryTransient400,
  type RetryContext
} from './retry-policy.ts'

/** oauth 之外的模式（api）没有身份头。 */
const EMPTY_IDENTITY: Identity = { tenantId: '', enterpriseId: '', userId: '' }

/** 刷新失败后的冷却时长：冷却期内不再对 401/403 发起刷新。 */
const REFRESH_COOLDOWN_MS = 15_000

export type AuthFetchDeps = {
  getAuth: () => Promise<AuthState | null>
  server: ServerInfo
  buildAuthHeaders: (auth: AuthState, identity: Identity) => Record<string, string>
  resolveIdentity: (
    payload: JwtPayload | null,
    cfg?: { tenantId?: string; enterpriseId?: string; userId?: string }
  ) => Identity
  decodeJwtPayload: (token: string) => JwtPayload | null
  refreshAndPersist: (oauthAuth: AuthState & { type: 'oauth' }) => Promise<AuthState | null>
  cfg: CodeBuddyConfig
  fetchImpl?: typeof fetch
  logger?: Logger
  chatCompletionsPath: string
}

/** 未认证响应：不抛异常（OpenAI SDK 会把 fetch 抛错包装成 "Connection error" 丢失信息），
 *  返回 401 走 SDK 标准错误路径，message 保留我们的指引。 */
function unauthorizedResponse(): Response {
  return jsonResponse(
    {
      error: {
        message:
          'codebuddy: not authenticated — run `/login codebuddy` (oauth) or set CODEBUDDY_API_KEY'
      }
    },
    401
  )
}

/** 刷新冷却：刷新失败后一段时间内不再尝试（避免每个 401 请求都打一次刷新）。 */
function createRefreshCooldown(cooldownMs: number) {
  let failedAt = 0
  return {
    active: () => Date.now() - failedAt < cooldownMs,
    markFailed: () => {
      failedAt = Date.now()
    },
    markOk: () => {
      failedAt = 0
    }
  }
}

/** 身份对同一 access token 是不变量：按 token 字符串做 1 项记忆化，
 *  避免每请求都做一次 base64 解码 + 正则匹配。 */
function createIdentityMemo(resolve: (token: string) => Identity): (token: string) => Identity {
  let cache: { token: string; identity: Identity } | null = null
  return (token) => {
    if (cache?.token === token) return cache.identity
    const identity = resolve(token)
    cache = { token, identity }
    return identity
  }
}

/** 仅处理字符串 JSON body；其他类型（Stream/FormData/Blob）跳过解析直接透传。
 *  stream:true 时补 `stream_options.include_usage`（网关默认不下发 usage）。 */
function rewriteStreamBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== 'string') return body
  try {
    const parsed = JSON.parse(body)
    if (parsed.stream === true && !parsed.stream_options) {
      parsed.stream_options = { include_usage: true }
      return JSON.stringify(parsed)
    }
  } catch {
    /* 非 JSON body：原样透传 */
  }
  return body
}

export function createAuthFetch(deps: AuthFetchDeps) {
  const {
    getAuth,
    server,
    buildAuthHeaders,
    resolveIdentity,
    decodeJwtPayload,
    refreshAndPersist,
    cfg,
    fetchImpl,
    logger,
    chatCompletionsPath
  } = deps
  const doFetch = () => fetchImpl ?? globalThis.fetch
  const cooldown = createRefreshCooldown(REFRESH_COOLDOWN_MS)
  const identityFor = createIdentityMemo((token) => resolveIdentity(decodeJwtPayload(token), cfg))

  /** 注入认证头 + 规范化 body 后发出请求。 */
  async function requestWithAuth(init: RequestInit, auth: AuthState): Promise<Response> {
    const headers = new Headers(init.headers as HeadersInit)
    const identity = auth.type === 'oauth' ? identityFor(auth.access) : EMPTY_IDENTITY
    for (const [k, v] of Object.entries(buildAuthHeaders(auth, identity))) headers.set(k, v)
    return doFetch()(`${server.url}${chatCompletionsPath}`, {
      method: 'POST',
      headers,
      body: rewriteStreamBody(init.body),
      signal: init.signal
    })
  }

  /** oauth 模式下 401/403 → 刷新一次并重发；失败则进入冷却，冷却期内不再尝试。 */
  async function refreshAndRetry(
    auth: AuthState,
    response: Response,
    init: RequestInit
  ): Promise<{ auth: AuthState; response: Response }> {
    const isAuthFailure = response.status === 401 || response.status === 403
    if (auth.type !== 'oauth' || !isAuthFailure || !auth.refresh || cooldown.active()) {
      return { auth, response }
    }
    const next = await refreshAndPersist(auth)
    if (!next) {
      cooldown.markFailed()
      return { auth, response }
    }
    cooldown.markOk()
    return { auth: next, response: await requestWithAuth(init, next) }
  }

  /** 非 2xx：统一 Content-Type 为 JSON；body 已被消费时用循环内缓存的文本重建。 */
  async function normalizeErrorResponse(
    response: Response,
    lastText: string,
    init: RequestInit
  ): Promise<Response> {
    let text: string
    try {
      text = await response.text()
    } catch {
      text = response.status === 400 ? lastText : ''
    }
    if (text) return textResponse(text, response.status, response.headers)
    const message = init.signal?.aborted
      ? 'codebuddy: request aborted'
      : `codebuddy: upstream ${response.status} (unreadable body)`
    return jsonResponse({ error: { message } }, response.status, response.headers)
  }

  /** 上游会把模型的思考草稿混进 delta.content 并留下 `</think:会话id>` 闭合标记；
   *  pi-ai 只从 reasoning_content 建 thinking 块，故在 SSE 层把标记之前的文本改写过去。 */
  function rewriteSseIfNeeded(response: Response): Response {
    const isSse = isEventStreamResponse(response.headers.get('content-type'))
    if (!cfg.rewriteLeakedReasoning || !response.body || !isSse) return response
    const state = createLeakState()
    const wrapped = rewriteLeakedReasoningStream(response.body, state, (s) =>
      summarizeLeakRewrite(s, logger)
    )
    return new Response(wrapped as unknown as BodyInit, {
      status: response.status,
      statusText: response.statusText,
      headers: headersWithoutEntity(response.headers)
    })
  }

  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!resolveRequestUrl(url).includes(chatCompletionsPath)) return doFetch()(url, init)
    const auth = await getAuth()
    if (!auth) return unauthorizedResponse()
    if (!init?.body) return jsonResponse({ error: 'Missing request body' }, 400)

    const first = await requestWithAuth(init, auth)
    const retried = await refreshAndRetry(auth, first, init)
    let response = retried.response

    const ctx: RetryContext = {
      request: () => requestWithAuth(init, retried.auth),
      logger,
      signal: init.signal
    }
    const transient = await retryTransient400(response, cfg, ctx)
    response = transient.response
    if (response.status === 429) {
      const outcome = await handleRateLimit(response, cfg, ctx)
      if (outcome.response.status === 429) return rateLimitErrorResponse(outcome)
      response = outcome.response
    }
    if (!response.ok) return normalizeErrorResponse(response, transient.lastText, init)
    return rewriteSseIfNeeded(response)
  }
}
