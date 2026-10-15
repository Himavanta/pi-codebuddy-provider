// 日志：绑定 pi 的 UI 通知通道时走 ctx.ui.notify，否则回退 stderr/stdout
//
// 为什么必须绑定 UI：pi 只接管 stdout，且仅在非交互模式
// （main.js: shouldTakeOverStdout = appMode !== "interactive"）。交互模式（默认
// fullscreen，走备用屏）下 stderr 无人接管，console.error 会把 TUI 画花——表现为
// 警告直接糊在输入框上。ctx.ui.notify 是 pi 的正规非阻塞反馈通道
// （docs/tui.md：「非阻塞反馈 → ctx.ui.notify() 或 setStatus()」）。
//
// 绑定时机：工厂阶段拿不到 ctx（ExtensionAPI 上没有 ui），只有事件 handler 才有，
// 因此由 index.ts 在 session_start 绑定、session_shutdown 解绑。工厂阶段早于
// TUI 启动（ui.start()），此时写 stderr 仍安全。
export interface LoggerUI {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void
}
export interface Logger {
  /** 接口占位：pi 无 client.app.log 对等机制，当前无调用方；保留以对齐上游 opencode 版的 Logger 形状。 */
  debug(m: string, extra?: object): void
  info(m: string, extra?: object): void
  warn(m: string, extra?: object): void
  error(m: string, extra?: object): void
  /**
   * 接管输出通道：传入 pi 的 ctx.ui 时改走 notify，传 undefined 则恢复 console。
   * TUI 启动后必须调用（见文件头注释）；再次调用会解除 silence()。
   */
  bindUI(ui: LoggerUI | undefined): void
  /**
   * 会话结束（reload / 退出 / 会话替换）后静默。
   * 此时 ctx 已失效而 TUI 可能仍在运行，写 console 会破坏终端；
   * 也让 reload 前发起的后台发现不再输出（它的失败提示已无意义）。
   */
  silence(): void
}
/** 日志级别 → pi 通知级别（notify 的级别集合与日志级别不同名） */
const UI_LEVEL = {
  info: 'info',
  warn: 'warning',
  error: 'error'
} as const
export function createLogger(prefix = 'codebuddy'): Logger {
  let ui: LoggerUI | undefined
  let silent = false
  // extra 只在 stderr 兜底时输出：notify 是单行提示，塞诊断对象反而嘈杂
  const sink = (level: keyof typeof UI_LEVEL, message: string, extra?: object) => {
    if (silent) return
    if (ui) {
      ui.notify(message, UI_LEVEL[level])
      return
    }
    const line = `[${prefix}] ${level}: ${message}`
    if (level === 'info') console.log(line, extra ?? '')
    else console.error(line, extra ?? '')
  }
  return {
    // 有意空实现：见接口注释。需要实际输出时请用 info/warn/error。
    debug: () => {},
    info: (m, e) => sink('info', m, e),
    warn: (m, e) => sink('warn', m, e),
    error: (m, e) => sink('error', m, e),
    bindUI: (next) => {
      ui = next
      silent = false
    },
    silence: () => {
      silent = true
      ui = undefined
    }
  }
}
