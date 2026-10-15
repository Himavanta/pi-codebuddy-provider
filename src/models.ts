// 模型发现与能力映射：/v3/config → Pi 模型配置

import {
  AGENT_INTENT,
  DISCOVERY_TIMEOUT_MS,
  IDE_NAME,
  IDE_TYPE,
  IDE_VERSION,
  APP_VERSION,
  ENV_ID,
  PRODUCT
} from './config.ts'
import type { ServerInfo } from './config.ts'
import { fetchJson } from './fetch-json.ts'
import { formatUpstreamError, parseUpstreamError } from './upstream-error.ts'

export interface RemoteModel {
  id: string
  name: string
  maxInputTokens?: number
  maxOutputTokens?: number
  maxAllowedSize?: number
  supportsToolCall?: boolean
  supportsImages?: boolean
  supportsReasoning?: boolean
  disabledMultimodal?: boolean
  reasoning?: {
    /** 只有该字段时（无 supportedEfforts）：上游声明的默认档，也是唯一可用档 */
    effort?: string
    defaultEffort?: string
    supportedEfforts?: string[]
    canDisableThinking?: boolean
    /** 上游固定的思考摘要提示（实测恒为 auto），pi 无对应字段，仅保持类型如实 */
    summary?: string
  }
  contextWindow?: { defaultLength?: number; supportedLengths?: number[] }
}
export const DEFAULT_MODEL: RemoteModel = {
  id: 'auto',
  name: 'Auto',
  maxInputTokens: 168000,
  maxOutputTokens: 32000,
  supportsToolCall: true
}

export interface PiModelConfig {
  id: string
  name: string
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
  contextWindow: number
  maxTokens: number
  thinkingLevelMap?: Record<string, string | null>
  compat?: {
    supportsDeveloperRole?: boolean
    supportsReasoningEffort?: boolean
    /** 上游 11155：带 tools 的请求要求历史 assistant 回传 reasoning_content，缺字段时补空串 */
    requiresReasoningContentOnAssistantMessages?: boolean
  }
}

export interface RemoteConfigResponse {
  code: number
  msg?: string
  displayMsg?: Record<string, unknown>
  data?: { agents?: Array<{ name: string; models?: string[] }>; models?: RemoteModel[] }
}
/** /v3/config 发现的请求头（认证 Bearer + IDE 标识）。 */
function discoveryHeaders(accessToken: string, domain: string): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    Authorization: `Bearer ${accessToken}`,
    'X-Agent-Intent': AGENT_INTENT,
    'X-IDE-Type': IDE_TYPE,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': ENV_ID,
    'X-Domain': domain,
    'X-Product': PRODUCT,
    'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`
  }
}

/** 发现失败：带 status 与可读原因，供调用方区分「重新登录」与其他失败。 */
export class DiscoveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly upstreamCode?: number | string
  ) {
    super(message)
    this.name = 'DiscoveryError'
  }
}

/**
 * 按 craft agent 的模型清单筛选：保留清单内、存在且支持工具调用的模型。
 *
 * 返回空数组表示响应可用但拿不到模型，由调用方决定是否降级：
 * 无效 token 会得到 HTTP 200 / code 0，但 data.agents 与 data.models 均为 null
 * （与有效响应的字段形状不同），必须当失败处理，不能退回 [DEFAULT_MODEL]。
 */
function selectCraftModels(data: NonNullable<RemoteConfigResponse['data']>): RemoteModel[] {
  const modelMap = new Map((data.models ?? []).map((m) => [m.id, m]))
  const craftAgent = (data.agents ?? []).find((a) => a.name === AGENT_INTENT)
  const craftIds = craftAgent?.models ?? []
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false)
}

/** 把 HTTP 失败响应转成 DiscoveryError（带上游错误码与可读文案）。 */
function httpFailure(res: { status?: number; text: string }): DiscoveryError {
  const info = parseUpstreamError(res.text)
  const message =
    res.status === undefined
      ? `model discovery: ${res.text}`
      : formatUpstreamError(info, res.status, res.text)
  return new DiscoveryError(message, res.status, info.code)
}

/** body.code !== 0 或缺少 data：HTTP 200 但业务失败 */
function payloadFailure(body: RemoteConfigResponse): DiscoveryError {
  const info = parseUpstreamError(JSON.stringify(body))
  const code = body.code
  const reason = info.display ?? info.msg ?? info.tips ?? '缺少 data'
  return new DiscoveryError(
    `model discovery 响应异常（上游错误码 ${code}）：${reason}`,
    undefined,
    code
  )
}

