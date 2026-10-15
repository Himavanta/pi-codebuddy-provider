// Pi 扩展入口：注册 codebuddy provider（HTTP 直连 /v2/chat/completions）
//
// 数据流：
//   Pi agent → modelRuntime.streamSimple（auth 解析 + headers 合并）
//     → streamSimple wrapper（注入 22 头 + 自定义 fetch）
//     → auth-fetch 拦截器（认证头注入 + 401/403 刷新重试 + 11133/429 重试）
//     → ${server}/v2/chat/completions

import * as fs from 'fs/promises'
import { homedir } from 'os'
import { join, dirname } from 'path'

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  RefreshModelsContext
} from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { CONFIG_DIR_NAME } from '@earendil-works/pi-coding-agent'

import { createAuthFetch } from './auth-fetch.ts'
import { requestAuthState, pollForToken, refreshAccessToken, type TokenPair } from './auth-flow.ts'
import { effectiveAuth, pickAuthMode } from './auth-state.ts'
import type { AuthState } from './auth-state.ts'
import {
  getConfig,
  resolveServerUrl,
  PROVIDER_ID,
  CHAT_COMPLETIONS_PATH,
  POLL_TOTAL_TIMEOUT_MS,
  DEFAULT_EXPIRES_MS,
  DISCOVERY_CACHE_TTL_MS
} from './config.ts'
import { buildRequestHeaders, buildAuthHeaders } from './headers.ts'
import { resolveIdentity, decodeJwtPayload } from './jwt.ts'
import { createLogger } from './log.ts'
import { LRUMap } from './lru.ts'
import { readCachedModels, writeCachedModels } from './model-cache.ts'
import {
  fetchRemoteModels,
  remoteModelToPi,
  DEFAULT_MODEL,
  DiscoveryCache,
  isAuthError,
  type PiModelConfig,
  type RemoteModel
} from './models.ts'
import { createCodebuddyStreamSimple } from './stream.ts'

