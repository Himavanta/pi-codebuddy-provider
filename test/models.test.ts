import { normalizeContext } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/compat'
import { clampThinkingLevel, getSupportedThinkingLevels } from '@earendil-works/pi-ai/models'
import { describe, it, expect, vi, afterEach } from 'vite-plus/test'

import {
  remoteModelToPi,
  buildThinkingLevelMap,
  fetchRemoteModels,
  DEFAULT_MODEL,
  DiscoveryCache,
  FAILURE_COOLDOWN_MS
} from '../src/models.ts'
import type { RemoteModel } from '../src/models.ts'

describe('models (pi)', () => {
  it('remoteModelToPi 基本字段映射', () => {
    const m: RemoteModel = {
      id: 'claude-x',
      name: 'Claude X',
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      supportsToolCall: true,
      supportsImages: true,
      supportsReasoning: true,
      reasoning: { defaultEffort: 'high', supportedEfforts: ['low', 'high'] }
    }
    const p = remoteModelToPi(m)
    expect(p.id).toBe('claude-x')
    expect(p.name).toBe('Claude X')
    expect(p.contextWindow).toBe(200000)
    expect(p.maxTokens).toBe(32000)
    expect(p.reasoning).toBe(true)
    expect(p.input).toEqual(['text', 'image'])
    expect(p.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high'
    })
    expect(p.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  })
  it('maxAllowedSize 优先于 maxInputTokens', () => {
    const p = remoteModelToPi({
      id: 'a',
      name: 'A',
      maxAllowedSize: 256000,
      maxInputTokens: 128000
    })
    expect(p.contextWindow).toBe(256000)
  })

  it('contextWindow 对象形态取 supportedLengths 最大值', () => {
    const p = remoteModelToPi({
      id: 'space-bunny',
      name: 'Space-Bunny',
      maxAllowedSize: 1000000,
      contextWindow: { defaultLength: 300000, supportedLengths: [300000, 600000, 1000000] }
    })
    expect(p.contextWindow).toBe(1000000)
  })

  it('contextWindow 对象优先于 maxAllowedSize（上游显式声明长度）', () => {
    const p = remoteModelToPi({
      id: 'x',
      name: 'X',
      maxAllowedSize: 2000000,
      contextWindow: { defaultLength: 300000, supportedLengths: [300000, 512000] }
    })
    expect(p.contextWindow).toBe(512000)
  })

  it('contextWindow 对象只有 defaultLength 时回退到它', () => {
    const p = remoteModelToPi({
      id: 'x',
      name: 'X',
      maxAllowedSize: 999,
      contextWindow: { defaultLength: 300000 }
    })
    expect(p.contextWindow).toBe(300000)
  })

  it('contextWindow 对象非法/为空时回退 maxAllowedSize', () => {
    expect(
      remoteModelToPi({
        id: 'x',
        name: 'X',
        maxAllowedSize: 256000,
        contextWindow: { supportedLengths: [] }
      }).contextWindow
    ).toBe(256000)
    expect(
      remoteModelToPi({ id: 'x', name: 'X', maxAllowedSize: 256000, contextWindow: {} })
        .contextWindow
    ).toBe(256000)
    expect(
      remoteModelToPi({
        id: 'x',
        name: 'X',
        maxAllowedSize: 256000,
        contextWindow: { supportedLengths: [0, -1, NaN] }
      }).contextWindow
    ).toBe(256000)
  })
  it('缺省尺寸走 DEFAULT', () => {
    const p = remoteModelToPi({ id: 'a', name: 'A' })
    expect(p.contextWindow).toBe(131_072)
    expect(p.maxTokens).toBe(8192)
  })
  it('disabledMultimodal 关闭图片输入', () => {
    const p = remoteModelToPi({
      id: 'claude-x',
      name: 'X',
      supportsImages: true,
      disabledMultimodal: true
    })
    expect(p.input).toEqual(['text'])
  })
  it('以网关 supportsImages 为准，不受模型 ID 白名单限制', () => {
    // 网关 /v3/config 对 craft agent 的 16 个模型（含 deepseek/glm/kimi/minimax/hunyuan）
    // 全标了 supportsImages=true，但 ID 不含 claude|gemini|gpt，旧实现一律降级为纯文本。
    for (const id of ['deepseek-v4.1-flash', 'glm-5.3', 'kimi-k3-1', 'minimax-m3', 'hy3']) {
      expect(remoteModelToPi({ id, name: id, supportsImages: true }).input).toEqual([
        'text',
        'image'
      ])
    }
  })
  it('缺省 supportsImages 时回退 ID 白名单', () => {
    expect(remoteModelToPi({ id: 'claude-x', name: 'X' }).input).toEqual(['text', 'image'])
    expect(remoteModelToPi({ id: 'deepseek-v4.1-flash', name: 'D' }).input).toEqual(['text'])
  })
  it('supportsImages=false 优先于 ID 白名单', () => {
    expect(remoteModelToPi({ id: 'gemini-x', name: 'G', supportsImages: false }).input).toEqual([
      'text'
    ])
  })
  it('reasoning 模型强制 system 角色（CodeBuddy 拒绝 developer → 400）', () => {
    const p = remoteModelToPi({ id: 'claude-x', name: 'X', supportsReasoning: true })
    expect(p.compat?.supportsDeveloperRole).toBe(false)
    const model: any = {
      ...p,
      api: 'openai-completions',
      provider: 'codebuddy',
      baseUrl: 'https://x/v2'
    }
    const captured: any[] = []
    const fetchFn = (async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })) as any
    const stream = openAICompletionsApi().streamSimple(
      model,
      // pi-ai 1.1.0：provider 层接收的是 normalizeContext() 产出的事务上下文，
      // systemPrompt 被折成前导 system message（裸 Context 不再被接受）
      normalizeContext({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] } as any),
      {
        apiKey: 'x',
        fetch: fetchFn,
        onPayload: ((pl: any) => {
          captured.push(pl)
          return undefined
        }) as any
      }
    )
    return (async () => {
      for await (const _ of stream) {
        /* drain */
      }
      expect(captured[0].messages[0].role).toBe('system')
    })()
  })
  it('非推理模型无 thinkingLevelMap', () => {
    const p = remoteModelToPi({ id: 'plain', name: 'P', supportsReasoning: false })
    expect(p.reasoning).toBe(false)
    expect(p.thinkingLevelMap).toBeUndefined()
  })
  it('DEFAULT_MODEL 具备最小可用字段', () => {
    const p = remoteModelToPi(DEFAULT_MODEL)
    expect(p.id).toBe('auto')
    expect(p.contextWindow).toBe(168000)
    expect(p.maxTokens).toBe(32000)
  })
  it('hy4-preview 是推理模型（旧实现写死 hy3 导致被误判为非推理）', () => {
    const m = remoteModelToPi({ id: 'hy4-preview', name: 'Hy4 preview' })
    expect(m.reasoning).toBe(true)
    // 上游对 ID 完全未声明档位（无 supportedEfforts 也无 effort）时才禁发 reasoning_effort
    expect(m.compat?.supportsReasoningEffort).toBe(false)
    expect(m.thinkingLevelMap).toBeUndefined()
  })
  it('glm-5.1（只有 effort，无词表）可下发 reasoning_effort，且不能关思考', () => {
    // 回归：旧实现把「无 supportedEfforts」当成「无档位信息」→ 禁发 reasoning_effort，
    // 而上游对该模型不收空值（400 code 11150），导致该模型在列表里但必然失败。
    const m = remoteModelToPi({
      id: 'glm-5.1',
      name: 'GLM-5.1',
      supportsReasoning: true,
      reasoning: { effort: 'medium', summary: 'auto' }
    })
    expect(m.reasoning).toBe(true)
    expect(m.compat?.supportsReasoningEffort).toBeUndefined()
    expect(m.thinkingLevelMap).toMatchObject({ off: null, medium: 'medium' })
    // 只有 medium 一档：其余档位不可选，避免发出上游没收的值
    expect(m.thinkingLevelMap!.low).toBeNull()
    expect(m.thinkingLevelMap!.high).toBeNull()
  })
  it('glm-5.1 端到端：经 pi-ai 管线实际发出 reasoning_effort=medium', () => {
    // 本用例覆盖真实管线（remoteModelToPi → pi-ai openai-completions），
    // 验证 thinkingLevelMap 在 pi 侧确实转化为非空 reasoning_effort。
    const p = remoteModelToPi({
      id: 'glm-5.1',
      name: 'GLM-5.1',
      supportsReasoning: true,
      reasoning: { effort: 'medium', summary: 'auto' }
    })
    const model: any = {
      ...p,
      api: 'openai-completions',
      provider: 'codebuddy',
      baseUrl: 'https://x/v2'
    }
    const captured: any[] = []
    const fetchFn = (async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })) as any
    const stream = openAICompletionsApi().streamSimple(
      model,
      normalizeContext({ systemPrompt: 'sys', messages: [{ role: 'user', content: 'hi' }] } as any),
      {
        apiKey: 'x',
        fetch: fetchFn,
        reasoning: 'medium',
        onPayload: ((pl: any) => {
          captured.push(pl)
          return undefined
        }) as any
      }
    )
    return (async () => {
      for await (const _ of stream) {
        /* drain */
      }
      expect(captured[0].reasoning_effort).toBe('medium')
    })()
  })
  it('glm-5.1（只有 effort）任何用户档位都钳到 medium，永不发出空值', async () => {
    // 最危险的路径：glm-5.1 对「不发 reasoning_effort」返回 400（code 11150）。
    // pi 在用户选 off 时会不带该字段（openai-completions.js:525），
    // 因此必须靠 thinkingLevelMap 把 off 移出可选集合、并由 clamp 归到唯一档位。
    const p = remoteModelToPi({
      id: 'glm-5.1',
      name: 'GLM-5.1',
      supportsReasoning: true,
      reasoning: { effort: 'medium', summary: 'auto' }
    })
    const model: any = {
      ...p,
      api: 'openai-completions',
      provider: 'codebuddy',
      baseUrl: 'https://x/v2'
    }
    expect(getSupportedThinkingLevels(model)).toEqual(['medium'])
    const userLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
    for (const level of userLevels) {
      expect(clampThinkingLevel(model, level)).toBe('medium')
    }
  })
  it('上游 supportsReasoning=true 时不再被 ID 猜测覆盖', () => {
    expect(remoteModelToPi({ id: 'mystery-9', name: 'M', supportsReasoning: true }).reasoning).toBe(
      true
    )
    expect(remoteModelToPi({ id: 'mystery-9', name: 'M' }).reasoning).toBe(false)
  })
  it('公布 effort 词表的推理模型仍可下发 reasoning_effort', () => {
    const m = remoteModelToPi({
      id: 'hy3',
      name: 'Hy3',
      supportsReasoning: true,
      reasoning: { supportedEfforts: ['low', 'high'], defaultEffort: 'high' }
    })
    expect(m.reasoning).toBe(true)
    expect(m.compat?.supportsReasoningEffort).toBeUndefined()
    expect(m.thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high'
    })
  })

  it('推理模型启用 requiresReasoningContentOnAssistantMessages（上游 11155 兜底）', () => {
    const p = remoteModelToPi({ id: 'hy3', name: 'Hy3', supportsReasoning: true })
    expect(p.compat?.requiresReasoningContentOnAssistantMessages).toBe(true)
  })

  it('非推理模型也带上该 compat 标志（pi-ai 仅在 model.reasoning 为真时生效）', () => {
    const p = remoteModelToPi({ id: 'plain', name: 'P', supportsReasoning: false })
    expect(p.reasoning).toBe(false)
    expect(p.compat?.requiresReasoningContentOnAssistantMessages).toBe(true)
  })

  it('11155 兜底端到端：历史 assistant 缺 reasoning_content 时补空串', async () => {
    const p = remoteModelToPi({ id: 'hy3', name: 'Hy3', supportsReasoning: true })
    const model: any = {
      ...p,
      api: 'openai-completions',
      provider: 'codebuddy',
      baseUrl: 'https://x/v2'
    }
    const captured: any[] = []
    const fetchFn = (async () =>
      new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })) as any
    const stream = openAICompletionsApi().streamSimple(
      model,
      // 同下：走真实宿主路径（systemPrompt → 前导 system message）
      normalizeContext({
        systemPrompt: 'sys',
        messages: [
          { role: 'user', content: 'hi', timestamp: 1 },
          {
            role: 'assistant',
            api: 'openai-completions',
            provider: 'codebuddy',
            model: 'hy3',
            content: [{ type: 'text', text: 'hello' }],
            usage: {},
            stopReason: 'stop',
            timestamp: 2
          },
          { role: 'user', content: 'again', timestamp: 3 }
        ]
      } as any),
      {
        apiKey: 'x',
        fetch: fetchFn,
        onPayload: ((pl: any) => {
          captured.push(pl)
          return undefined
        }) as any
      }
    )
    for await (const _ of stream) {
      /* drain */
    }
    const assistant = captured[0].messages.find((m: any) => m.role === 'assistant')
    expect(assistant.reasoning_content).toBe('')
  })
})

