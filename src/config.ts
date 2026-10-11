// 运行时配置：环境变量解析、端点选择与常量
export const PROVIDER_ID = 'codebuddy'
export const CHAT_COMPLETIONS_PATH = '/v2/chat/completions'
export const PLATFORM = 'VSCode'
export const APP_VERSION = '4.9.29177644'
export const IDE_NAME = 'VSCode'
export const IDE_TYPE = 'VSCode'
export const IDE_VERSION = '1.119.0'
export const DOMAIN_DEFAULT = 'www.codebuddy.cn'
export const PRODUCT = 'SaaS'
export const AGENT_INTENT = 'craft'
export const ENV_ID = 'production'
export const DISCOVERY_TIMEOUT_MS = 5000
export const POLL_INTERVAL_MS = 3000
export const POLL_TIMEOUT_MS = 8000
export const POLL_TOTAL_TIMEOUT_MS = 10 * 60 * 1000
export const AUTH_STATE_TIMEOUT_MS = 5000
export const REFRESH_TIMEOUT_MS = 5000
export const DEFAULT_EXPIRES_MS = 24 * 60 * 60 * 1000
export const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000
/** 429 就地等待重发的默认预算（毫秒）：只在 Retry-After 提示不超过它时等待。 */
export const DEFAULT_429_MAX_WAIT_MS = 20_000
/** 429 就地重发次数默认值（不含首次请求）。 */
export const DEFAULT_429_RETRIES = 1

/** 服务器端点信息：解析后的基址（不含尾部斜杠）与所属域名。 */
export interface ServerInfo {
  url: string
  domain: string
}

export interface CodeBuddyConfig {
  endpoint?: string
  network: 'internal' | 'ioa' | 'internet'
  auth: 'auto' | 'oauth' | 'api'
  model?: string
  stableConversationId: boolean
  conversationMapMax: number
  tenantId?: string
  enterpriseId?: string
  userId?: string
  apiKey?: string
  platform: string
  appVersion: string
  ideName: string
  ideType: string
  ideVersion: string
  domain: string
  product: string
  agentIntent: string
  envId: string
  /** 归一化上游泄漏进 content 的思考文本（见 reasoning-leak.ts）。 */
  rewriteLeakedReasoning: boolean
  /** 429 就地等待上限（毫秒）；超过则不再等待，直接合成错误 body 交给上层。 */
  rateLimitMaxWaitMs: number
  /** 429 就地重发次数。 */
  rateLimitRetries: number
  /** 11133 瞬时 400 的最大重试次数（CODEBUDDY_TRANSIENT_400_RETRIES，默认 4，退避 1s/4s/10s/25s） */
  transient400Retries: number
}

function num(v: string | undefined, d: number): number {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n : d
}

export function getConfig(): CodeBuddyConfig {
  return {
    endpoint: process.env.CODEBUDDY_ENDPOINT || '',
    network: (
      process.env.CODEBUDDY_NETWORK || 'internal'
    ).toLowerCase() as CodeBuddyConfig['network'],
    auth: (process.env.CODEBUDDY_AUTH || 'auto').toLowerCase() as CodeBuddyConfig['auth'],
    model: process.env.CODEBUDDY_MODEL || '',
    stableConversationId: process.env.CODEBUDDY_STABLE_CONVERSATION !== '0',
    conversationMapMax: num(process.env.CODEBUDDY_CONVERSATION_MAP_MAX, 1000),
    tenantId: process.env.CODEBUDDY_TENANT_ID || '',
    enterpriseId: process.env.CODEBUDDY_ENTERPRISE_ID || '',
    userId: process.env.CODEBUDDY_USER_ID || '',
    apiKey: process.env.CODEBUDDY_API_KEY || '',
    transient400Retries: num(process.env.CODEBUDDY_TRANSIENT_400_RETRIES, 4),
    platform: PLATFORM,
    appVersion: APP_VERSION,
    ideName: IDE_NAME,
    ideType: IDE_TYPE,
    ideVersion: IDE_VERSION,
    domain: DOMAIN_DEFAULT,
    product: PRODUCT,
    agentIntent: AGENT_INTENT,
    envId: ENV_ID,
    rewriteLeakedReasoning: process.env.CODEBUDDY_LEAKED_REASONING !== '0',
    rateLimitMaxWaitMs: num(process.env.CODEBUDDY_429_MAX_WAIT_MS, DEFAULT_429_MAX_WAIT_MS),
    rateLimitRetries: num(process.env.CODEBUDDY_429_RETRIES, DEFAULT_429_RETRIES)
  }
}

export function domainForHost(url: string): string {
  try {
    return new URL(url).host.includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn'
  } catch {
    return url.includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn'
  }
}

export function resolveServerUrl(cfg: Pick<CodeBuddyConfig, 'endpoint' | 'network'>): ServerInfo {
  if (cfg.endpoint) {
    const url = cfg.endpoint.replace(/\/+$/, '')
    return { url, domain: domainForHost(url) }
  }
  if (cfg.network === 'internal' || cfg.network === 'ioa')
    return { url: 'https://copilot.tencent.com', domain: 'www.codebuddy.cn' }
  return { url: 'https://www.codebuddy.ai', domain: 'www.codebuddy.ai' }
}
