// 日志通道测试
//
// 关键行为：绑定 UI 后不得再写 console —— 交互模式（fullscreen）下 stderr 无人接管，
// 直写会把 TUI 画花（表现为警告糊在输入框上）。未绑定时回退 console 供 print/JSON 模式诊断。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test'

import { createLogger } from '../src/log.ts'

describe('createLogger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    logSpy.mockRestore()
  })

  it('未绑定 UI：warn 走 console.error，info 走 console.log', () => {
    const logger = createLogger()
    logger.warn('w')
    logger.info('i')
    expect(errorSpy).toHaveBeenCalledOnce()
    expect(logSpy).toHaveBeenCalledOnce()
    expect(errorSpy.mock.calls[0][0]).toContain('[codebuddy] warn: w')
    expect(logSpy.mock.calls[0][0]).toContain('[codebuddy] info: i')
  })

  it('绑定 UI 后：不再写 console，改走 notify', () => {
    const logger = createLogger()
    const notify = vi.fn()
    logger.bindUI({ notify })
    logger.warn('列表未更新')
    logger.error('认证失败')
    logger.info('普通信息')
    // 这是本测试的核心断言：交互模式下任何 console 写入都会破坏 TUI
    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
    expect(notify.mock.calls).toEqual([
      ['列表未更新', 'warning'],
      ['认证失败', 'error'],
      ['普通信息', 'info']
    ])
  })

  it('绑定时不带 [codebuddy] 前缀：notify 是用户可见提示，不应暴露内部前缀', () => {
    const logger = createLogger()
    const notify = vi.fn()
    logger.bindUI({ notify })
    logger.warn('CodeBuddy 模型列表未更新')
    expect(notify).toHaveBeenCalledWith('CodeBuddy 模型列表未更新', 'warning')
  })

  it('解绑后恢复 console 兜底', () => {
    const logger = createLogger()
    const notify = vi.fn()
    logger.bindUI({ notify })
    logger.bindUI(undefined)
    logger.warn('again')
    expect(notify).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledOnce()
  })

  it('silence 后不输出：ctx 失效而 TUI 仍在，写 console 会破坏终端', () => {
    const logger = createLogger()
    const notify = vi.fn()
    logger.bindUI({ notify })
    logger.silence()
    logger.warn('reload 前发起的发现失败了')
    expect(notify).not.toHaveBeenCalled()
    expect(errorSpy).not.toHaveBeenCalled()
    expect(logSpy).not.toHaveBeenCalled()
  })

  it('silence 后重新 bindUI 可恢复输出（会话替换后新一轮）', () => {
    const logger = createLogger()
    logger.bindUI({ notify: vi.fn() })
    logger.silence()
    const notify2 = vi.fn()
    logger.bindUI({ notify: notify2 })
    logger.warn('新会话')
    expect(notify2).toHaveBeenCalledWith('新会话', 'warning')
    expect(errorSpy).not.toHaveBeenCalled()
  })
})