describe('buildThinkingLevelMap（pi 档位 → 上游取值）', () => {
  const mk = (reasoning: RemoteModel['reasoning']): RemoteModel => ({
    id: 'x',
    name: 'X',
    supportsReasoning: true,
    reasoning
  })

  it('上游未给出任何档位信息 → undefined（不下发 reasoning_effort）', () => {
    expect(buildThinkingLevelMap(mk(undefined))).toBeUndefined()
    // defaultEffort 是词表内的元数据，不单独构成档位声明
    expect(buildThinkingLevelMap(mk({ defaultEffort: 'high' }))).toBeUndefined()
    expect(buildThinkingLevelMap(mk({ supportedEfforts: [] }))).toBeUndefined()
  })

  it('只有 effort → 只暴露该档，off 与其余档位置 null（glm-5.1 等）', () => {
    const map = buildThinkingLevelMap(mk({ effort: 'medium' }))
    expect(map).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: 'medium',
      high: null
    })
    // 关键回归：glm-5.1 不发 reasoning_effort 即 400（code 11150），
    // 只有 medium 一档可用，因此必须能选出该档的字符串值。
    expect(map!.medium).toBe('medium')
    // 不能关思考（off 被移除，用户无法切到不发字段的档位）
    expect(map!.off).toBeNull()
  })

  it('effort 为 xhigh/max 时仅暴露扩展档', () => {
    expect(buildThinkingLevelMap(mk({ effort: 'xhigh' }))).toEqual({
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: 'xhigh'
    })
    expect(buildThinkingLevelMap(mk({ effort: 'max' }))).toMatchObject({ max: 'max' })
  })

  it('supportedEfforts 优先于 effort（词表更权威）', () => {
    const map = buildThinkingLevelMap(
      mk({ effort: 'medium', supportedEfforts: ['low', 'high'], canDisableThinking: true })
    )
    expect(map).toEqual({ minimal: null, low: 'low', medium: null, high: 'high' })
    // 上游公开词表且可关思考 → off 可逆
    expect(map).not.toHaveProperty('off')
  })

  it('effort 不是合法 pi 档位 → undefined（无法表达则不声明）', () => {
    expect(buildThinkingLevelMap(mk({ effort: 'banana' }))).toBeUndefined()
    expect(buildThinkingLevelMap(mk({ effort: '' }))).toBeUndefined()
    expect(buildThinkingLevelMap(mk({ effort: 'none' }))).toBeUndefined()
  })

  it('hy3（low/high）：medium 等不被上游支持的档位置 null', () => {
    const map = buildThinkingLevelMap(
      mk({ supportedEfforts: ['low', 'high'], canDisableThinking: false })
    )
    expect(map).toEqual({ off: null, minimal: null, low: 'low', medium: null, high: 'high' })
    // 关键回归：不得再出现无效的 "default" 键，也不得把上游档名当键
    expect(Object.keys(map!)).not.toContain('default')
    expect(map!.medium).toBeNull()
  })

  it('xhigh/max 仅在支持时写入（无条目则不可见）', () => {
    const onlyHigh = buildThinkingLevelMap(
      mk({ supportedEfforts: ['high'], canDisableThinking: false })
    )
    expect(onlyHigh).not.toHaveProperty('xhigh')
    expect(onlyHigh).not.toHaveProperty('max')

    const withMax = buildThinkingLevelMap(
      mk({ supportedEfforts: ['low', 'high', 'max'], canDisableThinking: true })
    )
    expect(withMax!.max).toBe('max')
    expect(withMax).not.toHaveProperty('xhigh')

    const withXhigh = buildThinkingLevelMap(
      mk({ supportedEfforts: ['high', 'xhigh'], canDisableThinking: true })
    )
    expect(withXhigh!.xhigh).toBe('xhigh')
    expect(withXhigh).not.toHaveProperty('max')
  })

  it('canDisableThinking 决定 off 是否可选', () => {
    // 上游可关思考 → off 不出现在 map（pi 默认可用），也不被标 null
    expect(
      buildThinkingLevelMap(mk({ supportedEfforts: ['low', 'high'], canDisableThinking: true }))
    ).not.toHaveProperty('off')
    // 不可关 → 显式 null 移出可选集合
    expect(
      buildThinkingLevelMap(mk({ supportedEfforts: ['low', 'high'], canDisableThinking: false }))!
        .off
    ).toBeNull()
    // 字段缺失（auto / hy3 / kimi / minimax）按不可关处理
    expect(buildThinkingLevelMap(mk({ supportedEfforts: ['low', 'high'] }))!.off).toBeNull()
  })

  it('space-bunny（全档位）映射完整', () => {
    const map = buildThinkingLevelMap(
      mk({
        supportedEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        canDisableThinking: false
      })
    )
    expect(map).toEqual({
      off: null,
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max'
    })
  })

  it('非推理模型不产出 thinkingLevelMap', () => {
    const p = remoteModelToPi({
      id: 'plain',
      name: 'P',
      supportsReasoning: false,
      reasoning: { supportedEfforts: ['low', 'high'] }
    })
    expect(p.reasoning).toBe(false)
    expect(p.thinkingLevelMap).toBeUndefined()
  })
})

