import { describe, it, expect, vi, beforeEach } from 'vite-plus/test'

import { requestAuthState, pollForToken, refreshAccessToken } from '../src/auth-flow.ts'
import { fetchJson } from '../src/fetch-json.ts'

vi.mock('../src/fetch-json.ts', () => ({ fetchJson: vi.fn() }))

describe('requestAuthState', () => {
  beforeEach(() => vi.mocked(fetchJson).mockReset())

  it('带 platform/ioa 查询参数', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { state: 's1', authUrl: 'https://x/login' } }
    } as any)
    const res = await requestAuthState('https://copilot.tencent.com')
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain('platform=VSCode')
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toContain('ioa=1')
    expect(res.state).toBe('s1')
  })

  it('缺 authUrl 时 fallback 构造 login URL', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { state: 's1' } }
    } as any)
    const res = await requestAuthState('https://copilot.tencent.com')
    expect(res.url).toBe('https://copilot.tencent.com/login?platform=VSCode&state=s1&ioa=1')
  })

  it('透传 X-No-* 特殊头', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { state: 's1', authUrl: 'https://x' } }
    } as any)
    await requestAuthState('https://copilot.tencent.com')
    const headers = vi.mocked(fetchJson).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-No-Authorization']).toBe('true')
    expect(headers['X-No-User-Id']).toBe('true')
    expect(headers['X-No-Enterprise-Id']).toBe('true')
    expect(headers['X-No-Department-Info']).toBe('true')
  })

  it('code 非 0 时抛错', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: true, data: { code: 1, data: {} } } as any)
    await expect(requestAuthState('https://x')).rejects.toThrow(/Auth state failed/)
  })

  it('超时用 AUTH_STATE_TIMEOUT_MS', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: false, status: 500, text: 'err' } as any)
    await expect(requestAuthState('https://x')).rejects.toThrow()
    expect(vi.mocked(fetchJson).mock.calls[0][1]?.timeoutMs).toBe(5000)
  })
})

describe('pollForToken', () => {
  beforeEach(() => vi.mocked(fetchJson).mockReset())

  it('首查即成功时不 sleep', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 } }
    } as any)
    const start = Date.now()
    const res = await pollForToken({
      serverUrl: 'https://copilot.tencent.com',
      state: 's1',
      expiresAt: Date.now() + 10000
    })
    expect(res?.accessToken).toBe('a')
    expect(Date.now() - start).toBeLessThan(1000)
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(1)
  })

  it('URL 跟随 serverUrl（非硬编码默认主机）', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'a' } }
    } as any)
    await pollForToken({
      serverUrl: 'https://my-proxy.example.com',
      state: 's1',
      expiresAt: Date.now() + 10000
    })
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toBe(
      'https://my-proxy.example.com/v2/plugin/auth/token?state=s1'
    )
  })

  it('首查失败后才 sleep 再查', async () => {
    vi.mocked(fetchJson)
      .mockResolvedValueOnce({ ok: true, data: { code: 1, data: {} } } as any)
      .mockResolvedValueOnce({
        ok: true,
        data: { code: 0, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 3600 } }
      } as any)
    const res = await pollForToken({
      serverUrl: 'https://copilot.tencent.com',
      state: 's1',
      expiresAt: Date.now() + 5000
    })
    expect(res?.accessToken).toBe('a')
    expect(vi.mocked(fetchJson)).toHaveBeenCalledTimes(2)
  })

  it('signal 已中止时立即返回 null（不发请求）', async () => {
    const ac = new AbortController()
    ac.abort()
    const res = await pollForToken({
      serverUrl: 'https://copilot.tencent.com',
      state: 's1',
      expiresAt: Date.now() + 10000,
      signal: ac.signal
    })
    expect(res).toBeNull()
    expect(vi.mocked(fetchJson)).not.toHaveBeenCalled()
  })

  it('expiresAt 到期返回 null', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: true, data: { code: 1 } } as any)
    const res = await pollForToken({
      serverUrl: 'https://copilot.tencent.com',
      state: 's1',
      expiresAt: Date.now() + 10
    })
    expect(res).toBeNull()
  })
})

describe('refreshAccessToken', () => {
  beforeEach(() => vi.mocked(fetchJson).mockReset())

  it('带 X-Refresh-Token 头（不是 Authorization）', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'new' } }
    } as any)
    await refreshAccessToken('my-refresh', 'https://x')
    const headers = vi.mocked(fetchJson).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Refresh-Token']).toBe('my-refresh')
    // 回归：用 Authorization: Bearer <refreshToken> 会被上游回 400 code 10001 "refreshToken is empty"
    expect(headers['Authorization']).toBeUndefined()
  })

  it('带 X-Auth-Refresh-Source: plugin（与官方 CLI 一致）', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'new' } }
    } as any)
    await refreshAccessToken('my-refresh', 'https://x')
    const headers = vi.mocked(fetchJson).mock.calls[0][1]?.headers as Record<string, string>
    expect(headers['X-Auth-Refresh-Source']).toBe('plugin')
  })

  it('URL 与 method 正确', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'new' } }
    } as any)
    await refreshAccessToken('r', 'https://x')
    expect(vi.mocked(fetchJson).mock.calls[0][0]).toBe('https://x/v2/plugin/auth/token/refresh')
    expect(vi.mocked(fetchJson).mock.calls[0][1]?.method).toBe('POST')
  })

  it('透传轮换后的 refreshToken 与 expiresIn', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'new', refreshToken: 'rotated', expiresIn: 3600 } }
    } as any)
    const res = await refreshAccessToken('old', 'https://x')
    expect(res?.accessToken).toBe('new')
    expect(res?.refreshToken).toBe('rotated')
    expect(res?.expiresIn).toBe(3600)
  })

  it('code 非 0 返回 null', async () => {
    vi.mocked(fetchJson).mockResolvedValue({ ok: true, data: { code: 1 } } as any)
    expect(await refreshAccessToken('r', 'https://x')).toBeNull()
  })

  it('HTTP 非 2xx 返回 null', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: false,
      status: 400,
      text: 'refreshToken is empty'
    } as any)
    expect(await refreshAccessToken('r', 'https://x')).toBeNull()
  })

  it('超时用 REFRESH_TIMEOUT_MS', async () => {
    vi.mocked(fetchJson).mockResolvedValue({
      ok: true,
      data: { code: 0, data: { accessToken: 'new' } }
    } as any)
    await refreshAccessToken('r', 'https://x')
    expect(vi.mocked(fetchJson).mock.calls[0][1]?.timeoutMs).toBe(5000)
  })
})
