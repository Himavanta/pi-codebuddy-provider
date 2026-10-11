import { describe, it, expect, vi } from 'vite-plus/test'

import { createAuthFetch } from '../src/auth-fetch.ts'
import type { AuthFetchDeps } from '../src/auth-fetch.ts'
import { parseRetryDelayMs, buildRateLimitMessage } from '../src/retry-policy.ts'

function makeDeps(overrides: Partial<AuthFetchDeps> = {}): AuthFetchDeps {
  return {
    getAuth: async () => ({ type: 'api', key: 'k' }),
    server: { url: 'https://x', domain: 'd' },
    buildAuthHeaders: () => ({}),
    resolveIdentity: () => ({ tenantId: '', enterpriseId: '', userId: '' }),
    decodeJwtPayload: () => null,
    refreshAndPersist: async () => null,
    cfg: { rewriteLeakedReasoning: false, rateLimitMaxWaitMs: 20_000, rateLimitRetries: 0 } as any,
    chatCompletionsPath: '/v2/chat/completions',
    ...overrides
  }
}

const CFG_ON = {
  rewriteLeakedReasoning: true,
  rateLimitMaxWaitMs: 20_000,
  rateLimitRetries: 1
} as any

describe('parseRetryDelayMs', () => {
  it('retry-after 相对秒', () =>
    expect(parseRetryDelayMs(new Headers({ 'retry-after': '2' }))).toBe(2000))
  it('retry-after-ms 相对毫秒', () =>
    expect(parseRetryDelayMs(new Headers({ 'retry-after-ms': '250' }))).toBe(250))
  it('x-ratelimit-reset 相对秒', () =>
    expect(parseRetryDelayMs(new Headers({ 'x-ratelimit-reset': '0.5' }))).toBe(500))
  it('秒级 epoch 换算成剩余毫秒', () => {
    const v = parseRetryDelayMs(
      new Headers({ 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 30) })
    )!
    expect(v).toBeGreaterThan(25_000)
    expect(v).toBeLessThanOrEqual(30_500)
  })
  it('毫秒级 epoch 不被当成相对量', () => {
    const v = parseRetryDelayMs(new Headers({ 'retry-after-ms': String(Date.now() + 45_000) }))!
    expect(v).toBeGreaterThan(40_000)
    expect(v).toBeLessThan(46_000)
  })
  it('HTTP-date', () => {
    const v = parseRetryDelayMs(
      new Headers({ 'retry-after': new Date(Date.now() + 20_000).toUTCString() })
    )!
    expect(v).toBeGreaterThan(15_000)
    expect(v).toBeLessThan(21_000)
  })
  it('无提示返回 undefined', () => expect(parseRetryDelayMs(new Headers())).toBeUndefined())
})

describe('buildRateLimitMessage', () => {
  it('终态文案带 quota exceeded（Pi 据此立即失败不再重试）', () => {
    expect(buildRateLimitMessage(600_000, true, '')).toMatch(/quota exceeded/)
  })
  it('瞬时限流文案保留 429 / rate limit 字样（交给 Pi 退避重试）', () => {
    const m = buildRateLimitMessage(undefined, false, '')
    expect(m).toMatch(/429/)
    expect(m).toMatch(/rate limit/)
  })
  it('网关有 body 时截断附上', () => {
    expect(buildRateLimitMessage(1000, false, 'x'.repeat(500))).toMatch(/网关 body: x{200}/)
  })
})

describe('auth-fetch 429 处理', () => {
  it('有 Retry-After 且在预算内 → 就地等待后幂等重发', async () => {
    const spy = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { 'retry-after-ms': '20' } })
      )
      .mockResolvedValueOnce(
        new Response('data: [DONE]\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' }
        })
      )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any, cfg: CFG_ON }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(200)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('窗口很远 → 合成终态 body 且不再重发', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'retry-after': '600' } }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect(spy).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.error.message).toMatch(/quota exceeded/)
    expect(body.error.code).toBe('quota_exceeded')
  })

  it("空 body 429 → 上层拿到可读错误（不再是 '429 status code (no body)'）", async () => {
    const spy = vi.fn().mockResolvedValue(new Response(null, { status: 429 }))
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    const body = await res.json()
    expect(body.error.message).toMatch(/codebuddy/)
    expect(body.error.message.length).toBeGreaterThan(20)
    expect(res.headers.get('content-type')).toBe('application/json')
  })

  it('开关打开时 SSE 响应被包装且剥离实体头', async () => {
    const CLOSE = ['<', '/think:6124c78e>'].join('')
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ index: 0, delta: { content: '草稿' + CLOSE + '真回答' } }] }) +
      '\n\ndata: [DONE]\n\n'
    const spy = vi.fn().mockResolvedValue(
      new Response(sse, {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'content-length': String(sse.length) }
      })
    )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any, cfg: CFG_ON }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(res.headers.get('content-length')).toBe(null)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const text = await res.text()
    expect(text).toContain('真回答')
    expect(text).toContain('草稿')
    expect(text).not.toContain('think:')
  })

  it('开关关闭时 SSE 原样透传（默认不影响现有行为）', async () => {
    const CLOSE = ['<', '/think:6124c78e>'].join('')
    const sse =
      'data: ' +
      JSON.stringify({ choices: [{ index: 0, delta: { content: '草稿' + CLOSE + '真回答' } }] }) +
      '\n\n'
    const spy = vi
      .fn()
      .mockResolvedValue(
        new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
      )
    const af = createAuthFetch(makeDeps({ fetchImpl: spy as any }))
    const res = await af('https://x/v2/chat/completions', { method: 'POST', body: '{}' })
    expect(await res.text()).toBe(sse)
  })
})