export async function fetchRemoteModels(
  accessToken: string,
  server: ServerInfo,
  signal?: AbortSignal
): Promise<RemoteModel[]> {
  const res = await fetchJson<RemoteConfigResponse>(`${server.url}/v3/config`, {
    headers: discoveryHeaders(accessToken, server.domain),
    timeoutMs: DISCOVERY_TIMEOUT_MS,
    signal
  })
  // 失败一律抛出，不返回空列表：空列表会被调用方当成「发现成功但模型数为 0」，
  // 而这是失败，应当降级并保留现有缓存（见 DiscoveryCache.get）。
  if (!res.ok) throw httpFailure(res)
  const body = res.data
  if (!body || body.code !== 0 || !body.data) throw payloadFailure(body ?? { code: 0 })
  const models = selectCraftModels(body.data)
  if (models.length === 0) {
    // 拿不到任何模型：鉴权无效时上游仍回 200/code 0，但 agents 与 models 均为 null。
    // 当作失败降级，避免把「只有 auto」当成发现结果写进缓存。
    throw new DiscoveryError('model discovery 未返回任何模型（凭据可能已失效，请重新登录）')
  }
  return models
}

const DEFAULT_CONTEXT = 131_072
const DEFAULT_MAX_TOKENS = 8192

// pi 的思考档位是固定集合（pi-ai models.js::getSupportedThinkingLevels）：
//   - off / minimal / low / medium / high：默认全部可用，除非在 map 中显式写 null
//   - xhigh / max：必须在 map 中有条目才可见
// 发送时按 `thinkingLevelMap[level] ?? level` 取值，因此上游不支持的档位必须显式 null
// 移出可选集合，否则会在 UI 暴露、并被原样当作 reasoning_effort 发给上游。
const PI_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'] as const
const PI_EXTENDED_LEVELS = ['xhigh', 'max'] as const
/** pi 全部档位（不含 off）：「只有 effort」时用它判断 effort 是否为可表达的档位名 */
const PI_KNOWN_LEVELS: readonly string[] = [...PI_THINKING_LEVELS, ...PI_EXTENDED_LEVELS]

/**
 * 按上游声明构建 pi 的 thinkingLevelMap。
 *
 * pi 语义是「pi 档位 → 上游取值」的映射，不是可用档位枚举；键必须是 pi 档位，
 * 值才是上游取值。官方模型目录（dist/providers/data/*.json，773 个样例）同样惯例：
 * 只列出需要声明的档位，不支持的档位写 null。
 *
 * 上游 reasoning 有两种形态：
 *   - supportedEfforts：完整词表（含 canDisableThinking / defaultEffort）
 *   - effort：仅声明一个默认档，无词表
 *
 * 词表缺失时用 effort 兜底：只暴露声明的那一档，其余（含 off）显式 null。
 * 上游「不发 reasoning_effort 即 400」（glm-5.1 code 11150）正是被这种模型触发的，
 * 而 effort 是其唯一可用的声明，丢弃它只能得到 400。同时不替上游扩展：
 * 只声明一个档位的模型就只给一个档位。
 *
 * effort 不在 pi 档位集合内时返回 undefined（无法表达即不声明），
 * 否则会产出「全档位皆 null」的空 map——pi 会退回 off，反而丢掉该档。
 */
export function buildThinkingLevelMap(m: RemoteModel): Record<string, string | null> | undefined {
  const wordList = m.reasoning?.supportedEfforts
  const effort = m.reasoning?.effort
  const efforts = wordList?.length
    ? wordList
    : effort && PI_KNOWN_LEVELS.includes(effort)
      ? [effort]
      : undefined
  if (!efforts?.length) return undefined
  const supported = new Set(efforts)
  const map: Record<string, string | null> = {}
  // off：仅当上游公开词表且允许关闭思考时才可选，否则显式 null 移出可选集合。
  // 只有 effort 时上游未声明可关闭，一律移出（不能切换档位）。
  // 注意离开时不携带 reasoning_effort（pi-ai 仅在 map.off 为字符串时才发送）。
  if (!wordList?.length || m.reasoning?.canDisableThinking !== true) map.off = null
  for (const level of PI_THINKING_LEVELS) {
    map[level] = supported.has(level) ? level : null
  }
  // xhigh / max：无条目即不可见，仅在支持时写入
  for (const level of PI_EXTENDED_LEVELS) {
    if (supported.has(level)) map[level] = level
  }
  return map
}

