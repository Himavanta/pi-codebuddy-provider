// 认证状态：模式选择与有效凭据解析
import type { CodeBuddyConfig } from './config.ts'

export type AuthState =
  | { type: 'api'; key: string }
  | { type: 'oauth'; access: string; refresh: string; expires: number }

export function pickAuthMode(
  cfg: Pick<CodeBuddyConfig, 'auth' | 'apiKey'>,
  stored: AuthState | undefined
): 'oauth' | 'api' {
  if (cfg.auth === 'api') return 'api'
  if (cfg.auth === 'oauth') return 'oauth'
  if (cfg.apiKey) return 'api'
  if (stored?.type === 'api' && stored.key) return 'api'
  return 'oauth'
}

export function effectiveAuth(
  stored: AuthState | undefined,
  cfg: Pick<CodeBuddyConfig, 'auth' | 'apiKey'>
): AuthState | null {
  const mode = pickAuthMode(cfg, stored)
  if (mode === 'api') {
    if (cfg.apiKey) return { type: 'api', key: cfg.apiKey }
    if (stored?.type === 'api' && stored.key) return { type: 'api', key: stored.key }
    return null
  }
  // oauth 单分支：expires 校验删除，过期仍返回，靠 401 兜底
  if (stored?.type === 'oauth' && stored.access) {
    return {
      type: 'oauth',
      access: stored.access,
      refresh: stored.refresh ?? '',
      expires: stored.expires ?? 0
    }
  }
  return null
}
