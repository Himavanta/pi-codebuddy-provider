import { describe, it, expect } from 'vite-plus/test'

import {
  formatUpstreamError,
  isCreditExhausted,
  parseUpstreamError
} from '../src/upstream-error.ts'

describe('parseUpstreamError', () => {
  it('解析真实上游结构（displayMsg / displayTips 三语）', () => {
    const info = parseUpstreamError(
      JSON.stringify({
        code: 11151,
        msg: 'a message has empty content, please check the conversation history and retry',
        displayMsg: {
          en: 'Empty message found. Please complete it and retry',
          zh: '存在空白消息，请补全后重试',
          'zh-hant': '存在空白訊息，請補全後重試'
        },
        displayTips: {
          zh: '对话里有内容为空的消息，模型无法处理。请补全内容，或新建任务重新发送。'
        }
      })
    )
    expect(info.structured).toBe(true)
    expect(info.code).toBe(11151)
    expect(info.display).toBe('存在空白消息，请补全后重试')
    expect(info.tips).toContain('请补全内容')
  })

  it('只有 en 时回退英文', () => {
    const info = parseUpstreamError(
      JSON.stringify({ code: 1, msg: 'x', displayMsg: { en: 'English only' } })
    )
    expect(info.display).toBe('English only')
  })

  it('zh 缺 zh-hant 时取 zh-hant', () => {
    const info = parseUpstreamError(
      JSON.stringify({ code: 1, displayMsg: { 'zh-hant': '繁體', en: 'EN' } })
    )
    expect(info.display).toBe('繁體')
  })

  it('字段为空串时视为缺失', () => {
    const info = parseUpstreamError(
      JSON.stringify({ code: 5, msg: 'fallback', displayMsg: { zh: '   ' } })
    )
    expect(info.display).toBeUndefined()
    expect(info.msg).toBe('fallback')
  })

  it('非 JSON（HTML / 纯文本）→ structured=false', () => {
    expect(parseUpstreamError('<html><head><title>401</title></head></html>').structured).toBe(
      false
    )
    expect(parseUpstreamError('boom').structured).toBe(false)
    expect(parseUpstreamError('').structured).toBe(false)
  })

  it('JSON 但无可用字段 → structured=false', () => {
    expect(parseUpstreamError('{}').structured).toBe(false)
    expect(parseUpstreamError('[]').structured).toBe(false)
    expect(parseUpstreamError('null').structured).toBe(false)
    expect(parseUpstreamError('{"a":1}').structured).toBe(false)
  })

  it('兼容 OpenAI 风格的 error 包裹', () => {
    const info = parseUpstreamError(JSON.stringify({ error: { message: 'wrapped', code: 'x' } }))
    expect(info.structured).toBe(true)
    expect(info.msg).toBe('wrapped')
    expect(info.code).toBe('x')
  })
})

describe('formatUpstreamError', () => {
  it('用 displayMsg 作主文案，附 tips', () => {
    const info = parseUpstreamError(
      JSON.stringify({
        code: 11102,
        msg: 'model [x] service info not found',
        displayMsg: { zh: '当前模型不可用，请切换模型' },
        displayTips: { zh: '这个模型没有接入或缺少配置，服务端无法调用。' }
      })
    )
    const s = formatUpstreamError(info, 400, '')
    expect(s).toContain('当前模型不可用，请切换模型')
    expect(s).toContain('11102')
    expect(s).toContain('这个模型没有接入或缺少配置')
    // 不再把原始 JSON 交给用户
    expect(s).not.toContain('service info not found')
  })

  it('12403 用内置提示（上游没有 displayTips）', () => {
    const info = parseUpstreamError(
      JSON.stringify({ code: 12403, msg: 'check ua, get coding copilot version error' })
    )
    const s = formatUpstreamError(info, 400, '')
    expect(s).toContain('check ua, get coding copilot version error')
    expect(s).toContain('版本常量可能已过期')
  })

  it('HTML → 给状态码与简短说明，不塞标签', () => {
    const html = '<html><head><title>401 Authorization Required</title></head></html>'
    const s = formatUpstreamError(parseUpstreamError(html), 401, html)
    expect(s).toContain('401')
    expect(s).toContain('HTML')
    expect(s).not.toContain('<html>')
  })

  it('JSON 里的 HTML 片段不会被当成标签处理', () => {
    // 上游 msg 若含 "<"，仍走结构化分支（JSON 解析成功优先）
    const info = parseUpstreamError(JSON.stringify({ code: 1, msg: '<b>bold</b>' }))
    expect(info.structured).toBe(true)
    expect(formatUpstreamError(info, 400, '')).toContain('<b>bold</b>')
  })

  it('无 body 的空响应', () => {
    expect(formatUpstreamError(parseUpstreamError(''), 500, '')).toContain('未返回响应体')
  })

  it('纯文本错误附上原文', () => {
    const s = formatUpstreamError(parseUpstreamError('boom'), 502, 'boom')
    expect(s).toContain('502')
    expect(s).toContain('boom')
  })
})

describe('isCreditExhausted', () => {
  it('识别额度 / 余额耗尽（含 14018 Credits exhausted）', () => {
    expect(isCreditExhausted('Credits exhausted. Please visit the link below')).toBe(true)
    expect(isCreditExhausted('insufficient_quota')).toBe(true)
    expect(isCreditExhausted('余额不足，请充值')).toBe(true)
    expect(isCreditExhausted('out of credit')).toBe(true)
  })

  it('普通限流不算额度耗尽', () => {
    expect(isCreditExhausted('Rate limit exceeded, too many requests')).toBe(false)
    expect(isCreditExhausted('')).toBe(false)
    expect(isCreditExhausted('{"code":11133}')).toBe(false)
  })
})