function detectThinking(id: string): boolean {
  // hy\d：混元 3/4/… 都带思考通道。写死 hy3 会让 hy4-preview 被误判为非推理模型，
  // 于是 pi 侧既不给它 thinking 档位、也无从归一化上游泄漏到 content 里的思考草稿（见 reasoning-leak.ts）。
  return /claude|gemini|gpt-5|hy\d|deepseek|glm/i.test(id)
}

function detectImages(id: string): boolean {
  return /claude|gemini|gpt/i.test(id)
}

/**
 * 解析上游 context 容量。
 *
 * 上游字段有两种形态（实测 /v3/config）：
 *   - 数字：maxAllowedSize / maxInputTokens
 *   - 对象：contextWindow = { defaultLength, supportedLengths }——IDE 里可选的长度档
 *
 * pi 的 contextWindow 是单一容量（用于自动压缩阈值），对象形态取
 * supportedLengths 的最大值（与 maxAllowedSize 语义一致）。
 * 对象显式声明了上下文长度，优先于通用的 maxAllowedSize。
 *
 * 注：另一种可选解读是取 defaultLength（上游默认档，实测为 300000），
 * 会让 pi 更早触发自动压缩、降低每轮重发量，但会改变现有行为，待定。
 * 见 docs/03-执行计划.md 待决事项。
 */
function resolveContextWindow(m: RemoteModel): number {
  const cw = m.contextWindow
  if (cw && typeof cw === 'object') {
    const lengths = Array.isArray(cw.supportedLengths) ? cw.supportedLengths : []
    const max = Math.max(
      ...lengths.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0),
      0
    )
    if (max > 0) return max
    if (
      typeof cw.defaultLength === 'number' &&
      Number.isFinite(cw.defaultLength) &&
      cw.defaultLength > 0
    ) {
      return cw.defaultLength
    }
  }
  return m.maxAllowedSize ?? m.maxInputTokens ?? DEFAULT_CONTEXT
}

/** 网关 /v3/config 的 supportsImages 优先；仅当字段缺失时回退到 ID 猜测。
 *  本地补丁 (2026-09-21)：原实现只用白名单正则，导致 deepseek/glm-5.3/kimi/minimax
 *  等网关标了 supportsImages=true 的模型在 pi 侧只剩 ["text"]，图片被替换成占位符。 */
export function modelSupportsImages(m: RemoteModel): boolean {
  if (m.disabledMultimodal) return false
  if (typeof m.supportsImages === 'boolean') return m.supportsImages
  return detectImages(m.id)
}

/** RemoteModel → Pi ProviderModelConfig 所需字段 */
export function remoteModelToPi(m: RemoteModel): PiModelConfig {
  const contextWindow = resolveContextWindow(m)
  const maxTokens = m.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  const cfg: PiModelConfig = {
    id: m.id,
    name: m.name,
    // 上游明确 false 时以 false 为准；true 或字段缺失时回退到 ID 猜测（此前 true 也会被 ID 猜测覆盖掉）。
    reasoning:
      m.supportsReasoning === false ? false : m.supportsReasoning === true || detectThinking(m.id),
    input: modelSupportsImages(m) ? ['text', 'image'] : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // CodeBuddy 网关不接受 assistant-role 之外的 system→developer 角色：pi-ai 对
    // reasoning 模型默认发 role:"developer" 承载 systemPrompt，网关返回 400 (code 11128)，
    // 且 body 无 error 字段 → OpenAI SDK 报 "400 status code (no body)"。强制回退 system。
    //
    // requiresReasoningContentOnAssistantMessages：上游 11155 —— 带 tools 的请求要求历史
    // assistant 消息回传 reasoning_content，但部分模型可跳过推理（canDisableThinking）
    // → 无内容可回传 → 400。pi-ai 原生会在该字段缺失时补空串（仅在 model.reasoning 为真时
    // 生效，且不覆盖已有 thinking 内容），无需手改 body。
    compat: { supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true }
  }
  const thinkingLevelMap = cfg.reasoning ? buildThinkingLevelMap(m) : undefined
  if (thinkingLevelMap) cfg.thinkingLevelMap = thinkingLevelMap
  // 档位信息完全缺失时才禁发 reasoning_effort：既无 supportedEfforts 也无 effort，
  // 无从判断上游接受哪些值，保持请求形状不变（同 supportsDeveloperRole 那段注释）。
  if (cfg.reasoning && !thinkingLevelMap) {
    cfg.compat = { ...cfg.compat, supportsReasoningEffort: false }
  }
  return cfg
}

