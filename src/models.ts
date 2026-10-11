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
    effort?: string
    defaultEffort?: string
    supportedEfforts?: string[]
    canDisableThinking?: boolean
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

/** 带 status 的发现错误：401/403 上抛给调用方决定是否提示重新登录。 */
function discoveryError(status: number): Error & { status?: number } {
  const e = new Error(`discovery ${status}`) as Error & { status?: number }
  e.status = status
  return e
}

/** 按 craft agent 的模型清单筛选：保留清单内、存在且支持工具调用的模型。 */
function selectCraftModels(data: NonNullable<RemoteConfigResponse['data']>): RemoteModel[] {
  const modelMap = new Map((data.models ?? []).map((m) => [m.id, m]))
  const craftAgent = (data.agents ?? []).find((a) => a.name === AGENT_INTENT)
  const craftIds = craftAgent?.models ?? []
  if (craftIds.length === 0) return [DEFAULT_MODEL]
  return craftIds
    .map((id) => modelMap.get(id))
    .filter((m): m is RemoteModel => m !== undefined && m.supportsToolCall !== false)
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
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw discoveryError(res.status)
    return []
  }
  const body = res.data
  if (!body || body.code !== 0 || !body.data) return []
  return selectCraftModels(body.data)
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

/**
 * 按上游 supportedEfforts 构建 pi 的 thinkingLevelMap。
 *
 * pi 语义是「pi 档位 → 上游取值」的映射，不是可用档位枚举；键必须是 pi 档位，
 * 值才是上游取值。官方模型目录（dist/providers/data/*.json，773 个样例）同样惯例：
 * 只列出需要声明的档位，不支持的档位写 null。
 *
 * 返回 undefined 表示无档位信息（上游未公布词表）。
 */
export function buildThinkingLevelMap(m: RemoteModel): Record<string, string | null> | undefined {
  const efforts = m.reasoning?.supportedEfforts
  if (!efforts?.length) return undefined
  const supported = new Set(efforts)
  const map: Record<string, string | null> = {}
  // off：仅当上游允许关闭思考（canDisableThinking）时才可选；否则显式 null 移除。
  // 注意离开时不携带 reasoning_effort（pi-ai 仅在 map.off 为字符串时才发送）。
  if (m.reasoning?.canDisableThinking !== true) map.off = null
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
  const efforts = m.reasoning?.supportedEfforts
  const thinkingLevelMap = cfg.reasoning ? buildThinkingLevelMap(m) : undefined
  if (thinkingLevelMap) cfg.thinkingLevelMap = thinkingLevelMap
  // 只有上游公布 effort 词表时才下发 reasoning_effort：网关对未收录参数返回 400（同
  // supportsDeveloperRole 那段注释），词表未知时保持与今天完全一致的请求形状。
  if (cfg.reasoning && !efforts?.length) {
    cfg.compat = { ...cfg.compat, supportsReasoningEffort: false }
  }
  return cfg
}

/** 发现失败的认证类错误（401/403）：调用方据此提示重新登录，不做降级缓存。 */
function isAuthError(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status
  return status === 401 || status === 403
}

export class DiscoveryCache {
  private data: RemoteModel[] | null = null
  private fetchedAt = 0
  private inflight: Promise<RemoteModel[] | null> | null = null
  constructor(
    private readonly opts: {
      ttlMs: number
      fetchFn: (token: string, signal?: AbortSignal) => Promise<RemoteModel[]>
    }
  ) {}
  /** 返回 null 表示本次为瞬时失败降级：调用方应保留现有模型列表/缓存，不要用 [auto] 兜底覆盖 */
  async get(token: string, { signal }: { signal?: AbortSignal }): Promise<RemoteModel[] | null> {
    const now = Date.now()
    if (this.data && now - this.fetchedAt < this.opts.ttlMs) return this.data
    if (this.inflight) return this.inflight
    this.inflight = this.opts
      .fetchFn(token, signal)
      .then((d) => {
        this.data = d
        this.fetchedAt = Date.now()
        return d
      })
      .catch((e: unknown) => {
        if (isAuthError(e)) throw e
        // 瞬时失败（网络/超时/5xx）：返回 null 信号降级，不把 [DEFAULT_MODEL] 当成功结果缓存
        // —— 否则一次网络抖动会把磁盘上 15 个真实模型的缓存覆盖成只有 auto，且 5min TTL 内不再重试
        return null
      })
      .finally(() => {
        this.inflight = null
      })
    if (this.data) {
      this.inflight.catch(() => {})
      return this.data
    }
    return this.inflight
  }
}
