// OAuth 流程：申请 state、轮询 token、刷新 token

import {
  AUTH_STATE_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  PLATFORM
} from './config.ts'
import { fetchJson } from './fetch-json.ts'

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export interface TokenPair {
  accessToken: string
  refreshToken?: string
  expiresIn?: number
}

/** 上游 token 接口的响应体形状（申请 / 轮询 / 刷新三处共用）。 */
interface TokenResponseBody {
  code: number
  data?: TokenPair
}

/** 无需认证的请求头（凭据交换类接口）。 */
function noAuthHeaders(): Record<string, string> {
  return {
    Accept: 'application/json',
    'X-No-Authorization': 'true',
    'X-No-User-Id': 'true',
    'X-No-Enterprise-Id': 'true',
    'X-No-Department-Info': 'true'
  }
}

export async function requestAuthState(serverUrl: string): Promise<{ state: string; url: string }> {
  const url = `${serverUrl}/v2/plugin/auth/state?platform=${PLATFORM}&ioa=1`
  const res = await fetchJson<{ code: number; data?: { state: string; authUrl?: string } }>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...noAuthHeaders() },
    timeoutMs: AUTH_STATE_TIMEOUT_MS
  })
  if (!res.ok || res.data.code !== 0 || !res.data.data?.state)
    throw new Error(`Auth state failed: ${JSON.stringify(res)}`)
  const { state, authUrl } = res.data.data
  return {
    state,
    url: authUrl || `${serverUrl}/login?platform=${PLATFORM}&state=${state}&ioa=1`
  }
}

/** 轮询一次 token 接口；未就绪（code 非 0 / 无 accessToken）返回 null。 */
async function fetchTokenOnce(
  serverUrl: string,
  state: string,
  signal?: AbortSignal
): Promise<TokenPair | null> {
  const res = await fetchJson<TokenResponseBody>(
    `${serverUrl}/v2/plugin/auth/token?state=${state}`,
    { method: 'GET', headers: noAuthHeaders(), timeoutMs: POLL_TIMEOUT_MS, signal }
  )
  if (res.ok && res.data.code === 0 && res.data.data?.accessToken) return res.data.data
  return null
}

export async function pollForToken(opts: {
  serverUrl: string
  state: string
  expiresAt: number
  signal?: AbortSignal
}): Promise<TokenPair | null> {
  const { serverUrl, state, expiresAt, signal } = opts
  // 先查后睡：首次立即查，失败后 sleep 再查
  while (Date.now() < expiresAt) {
    if (signal?.aborted) return null
    const token = await fetchTokenOnce(serverUrl, state, signal)
    if (token) return token
    if (signal?.aborted) return null
    // fetchJson 最长耗时 POLL_TIMEOUT_MS：await 后可能已越过 expiresAt，
    // 此时直接退出，避免再多睡一轮 POLL_INTERVAL_MS。
    if (Date.now() >= expiresAt) break
    await sleep(POLL_INTERVAL_MS)
  }
  return null
}

export async function refreshAccessToken(
  refreshToken: string,
  serverUrl: string
): Promise<TokenPair | null> {
  const res = await fetchJson<TokenResponseBody>(
    `${serverUrl}/v2/plugin/auth/token/refresh`,
    // refreshToken 必须放在 X-Refresh-Token 头里：上游只认这个（官方 CLI 也是这么发的）。
    // 用 `Authorization: Bearer <refreshToken>` 会被回 `400 code 10001 refreshToken is empty`，
    // 导致登录态到期后三条刷新路径（Pi 预刷新 / oauth.refreshToken / 401 兜底）全部失效。
    // X-Auth-Refresh-Source 与官方 CLI 保持一致。
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Refresh-Token': refreshToken,
        'X-Auth-Refresh-Source': 'plugin'
      },
      timeoutMs: REFRESH_TIMEOUT_MS
    }
  )
  if (!res.ok || res.data.code !== 0) return null
  return res.data.data ?? null
}
