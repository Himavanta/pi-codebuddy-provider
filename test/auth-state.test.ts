import { describe, it, expect } from 'vite-plus/test'

import { pickAuthMode, effectiveAuth } from '../src/auth-state.ts'

describe('pickAuthMode 全矩阵', () => {
  it('cfg.auth=api 强制 api', () => {
    expect(pickAuthMode({ auth: 'api', apiKey: '' } as any, undefined)).toBe('api')
    expect(
      pickAuthMode({ auth: 'api', apiKey: '' } as any, { type: 'oauth', access: 'a' } as any)
    ).toBe('api')
  })
  it('cfg.auth=oauth 强制 oauth', () => {
    expect(pickAuthMode({ auth: 'oauth', apiKey: 'ck_xxx' } as any, undefined)).toBe('oauth')
  })
  it('auto 时 apiKey 优先', () => {
    expect(pickAuthMode({ auth: 'auto', apiKey: 'ck_xxx' } as any, undefined)).toBe('api')
  })
  it('auto 时 stored api 优先', () => {
    expect(
      pickAuthMode({ auth: 'auto', apiKey: '' } as any, { type: 'api', key: 'k' } as any)
    ).toBe('api')
  })
  it('auto 时默认 oauth', () => {
    expect(pickAuthMode({ auth: 'auto', apiKey: '' } as any, undefined)).toBe('oauth')
    expect(
      pickAuthMode(
        { auth: 'auto', apiKey: '' } as any,
        { type: 'oauth', access: 'a', refresh: 'r', expires: 999 } as any
      )
    ).toBe('oauth')
  })
})

describe('effectiveAuth 单分支', () => {
  it('api 模式：cfg.apiKey 优先', () => {
    const cfg = { auth: 'api', apiKey: 'cfg-key' } as any
    expect(effectiveAuth({ type: 'api', key: 'stored' } as any, cfg)).toEqual({
      type: 'api',
      key: 'cfg-key'
    })
  })
  it('api 模式：无 cfg 时用 stored', () => {
    const cfg = { auth: 'api', apiKey: '' } as any
    expect(effectiveAuth({ type: 'api', key: 'stored' } as any, cfg)).toEqual({
      type: 'api',
      key: 'stored'
    })
  })
  it('A2：api 模式无 key 返回 null（由上层 warn，非静默 fallback）', () => {
    const cfg = { auth: 'api', apiKey: '' } as any
    expect(effectiveAuth(undefined, cfg)).toBeNull()
    expect(
      effectiveAuth(
        { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 10000 } as any,
        cfg
      )
    ).toBeNull()
  })
  it('oauth 单分支：未过期返回', () => {
    const cfg = { auth: 'oauth', apiKey: '' } as any
    const stored = { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() + 100000 }
    expect(effectiveAuth(stored as any, cfg)).toEqual({
      type: 'oauth',
      access: 'a',
      refresh: 'r',
      expires: stored.expires
    })
  })
  it('oauth 单分支：过期 token 仍返回（expires 校验删除，靠 401 刷新兜底）', () => {
    const cfg = { auth: 'oauth', apiKey: '' } as any
    const stored = { type: 'oauth', access: 'a', refresh: 'r', expires: Date.now() - 1000 }
    const res = effectiveAuth(stored as any, cfg)
    expect(res).not.toBeNull()
    expect((res as any).access).toBe('a')
  })
  it('oauth 缺 access 返回 null', () => {
    const cfg = { auth: 'oauth', apiKey: '' } as any
    expect(effectiveAuth({ type: 'oauth', refresh: 'r', expires: 123 } as any, cfg)).toBeNull()
  })
})
