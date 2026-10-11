import { describe, it, expect, vi } from 'vite-plus/test'

import { createAuthFetch } from '../src/auth-fetch.ts'
import type { AuthFetchDeps } from '../src/auth-fetch.ts'

function makeDeps(overrides: Partial<AuthFetchDeps> = {}): AuthFetchDeps {
  return {
    getAuth: async () => ({ type: 'api', key: 'k' }),
    server: { url: 'https://x', domain: 'd' },
    buildAuthHeaders: () => ({}),
    resolveIdentity: () => ({ tenantId: '', enterpriseId: '', userId: '' }),
    decodeJwtPayload: () => null,
    refreshAndPersist: async () => null,
    cfg: {} as any,
    chatCompletionsPath: '/v2/chat/completions',
    ...overrides
  }
}

describe('auth-fetch (pi)', () => {
  it('非 chat/completions 透传', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok'))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    await af('https://x/other', { method: 'GET' })
    expect(spy).toHaveBeenCalled()
  })
  it('!body 400', async () => {
    const af = createAuthFetch(makeDeps())
    const res = await af('https://x/v2/chat/completions', { method: 'POST' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing request body' })
  })
  it('未认证返回 401 + /login 指引', async () => {
    const af = createAuthFetch(makeDeps({ getAuth: async () => null }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.message).toMatch(/\/login/)
  })
  it('!ok 透传并保留 Content-Type: application/json', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(
        new Response('bad', { status: 500, headers: { 'Content-Type': 'text/plain' } })
      )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const res = await af('https://x/v2/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true })
    })
    expect(res.status).toBe(500)
    expect(res.headers.get('Content-Type')).toBe('application/json')
  })
  it('signal 透传至 doRequest', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const ac = new AbortController()
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}', signal: ac.signal })
    expect(spy.mock.calls[0][1].signal).toBe(ac.signal)
  })
  it('stream:true 缺 stream_options 注入 {include_usage:true}', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    await af('https://x/v2/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true, messages: [] })
    })
    const sent = JSON.parse(spy.mock.calls[0][1].body)
    expect(sent.stream_options).toEqual({ include_usage: true })
  })
  it('已含 stream_options 不覆写', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    await af('https://x/v2/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: true, stream_options: { include_usage: false } })
    })
    const sent = JSON.parse(spy.mock.calls[0][1].body)
    expect(sent.stream_options).toEqual({ include_usage: false })
  })
  it('非流式原样透传（不注入 stream_options）', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    await af('https://x/v2/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ stream: false, messages: [] })
    })
    const sent = JSON.parse(spy.mock.calls[0][1].body)
    expect(sent).toEqual({ stream: false, messages: [] })
  })
  it('请求路径用 chatCompletionsPath 而非硬拼', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({ fetchImpl: spy as any, chatCompletionsPath: '/custom/path' })
    )
    await af('https://x/custom/path', { method: 'POST', body: '{}' })
    expect(spy.mock.calls[0][0]).toBe('https://x/custom/path')
  })
  it('oauth 401 → refreshAndPersist 成功 → 重试一次', async () => {
    const responses = [new Response('unauth', { status: 401 }), new Response('ok', { status: 200 })]
    const spy = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!))
    const refreshAndPersist = vi.fn().mockResolvedValue({
      type: 'oauth',
      access: 'new',
      refresh: 'r',
      expires: Date.now() + 60000
    })
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'old', refresh: 'r', expires: 0 }),
        refreshAndPersist,
        fetchImpl: spy as any
      })
    )
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(refreshAndPersist).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })
  it('oauth 401 → refresh 失败 → 原样返回 401', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('unauth', { status: 401 }))
    const refreshAndPersist = vi.fn().mockResolvedValue(null)
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'old', refresh: 'r', expires: 0 }),
        refreshAndPersist,
        fetchImpl: spy as any
      })
    )
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(spy).toHaveBeenCalledTimes(1)
  })
  it('api 模式 401 不触发刷新', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('unauth', { status: 401 }))
    const refreshAndPersist = vi.fn()
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'api', key: 'k' }),
        refreshAndPersist,
        fetchImpl: spy as any
      })
    )
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(refreshAndPersist).not.toHaveBeenCalled()
  })
  it('11133 瞬时 400 → 退避重试成功（缩短退避验证逻辑）', async () => {
    const responses = [
      new Response(JSON.stringify({ code: 11133 }), { status: 400 }),
      new Response('ok', { status: 200 })
    ]
    const spy = vi.fn().mockImplementation(() => Promise.resolve(responses.shift()!))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    // 用 fake timers 加速退避
    vi.useFakeTimers()
    const p = af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    await vi.runAllTimersAsync()
    const res = await p
    vi.useRealTimers()
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })
  it('非 11133 的 400 不重试，原样透传', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 11101, msg: 'invalid' }), { status: 400 })
      )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(400)
    expect(spy).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.code).toBe(11101)
  })
  it('认证头注入（api 双头）', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'api', key: 'ck_test' }),
        buildAuthHeaders: (auth) => ({
          Authorization: `Bearer ${(auth as any).key}`,
          'X-API-Key': (auth as any).key
        }),
        fetchImpl: spy as any
      })
    )
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    const headers = spy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer ck_test')
    expect(headers.get('X-API-Key')).toBe('ck_test')
  })
  it('oauth 认证头注入（身份头来自 JWT）', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'tok', refresh: 'r', expires: 0 }),
        resolveIdentity: () => ({ tenantId: 't1', enterpriseId: 'e1', userId: 'u1' }),
        buildAuthHeaders: (auth, identity) => ({
          Authorization: `Bearer ${(auth as any).access}`,
          ...(identity.tenantId ? { 'X-Tenant-Id': identity.tenantId } : {}),
          ...(identity.enterpriseId ? { 'X-Enterprise-Id': identity.enterpriseId } : {}),
          ...(identity.userId ? { 'X-User-Id': identity.userId } : {})
        }),
        fetchImpl: spy as any
      })
    )
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    const headers = spy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer tok')
    expect(headers.get('X-Tenant-Id')).toBe('t1')
    expect(headers.get('X-Enterprise-Id')).toBe('e1')
    expect(headers.get('X-User-Id')).toBe('u1')
  })
})