export default async function codebuddyExtension(pi: ExtensionAPI) {
  const cfg = getConfig()
  const server = resolveServerUrl(cfg)
  const logger = createLogger()
  const conversationIds = new LRUMap<string, string>(cfg.conversationMapMax)
  const discoveryCache = new DiscoveryCache({
    ttlMs: DISCOVERY_CACHE_TTL_MS,
    fetchFn: (token, signal) => fetchRemoteModels(token, server, signal),
    // 降级的原因只在缓存内部被转成 null 信号，在此透出给日志（见 logDiscoveryFailure）
    onFailure: (e) => logDiscoveryFailure(e)
  })

  // --- token 快照（~/.pi/agent/codebuddy-auth.json）---
  // Pi CredentialStore 不对扩展暴露读取接口；login/refresh 全部经过本扩展，
  // 顺手落一份独立快照供请求时读取。真实凭据源仍是 Pi auth.json（由 Pi 自动持久化）。
  const snapshotPath = join(homedir(), CONFIG_DIR_NAME || '.pi', 'agent', 'codebuddy-auth.json')
  const syncSnapshot: { value: OAuthCredentials | undefined } = { value: undefined }

  async function loadSnapshot(): Promise<void> {
    try {
      const raw = await fs.readFile(snapshotPath, 'utf8')
      const o = JSON.parse(raw) as Partial<OAuthCredentials>
      if (typeof o.access === 'string' && o.access) {
        syncSnapshot.value = {
          access: o.access,
          refresh: o.refresh ?? '',
          expires: o.expires ?? 0
        }
      }
    } catch {
      /* 不存在或损坏 → 未登录 */
    }
  }
  await loadSnapshot()

  async function persistSnapshot(cred: OAuthCredentials): Promise<void> {
    syncSnapshot.value = cred
    try {
      await fs.mkdir(dirname(snapshotPath), { recursive: true })
      // 原子写（tmp + rename）：与 model-cache 一致，避免崩溃/并发读到半截 JSON；
      // mode 0600：文件含 access + refresh token，不允许其他用户读取
      const tmp = `${snapshotPath}.tmp`
      await fs.writeFile(tmp, JSON.stringify(cred, null, 2), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmp, snapshotPath)
    } catch (e) {
      logger.error(`snapshot write failed: ${(e as Error).message}`)
    }
  }

  function credToAuthState(cred: OAuthCredentials | undefined): AuthState | undefined {
    if (!cred) return undefined
    return {
      type: 'oauth',
      access: cred.access,
      refresh: cred.refresh ?? '',
      expires: cred.expires ?? 0
    }
  }

  // TokenPair → OAuthCredentials 统一转换（登录/刷新/兜底刷新三处共用）
  function tokenPairToCred(pair: TokenPair, fallbackRefresh: string): OAuthCredentials {
    return {
      access: pair.accessToken,
      refresh: pair.refreshToken || fallbackRefresh,
      expires: pair.expiresIn ? Date.now() + pair.expiresIn * 1000 : Date.now() + DEFAULT_EXPIRES_MS
    }
  }

  // --- 刷新（auth-fetch 401 兜底用）：单飞 + 写快照 ---
  // Pi 原生 refreshToken 仅在 resolveStoredOAuth 过期路径触发；流中途 401 由这里兜底
  class RefreshLock {
    private inflight: Promise<AuthState | null> | null = null
    run(fn: () => Promise<AuthState | null>): Promise<AuthState | null> {
      if (this.inflight) return this.inflight
      this.inflight = fn().finally(() => {
        this.inflight = null
      })
      return this.inflight
    }
  }
  const refreshLock = new RefreshLock()

  async function refreshAndPersist(
    oauthAuth: AuthState & { type: 'oauth' }
  ): Promise<AuthState | null> {
    return refreshLock.run(async () => {
      const r = await refreshAccessToken(oauthAuth.refresh, server.url)
      if (r?.accessToken) {
        const cred = tokenPairToCred(r, oauthAuth.refresh)
        await persistSnapshot(cred)
        return credToAuthState(cred)!
      }
      logger.warn('token refresh failed — token may be expired, re-run /login codebuddy')
      return null
    })
  }

  // --- auth-fetch 拦截器 + streamSimple wrapper ---
  const authFetch = createAuthFetch({
    getAuth: async () => effectiveAuth(credToAuthState(syncSnapshot.value), cfg),
    server,
    buildAuthHeaders,
    resolveIdentity,
    decodeJwtPayload,
    refreshAndPersist,
    cfg,
    logger,
    chatCompletionsPath: CHAT_COMPLETIONS_PATH
  })
  const streamSimple = createCodebuddyStreamSimple(authFetch, {
    buildHeaders: (model, options) =>
      buildRequestHeaders(options?.sessionId, model.id, { cfg, server, lru: conversationIds })
  })

  // --- 模型列表 ---
  function modelsFromRemote(remote: RemoteModel[]) {
    return remote.map(remoteModelToPi)
  }
  function fallbackModels() {
    return modelsFromRemote([DEFAULT_MODEL])
  }
  // 启动种子：优先用上次落盘的模型列表，避免会话恢复时模型还没发现完（见 model-cache.ts）
  // 刻意不打日志：命中缓存是常规路径，每次启动都打印会污染 TUI/print 输出
  const cachedModels = await readCachedModels()
  let registeredModels = cachedModels.length ? cachedModels : fallbackModels()

  /**
   * 发现模型并转为 Pi 模型配置。
   * 返回 null 表示「未取得可用列表」（瞬时失败降级，或上游返回空），
   * 调用方应保留现有 registeredModels 与磁盘缓存，不要用 [auto] 兜底覆盖。
   * 401/403 会照常上抛，由调用方决定如何提示。
   */
  async function discoverModels(
    token: string,
    signal?: AbortSignal
  ): Promise<PiModelConfig[] | null> {
    const remote = await discoveryCache.get(token, { signal })
    if (!remote) return null
    const models = modelsFromRemote(remote)
    return models.length ? models : null
  }

  /** 发现失败的提示：认证类让用户重新登录，其余说明列表未更新并带上原因 */
  function logDiscoveryFailure(e: unknown): void {
    const message = e instanceof Error ? e.message : String(e)
    if (isAuthError(e)) {
      logger.warn('CodeBuddy 登录已失效，模型列表未更新 — 请重新 /login codebuddy')
    } else {
      logger.warn(`CodeBuddy 模型列表未更新，沿用本地缓存：${message}`)
    }
  }

  // 会话代次：session_shutdown 时 +1，用于丢弃上一个会话遗留的后台发现回调。
  // 不这么做的话，reload 前发起的发现会在新会话里重新注册模型（旧列表覆盖新会话），
  // 且在 ctx 失效后输出提示。
  let sessionGen = 0

  // 主动发现 + 重注册（registerProvider 可随时调用并立即生效）
  // 返回 false 表示发现降级：保留现有 registeredModels 与磁盘缓存
  async function discoverAndReregister(token: string, gen = sessionGen): Promise<boolean> {
    try {
      const models = await discoverModels(token)
      if (!models || gen !== sessionGen) return false
      registeredModels = models
      register(models)
      await writeCachedModels(models)
      return true
    } catch (e) {
      // 会话已切换时它的失败提示已无意义，且 ctx 已失效（见 session_shutdown）
      if (gen === sessionGen) logDiscoveryFailure(e)
      return false
    }
  }

  function register(models: typeof registeredModels) {
    pi.registerProvider(PROVIDER_ID, {
      name: 'CodeBuddy',
      baseUrl: `${server.url}/v2`,
      api: 'openai-completions',
      // 认证统一由 auth-fetch 拦截器注入（oauth 双头身份 + api 双头 key）；
      // apiKey 仅作为 OpenAI client 的占位（拦截器会覆写 Authorization）
      apiKey: cfg.apiKey || 'not-used',
      models,
      streamSimple,
      oauth: {
        name: 'CodeBuddy (IOA)',
        async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
          const state = await requestAuthState(server.url)
          callbacks.onAuth({ url: state.url, instructions: '请在浏览器中完成 IOA 登录' })
          const expiresAt = Date.now() + POLL_TOTAL_TIMEOUT_MS
          const tok = await pollForToken({
            serverUrl: server.url,
            state: state.state,
            expiresAt,
            signal: callbacks.signal
          })
          if (!tok?.accessToken) throw new Error('CodeBuddy IOA login failed or timed out')
          const cred = tokenPairToCred(tok, '')
          await persistSnapshot(cred)
          // 登录后立即发现模型并重注册（Pi 的 credential-change refresh 走 allowNetwork:false，不触发网络发现）
          void discoverAndReregister(cred.access)
          return cred
        },
        async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
          if (!credentials.refresh) throw new Error('codebuddy: no refresh token stored')
          const r = await refreshAccessToken(credentials.refresh, server.url)
          if (!r?.accessToken)
            throw new Error('codebuddy: token refresh failed — re-run /login codebuddy')
          const cred = tokenPairToCred(r, credentials.refresh)
          await persistSnapshot(cred)
          return cred
        },
        getApiKey(credentials: OAuthCredentials): string {
          return credentials.access
        }
      },
      refreshModels: async (context: RefreshModelsContext) => {
        // Pi 允许网络时按凭据发现；登录后的 credential-change 刷新 allowNetwork=false，走 fallback
        // 注：此处不调用 register()。返回值会由 Pi 用于更新模型表，重复注册反而多余。
        const cred = context.credential?.type === 'oauth' ? context.credential : undefined
        if (cred?.access && context.allowNetwork) {
          try {
            const models = await discoverModels(cred.access, context.signal)
            if (models) {
              registeredModels = models
              await writeCachedModels(models)
              return models
            }
          } catch (e) {
            logDiscoveryFailure(e)
          }
        }
        return registeredModels
      }
    })
  }

  register(registeredModels)

  const mode = pickAuthMode(cfg, credToAuthState(syncSnapshot.value))
  const startupToken = mode === 'oauth' ? syncSnapshot.value?.access : undefined

  // 首次启动（无落盘缓存）才等待发现：否则 --list-models 这类短命进程会在 /v3/config
  // 返回前退出，缓存永远写不进（pi 会等待异步 factory，见 extensions.md）。
  // 有缓存则立即返回、不阻塞启动，交给下面的 session_start 后台刷新。
  if (startupToken && cachedModels.length === 0) {
    await discoverAndReregister(startupToken)
  }
  if (mode === 'api' && !cfg.apiKey) {
    logger.warn('api key mode requested but no key found — set CODEBUDDY_API_KEY')
  }

  // --- 会话生命周期：绑定 pi 的 UI 通道 + 后台发现模型 ---
  // 工厂阶段拿不到 ctx（ExtensionAPI 上没有 ui），只有事件 handler 才有，故在此绑定。
  // 绑定后日志走 ctx.ui.notify，不再写 stderr —— 交互模式（fullscreen）下 stderr 无人
  // 接管，直写会把 TUI 画花（见 log.ts）。
  // 后台发现：不阻塞启动；失败不重试。同一启动内的重复提示由 DiscoveryCache
  // 的失败冷却窗口挡掉（见 models.ts 的 FAILURE_COOLDOWN_MS），因为交互式模式下
  // pi 自己还会再刷一次模型目录，两个触发点会先后调到这里。
  pi.on('session_start', (_event, ctx) => {
    logger.bindUI(ctx.hasUI ? ctx.ui : undefined)
    const token = syncSnapshot.value?.access
    if (token) void discoverAndReregister(token)
  })
  // 会话结束：ctx 在 reload/会话替换后失效，不能继续持有。
  // 加代次是为了让此前发起的后台发现作废（否则它的结果会落到新会话里）。
  pi.on('session_shutdown', () => {
    sessionGen++
    logger.silence()
  })

  // --- compaction 后淘汰 conversation-id（对应 opencode session.compacted）---
  pi.on('session_before_compact', (_event, ctx) => {
    const sid = ctx.sessionManager.getSessionId()
    if (sid) conversationIds.delete(sid)
  })
}