/** 发现失败的认证类错误（401/403）：调用方据此提示重新登录，不做降级缓存。 */
function isAuthError(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status
  return status === 401 || status === 403
}

export { isAuthError }

/**
 * 失败冷却窗口：覆盖同一次启动中多个触发点先后调用的情况，
 * 又短到用户重开一次 pi（或 /reload）就会重新尝试。
 */
export const FAILURE_COOLDOWN_MS = 60_000

export class DiscoveryCache {
  private data: RemoteModel[] | null = null
  private fetchedAt = 0
  private inflight: Promise<RemoteModel[] | null> | null = null
  /** 上次失败的时间；用于失败冷却（见 get） */
  private failedAt = 0
  constructor(
    private readonly opts: {
      ttlMs: number
      fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>
      /** 降级时回调失败原因（缓存本身只返回 null 信号，原因会在此透出给日志） */
      onFailure?: (error: unknown) => void
    }
  ) {}
  /**
   * 是否处于失败冷却期。
   *
   * 失败不能像成功那样用 ttlMs 兜住（那会把一次网络抖动固化 5min），但完全不记
   * 也不行：交互式启动会有**两个**触发点先后调到这里（本扩展的 session_start 后台
   * 发现，以及 pi 自己在 interactive-mode.js 里的 refreshModelCatalogs），离线时
   * 两次都会真发请求、各报一条相同的警告。
   * 用较短的冷却窗口让第二个调用点静默复用失败结论，既不重复请求也不重复提示，
   * 且冷却过后仍会重试（不会像成功缓存那样卡住）。
   */
  private inFailureCooldown(now: number): boolean {
    return this.failedAt > 0 && now - this.failedAt < FAILURE_COOLDOWN_MS
  }
  /** 返回 null 表示本次为瞬时失败降级：调用方应保留现有模型列表/缓存，不要用 [auto] 兜底覆盖 */
  async get(token: string, { signal }: { signal?: AbortSignal }): Promise<RemoteModel[] | null> {
    const now = Date.now()
    if (this.data && now - this.fetchedAt < this.opts.ttlMs) return this.data
    if (this.inflight) return this.awaitInflight(this.inflight)
    // 冷却期内：有旧数据就用旧数据，没有则返回 null（降级但不再请求、不再提示）
    if (this.inFailureCooldown(now)) return this.data
    this.inflight = this.opts
      .fetchFn(token, signal)
      .then((d) => {
        this.data = d
        this.fetchedAt = Date.now()
        this.failedAt = 0
        return d
      })
      .catch((e: unknown) => {
        // 先记失败时间：认证失败也要进冷却，否则两个触发点会各提示一次
        // 「登录已失效」。冷却期内的后续调用返回旧数据（降级），不再上报。
        this.failedAt = Date.now()
        // 认证失败仍上抛：调用方据此提示重新登录，且不做成功降级
        if (isAuthError(e)) throw e
        // 瞬时失败（网络/超时/5xx/上游业务错误）：返回 null 信号降级，
        // 不把 [DEFAULT_MODEL] 当成功结果缓存——否则一次网络抖动会把磁盘上
        // 15 个真实模型的缓存覆盖成只有 auto。
        this.opts.onFailure?.(e)
        return null
      })
      .finally(() => {
        this.inflight = null
      })
    return this.awaitInflight(this.inflight)
  }
  /**
   * 等待在途请求，失败时兑回旧数据。
   *
   * 直接 return inflight 会让失败期间仍在途的并发调用拿到 null，即使手上有旧数据
   * （stale-while-revalidate 的意图就落空了）。
   * 不吞异常：401/403 由 inflight 上抛，必须继续传给调用方（见 isAuthError）。
   * 不引 onFailure：它已在请求自己的 catch 里报过一次，此处只是另一个等待者。
   */
  private async awaitInflight(
    inflight: Promise<RemoteModel[] | null>
  ): Promise<RemoteModel[] | null> {
    return (await inflight) ?? this.data
  }
}
