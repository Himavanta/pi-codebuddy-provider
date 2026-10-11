// fetch-json.ts 的行为契约测试（改动前先锁定行为）
import { describe, it, expect, vi, afterEach } from 'vite-plus/test'

import { fetchJson } from '../src/fetch-json.ts'

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
  vi.useRealTimers()
})

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl)
  globalThis.fetch = spy as any
  return spy
}

describe('fetchJson 成功路径', () => {
  it('2xx 返回 ok:true 与解析后的 JSON', async () => {
    mockFetch(
      async () => new Response(JSON.stringify({ code: 0, data: { x: 1 } }), { status: 200 })
    )
    const res = await fetchJson<{ code: number; data: { x: number } }>('https://x', {
      timeoutMs: 1000
    })
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.data).toEqual({ code: 0, data: { x: 1 } })
  })

  it('透传 method / headers / body', async () => {
    const spy = mockFetch(async () => new Response('{}', { status: 200 }))
    await fetchJson('https://x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 1000
    })
    const init = spy.mock.calls[0][1]!
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
})

describe('fetchJson 失败路径', () => {
  it('非 2xx 返回 ok:false + status + 截断后的 text', async () => {
    mockFetch(async () => new Response('boom', { status: 500 }))
    const res = await fetchJson('https://x', { timeoutMs: 1000 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(500)
      expect(res.text).toBe('boom')
    }
  })

  it('非 2xx 的 text 截断到 500 字符', async () => {
    mockFetch(async () => new Response('x'.repeat(1000), { status: 400 }))
    const res = await fetchJson('https://x', { timeoutMs: 1000 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.text.length).toBe(500)
  })

  it('网络错误返回 ok:false 且带 message', async () => {
    mockFetch(async () => {
      throw new Error('network down')
    })
    const res = await fetchJson('https://x', { timeoutMs: 1000 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.text).toBe('network down')
  })

  it('JSON 解析失败返回 ok:false（不抛）', async () => {
    mockFetch(async () => new Response('not json', { status: 200 }))
    const res = await fetchJson('https://x', { timeoutMs: 1000 })
    expect(res.ok).toBe(false)
  })
})

describe('fetchJson 超时与中止', () => {
  it('超时返回 ok:false text="timeout or abort"', async () => {
    vi.useFakeTimers()
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    )
    const p = fetchJson('https://x', { timeoutMs: 50 })
    await vi.advanceTimersByTimeAsync(60)
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.text).toBe('timeout or abort')
  })

  it('外部 signal 中止返回 ok:false text="timeout or abort"', async () => {
    mockFetch(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
    )
    const ctrl = new AbortController()
    const p = fetchJson('https://x', { timeoutMs: 10_000, signal: ctrl.signal })
    ctrl.abort()
    const res = await p
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.text).toBe('timeout or abort')
  })

  it('传入已中止的 signal 时立即返回，不发请求', async () => {
    const spy = mockFetch(async () => new Response('{}', { status: 200 }))
    const ctrl = new AbortController()
    ctrl.abort()
    const res = await fetchJson('https://x', { timeoutMs: 1000, signal: ctrl.signal })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.text).toBe('timeout or abort')
    expect(spy).not.toHaveBeenCalled()
  })

  it('无论成功失败都清理定时器（不残留未处理的 timer）', async () => {
    vi.useFakeTimers()
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    mockFetch(async () => new Response('{}', { status: 200 }))
    await fetchJson('https://x', { timeoutMs: 1000 })
    expect(clearSpy).toHaveBeenCalled()
    clearSpy.mockRestore()
  })
})