describe('DiscoveryCache 瞬时失败降级保护', () => {
  it('失败不缓存为成功：返回 null 而非 [auto] 兜底', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'))
    const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn })
    // 原实现会把 [DEFAULT_MODEL] 当成功结果缓存 5min TTL；修复后失败返回 null
    await expect(c.get('t', {})).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('失败冷却：同一启动内第二个触发点不再请求、不再提示', async () => {
    // 交互式启动有两个触发点先后调到这里（本扩展的 session_start 后台发现，
    // 以及 pi 自己的 refreshModelCatalogs）；离线时曾经两次都发请求、各报一条相同警告。
    const e = new Error('model discovery: fetch failed')
    const fetchFn = vi.fn().mockRejectedValue(e)
    const onFailure = vi.fn()
    const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn, onFailure })
    await expect(c.get('t', {})).resolves.toBeNull()
    await expect(c.get('t', {})).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(onFailure).toHaveBeenCalledTimes(1)
  })

  it('冷却期内有旧数据时返回旧数据（且不再请求）', async () => {
    const good = [{ id: 'm1', name: 'M1' }]
    let fail = false
    const fetchFn = vi
      .fn()
      .mockImplementation(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(good)))
    const c = new DiscoveryCache({ ttlMs: 10, fetchFn })
    await c.get('t', {})
    await new Promise((r) => setTimeout(r, 20)) // TTL 过期
    fail = true
    expect(await c.get('t', {})).toEqual(good) // 发请求并失败，但有旧数据兑住（stale-while-revalidate）
    expect(fetchFn).toHaveBeenCalledTimes(2)
    // 冷却期内：既不重新请求，也不返回 null
    expect(await c.get('t', {})).toEqual(good)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('在途失败时并发等待者也拿到旧数据（而非 null）', async () => {
    // 回归测试：原实现直接 return inflight，失败时并发调用会拿到 null，
    // 即使手上有旧数据（stale-while-revalidate 失效）
    const good = [{ id: 'm1', name: 'M1' }]
    let fail = false
    const fetchFn = vi
      .fn()
      .mockImplementation(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(good)))
    const c = new DiscoveryCache({ ttlMs: 10, fetchFn })
    await c.get('t', {})
    await new Promise((r) => setTimeout(r, 20))
    fail = true
    const [a, b] = await Promise.all([c.get('t', {}), c.get('t', {})])
    expect(a).toEqual(good)
    expect(b).toEqual(good)
    expect(fetchFn).toHaveBeenCalledTimes(2) // 只发了一次新请求
  })

  it('冷却期过后会重试（不会像成功缓存那样卡住）', async () => {
    vi.useFakeTimers()
    try {
      const fetchFn = vi.fn().mockRejectedValue(new Error('down'))
      const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn })
      await c.get('t', {})
      vi.advanceTimersByTime(FAILURE_COOLDOWN_MS + 1)
      await c.get('t', {})
      expect(fetchFn).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('成功后立即恢复：冷却不影响正常命中', async () => {
    const good = [{ id: 'm1', name: 'M1' }]
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(good)
    const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn })
    await c.get('t', {})
    // 冷却期内成功路径仍能跑（cooldown 只拦「没有新结论」的重复请求）
    await c.get('t', {})
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('有旧数据时瞬时失败 → 返回旧数据（不降级）', async () => {
    let fail = false
    const good = [{ id: 'm1', name: 'M1' }]
    const fetchFn = vi
      .fn()
      .mockImplementation(() => (fail ? Promise.reject(new Error('boom')) : Promise.resolve(good)))
    const c = new DiscoveryCache({ ttlMs: 20, fetchFn })
    const first = await c.get('t', {})
    expect(first).toEqual(good)
    await new Promise((r) => setTimeout(r, 30)) // TTL 过期
    fail = true
    const second = await c.get('t', {}) // stale-while-revalidate：旧数据兜住
    expect(second).toEqual(good)
  })

  it('401/403 上抛（不吞）', async () => {
    const e = Object.assign(new Error('discovery 401'), { status: 401 })
    const c = new DiscoveryCache({ ttlMs: 1000, fetchFn: vi.fn().mockRejectedValue(e) })
    await expect(c.get('t', {})).rejects.toMatchObject({ status: 401 })
  })

  it('认证失败也进冷却：第二个触发点不再重复提示「登录已失效」', async () => {
    // 交互式启动两个触发点；token 过期时曾经两次都抛、各提示一次
    const e = Object.assign(new Error('401'), { status: 401 })
    const fetchFn = vi.fn().mockRejectedValue(e)
    const c = new DiscoveryCache({ ttlMs: 60_000, fetchFn })
    await expect(c.get('t', {})).rejects.toMatchObject({ status: 401 })
    // 冷却期内不上抛也不请求；模型列表与凭据无关，有缓存则照常返回
    await expect(c.get('t', {})).resolves.toBeNull()
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('认证失败冷却期内仍返回旧模型列表（token 过期不影响列表有效性）', async () => {
    const good = [{ id: 'm1', name: 'M1' }]
    const fetchFn = vi.fn().mockResolvedValue(good)
    const c = new DiscoveryCache({ ttlMs: 10, fetchFn })
    await c.get('t', {})
    await new Promise((r) => setTimeout(r, 20))
    fetchFn.mockRejectedValue(Object.assign(new Error('401'), { status: 401 }))
    await expect(c.get('t', {})).rejects.toMatchObject({ status: 401 })
    await expect(c.get('t', {})).resolves.toEqual(good)
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })
})

describe('fetchRemoteModels（/v3/config 发现）', () => {
  const SERVER = { url: 'https://x', domain: 'd' }
  /** 用真实响应形状：agents 分派清单 + models 详情 */
  const okBody = {
    code: 0,
    data: {
      agents: [{ name: 'craft', models: ['m1', 'm2', 'no-tool'] }],
      models: [
        { id: 'm1', name: 'M1' },
        { id: 'm2', name: 'M2' },
        { id: 'no-tool', name: 'N', supportsToolCall: false }
      ]
    }
  }

  function stubFetch(body: unknown, status = 200) {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' }
          })
      )
    )
  }

  afterEach(() => vi.unstubAllGlobals())

  it('按 craft 清单取模型，滤掉不支持工具调用的', async () => {
    stubFetch(okBody)
    const models = await fetchRemoteModels('t', SERVER)
    expect(models.map((m) => m.id)).toEqual(['m1', 'm2'])
  })

  it('HTTP 400 + 上游错误体 → 抛 DiscoveryError（带 status 与错误码）', async () => {
    stubFetch(
      { code: 11151, msg: 'a message has empty content', displayMsg: { zh: '存在空白消息' } },
      400
    )
    await expect(fetchRemoteModels('t', SERVER)).rejects.toMatchObject({ status: 400 })
    await expect(fetchRemoteModels('t', SERVER)).rejects.toThrow(/存在空白消息/)
  })

  it('HTTP 200 但 code≠0 → 抛出（不再静默返回空）', async () => {
    stubFetch({ code: 12403, msg: 'check ua' })
    await expect(fetchRemoteModels('t', SERVER)).rejects.toThrow(/12403/)
  })

  it('无效凭据：200/code 0 但 agents 与 models 均为 null → 抛出而非 [auto]', async () => {
    // 实测：token 无效时上游仍回 200/code 0，字段形状不同（data.agent 而非 data.agents）
    stubFetch({ code: 0, msg: 'OK', data: { agent: { agents: null }, models: null } })
    await expect(fetchRemoteModels('t', SERVER)).rejects.toThrow(/未返回任何模型/)
  })

  it('网络失败 → 抛出（由 DiscoveryCache 决定降级）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new Error('boom')))
    )
    await expect(fetchRemoteModels('t', SERVER)).rejects.toThrow()
  })
})