describe('auth-fetch 修复回归', () => {
  it('401 刷新失败 → 15s 冷却期内不再重复刷新', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('unauth', { status: 401 }))
    const refreshAndPersist = vi.fn().mockResolvedValue(null)
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }),
        refreshAndPersist,
        fetchImpl: spy as any
      })
    )
    const res1 = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res1.status).toBe(401)
    expect(refreshAndPersist).toHaveBeenCalledTimes(1)
    // 冷却期内第二个 401 不应再触发刷新（原先每次请求都刷一遍）
    const res2 = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res2.status).toBe(401)
    expect(refreshAndPersist).toHaveBeenCalledTimes(1)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('401 刷新失败后冷却期内 403 也不刷新；刷新成功则清除冷却', async () => {
    let ok = false
    const spy = vi
      .fn()
      .mockImplementation(async () =>
        ok ? new Response('ok', { status: 200 }) : new Response('forbidden', { status: 403 })
      )
    let calls = 0
    const refreshAndPersist = vi.fn().mockImplementation(async () => {
      calls += 1
      if (calls >= 2) {
        ok = true
        return { type: 'oauth', access: 'n', refresh: 'r', expires: 0 }
      }
      return null
    })
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'a', refresh: 'r', expires: 0 }),
        refreshAndPersist,
        fetchImpl: spy as any
      })
    )
    vi.useFakeTimers()
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' }) // 刷新失败 → 进冷却
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' }) // 冷却中：不刷新
    expect(refreshAndPersist).toHaveBeenCalledTimes(1)
    vi.setSystemTime(Date.now() + 16_000) // 冷却过期
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    vi.useRealTimers()
    expect(refreshAndPersist).toHaveBeenCalledTimes(2)
    expect(res.status).toBe(200) // 刷新成功 + 重试成功
  })

  it('11133 退避期间用户 abort → 不抛异常，返回携带原 body 的 400 Response', async () => {
    const spy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 11133, msg: 'transient' }), { status: 400 })
        )
      )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const ctrl = new AbortController()
    const p = af('https://x/v2/chat/completions', {
      method: 'POST',
      body: '{}',
      signal: ctrl.signal
    })
    setTimeout(() => ctrl.abort(), 30) // 在退避 sleep（1s）中触发 abort
    const res = await p // 原实现此处会 reject（TypeError: Body is unusable）
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 11133 })
    expect(spy).toHaveBeenCalledTimes(1) // abort 后不再重发
  })

  it('重试次数可用 cfg.transient400Retries 配置', async () => {
    const spy = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify({ code: 11133 }), { status: 400 }))
      )
    const af = createAuthFetch(
      makeDeps({ fetchImpl: spy as any, cfg: { transient400Retries: 0 } as any })
    )
    vi.useFakeTimers()
    const p = af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    await vi.runAllTimersAsync()
    const res = await p
    vi.useRealTimers()
    expect(res.status).toBe(400)
    expect(spy).toHaveBeenCalledTimes(1) // 0 次 = 不重试
  })
})

