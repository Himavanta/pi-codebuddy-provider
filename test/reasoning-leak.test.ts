import { describe, it, expect } from 'vite-plus/test'

import {
  createLeakState,
  rewriteDataPayload,
  rewriteLeakedReasoningStream,
  rewriteSseLine,
  isEventStreamResponse,
  type LeakRewriteState
} from '../src/reasoning-leak.ts'

const enc = new TextEncoder()
/**
 * 上游泄漏的思考分隔符。这里用拼接写，避免测试源码里出现真模板标记而被其他工具误读。
 * CLOSE = 带会话 id 的闭合标记（唯一可安全判定“前面是思考”的形态）
 * BARE  = 无 id 的裸开/闭标记（只删除，不改变文本归属）
 */
const CLOSE = ['<', '/think:6124c78e>'].join('')
const BARE = ['<', '/th', 'ink>', '<', 'think>'].join('')
const dataLine = (delta: unknown) =>
  'data: ' + JSON.stringify({ id: 'c1', choices: [{ index: 0, delta }] })

/** 把若干 SSE 文本块喂给流改写器，返回解析后的 content / reasoning 累积结果。 */
async function feed(chunks: string[], state: LeakRewriteState = createLeakState()) {
  const src = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch))
      c.close()
    }
  })
  let buf = ''
  const out = rewriteLeakedReasoningStream(src, state)
  const reader = out.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += new TextDecoder().decode(value, { stream: true })
  }
  let content = '',
    reasoning = ''
  for (const line of buf.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '[DONE]') continue
    const delta = JSON.parse(payload)?.choices?.[0]?.delta ?? {}
    if (typeof delta.content === 'string') content += delta.content
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content
  }
  return { content, reasoning, state }
}

describe('reasoning-leak（上游把思考泄漏进 delta.content）', () => {
  // 实测形态：codebuddy/hy4-preview 把自我复读的思考草稿混进 content，
  // 并以 </think:会话id> 收尾，之后才是真回答。
  it('闭合标记之前的文本改道 reasoning_content，标记本身删除', async () => {
    const { content, reasoning, state } = await feed([
      dataLine({
        content: 'Let me run.\n\nLet me run.\n\nLet me check.' + CLOSE + 'Typecheck passes.'
      }) + '\n\n',
      'data: [DONE]\n\n'
    ])
    expect(content).toBe('Typecheck passes.')
    expect(reasoning).toBe('Let me run.\n\nLet me run.\n\nLet me check.')
    expect(state.markersRemoved).toBe(1)
    expect(state.charsToReasoning).toBe(reasoning.length)
  })

  it('多个思考段：每段都改道，最后一段正文留在 content', async () => {
    const { content, reasoning } = await feed([
      dataLine({ content: '草稿一</think:aaaaaaaa>回答一' }) + '\n',
      dataLine({ content: '草稿二</think:bbbbbbbb>最终答案' }) + '\n',
      'data: [DONE]\n'
    ])
    expect(content).toBe('回答一最终答案')
    expect(reasoning).toBe('草稿一草稿二')
  })

  it('标记被拆到两个 SSE 事件也能重组（不打印半个标记）', async () => {
    const { content } = await feed([
      dataLine({ content: 'blah blah </thi' }) + '\n',
      dataLine({ content: 'nk:6124c78e>REAL' }) + '\n',
      'data: [DONE]\n'
    ])
    expect(content).not.toContain('think')
    expect(content).toContain('REAL')
  })

  it('多字节 UTF-8 被切断也不产生乱码', async () => {
    const line = dataLine({ content: '中文测试' + CLOSE + '中文继续' }) + '\n'
    const bytes = enc.encode(line)
    const cut = Math.floor(bytes.length / 2)
    const { content, reasoning } = await feed(
      [bytes.slice(0, cut), bytes.slice(cut)].map((b) => new TextDecoder().decode(b))
    )
    expect(content).toBe('中文继续')
    expect(reasoning).toBe('中文测试')
  })

  it('裸标记（无 :id）只删除，不改变文本归属', async () => {
    const { content, reasoning } = await feed([
      dataLine({ content: '前' + BARE + '后' }) + '\n',
      'data: [DONE]\n'
    ])
    expect(content).toBe('前后')
    expect(reasoning).toBe('')
  })

  it('无标记时零改动透传', async () => {
    const line = dataLine({ content: '普通正文 a<b 与代码块' }) + '\n'
    const { content, state } = await feed([line, 'data: [DONE]\n'])
    expect(content).toBe('普通正文 a<b 与代码块')
    expect(state.eventsRewritten).toBe(0)
  })

  it('tool_calls / [DONE] / 非 data 行原样透传', () => {
    const st = createLeakState()
    expect(rewriteSseLine('event: foo', st)).toBe('event: foo')
    expect(rewriteSseLine('data: [DONE]', st)).toBe('data: [DONE]')
    const withTools = dataLine({ tool_calls: [{ index: 0, id: 't1' }] })
    expect(rewriteSseLine(withTools, st)).toBe(withTools)
    expect(st.eventsRewritten).toBe(0)
  })

  it('流结束时补发暂扣文本，不丢字符', async () => {
    const { content } = await feed([dataLine({ content: '结尾留一个 <' }) + '\n'])
    expect(content).toBe('结尾留一个 <')
  })

  it('rewriteDataPayload 对非 JSON / 空载荷返回 null', () => {
    const st = createLeakState()
    expect(rewriteDataPayload('[DONE]', st)).toBeNull()
    expect(rewriteDataPayload('{ not json', st)).toBeNull()
    expect(rewriteDataPayload(JSON.stringify({ choices: [] }), st)).toBeNull()
  })

  it('isEventStreamResponse 只认 SSE/ndjson', () => {
    expect(isEventStreamResponse('text/event-stream')).toBe(true)
    expect(isEventStreamResponse('text/event-stream; charset=utf-8')).toBe(true)
    expect(isEventStreamResponse('application/json')).toBe(false)
    expect(isEventStreamResponse(null)).toBe(false)
  })
})
