// 日志：warn/error 走 stderr，info 走 stdout
//
// 通道选择依据 pi 文档（docs/cli-integration.md）：
//   "Stdout is reserved for JSONL. Diagnostics and application logging are
//    written to stderr."
// 非交互模式下 pi 会接管 stdout 并将其重定向到 stderr
// （core/output-guard.js:takeOverStdout），因此不能依赖 stdout 传诊断信息。
export interface Logger {
  /** 接口占位：pi 无 client.app.log 对等机制，当前无调用方；保留以对齐上游 opencode 版的 Logger 形状。 */
  debug(m: string, extra?: object): void
  info(m: string, extra?: object): void
  warn(m: string, extra?: object): void
  error(m: string, extra?: object): void
}
export function createLogger(prefix = 'codebuddy'): Logger {
  const sink = (level: string, message: string, extra?: object) => {
    const line = `[${prefix}] ${level}: ${message}`
    if (level === 'warn' || level === 'error') console.error(line, extra ?? '')
    else if (level === 'info') console.log(line, extra ?? '')
  }
  return {
    // 有意空实现：见接口注释。需要实际输出时请用 info/warn/error。
    debug: () => {},
    info: (m, e) => sink('info', m, e),
    warn: (m, e) => sink('warn', m, e),
    error: (m, e) => sink('error', m, e)
  }
}