describe('url 三态处理（string / URL / Request）', () => {
  it('string 形式识别 chat 路径并注入认证头', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'api', key: 'ck_x' }),
        buildAuthHeaders: (a) => ({ Authorization: `Bearer ${(a as any).key}` }),
        fetchImpl: spy as any
      })
    )
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    const headers = spy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer ck_x')
  })

  it('URL 形式识别 chat 路径并注入认证头', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'api', key: 'ck_x' }),
        buildAuthHeaders: (a) => ({ Authorization: `Bearer ${(a as any).key}` }),
        fetchImpl: spy as any
      })
    )
    await af(new URL('https://x/v2/chat/completions'), { method: 'POST', body: '{}' })
    const headers = spy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer ck_x')
  })

  // 回归：url.toString() 对 Request 返回 "[object Request]"，会静默绕过认证注入与重试
  it('Request 形式仍能识别 chat 路径（不被当非 chat 透传）', async () => {
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'api', key: 'ck_x' }),
        buildAuthHeaders: (a) => ({ Authorization: `Bearer ${(a as any).key}` }),
        fetchImpl: spy as any
      })
    )
    const req = new Request('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    await af(req, { method: 'POST', body: '{}' })
    const headers = spy.mock.calls[0][1].headers as Headers
    expect(headers.get('Authorization')).toBe('Bearer ck_x')
  })
})

describe('JWT 身份记忆化', () => {
  it('同一 access token 只解析一次（跨请求命中缓存）', async () => {
    const decodeJwtPayload = vi.fn(() => ({ sub: 'u1', tenant_id: 't1' }))
    const resolveIdentity = vi.fn(() => ({ tenantId: 't1', enterpriseId: '', userId: 'u1' }))
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: 'same-token', refresh: 'r', expires: 0 }),
        decodeJwtPayload,
        resolveIdentity,
        fetchImpl: spy as any
      })
    )
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(spy).toHaveBeenCalledTimes(3)
    // 三个请求共用同一 token：base64 解码与身份提取各只做一次
    expect(decodeJwtPayload).toHaveBeenCalledTimes(1)
    expect(resolveIdentity).toHaveBeenCalledTimes(1)
  })

  it('access token 变化时重新解析', async () => {
    let token = 'token-a'
    const decodeJwtPayload = vi.fn(() => ({ sub: 'u1' }))
    const resolveIdentity = vi.fn(() => ({ tenantId: '', enterpriseId: '', userId: 'u1' }))
    const spy = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    const af = createAuthFetch(
      makeDeps({
        getAuth: async () => ({ type: 'oauth', access: token, refresh: 'r', expires: 0 }),
        decodeJwtPayload,
        resolveIdentity,
        fetchImpl: spy as any
      })
    )
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    token = 'token-b'
    await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(decodeJwtPayload).toHaveBeenCalledTimes(2)
    expect(resolveIdentity).toHaveBeenCalledTimes(2)
  })
})
