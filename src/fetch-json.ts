// 带超时与中止支持的 JSON 请求
function withTimeout(ms: number, external?: AbortSignal) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  const onAbort = () => ctrl.abort()
  if (external) {
    if (external.aborted) ctrl.abort()
    else external.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: ctrl.signal,
    cancel: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', onAbort)
    }
  }
}
export async function fetchJson<T>(
  url: string,
  opts: {
    method?: string
    headers?: Record<string, string>
    body?: string
    timeoutMs: number
    signal?: AbortSignal
  }
) {
  const t = withTimeout(opts.timeoutMs, opts.signal)
  if (t.signal.aborted) {
    t.cancel()
    return { ok: false as const, text: 'timeout or abort' }
  }
  try {
    // fetch 在 signal 中止（超时或外部 abort）时会自己 reject 一个 AbortError，
    // 无需额外的手工 abortPromise / Promise.race。下面 catch 的判据已覆盖该错误。
    const res = await fetch(url, {
      method: opts.method,
      headers: opts.headers,
      body: opts.body,
      signal: t.signal
    })
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500)
      return { ok: false as const, status: res.status, text }
    }
    const data = (await res.json()) as T
    return { ok: true as const, data }
  } catch (e) {
    const err = e as Error
    const isAbort = err?.name === 'AbortError' || err?.message === 'aborted'
    return {
      ok: false as const,
      text: isAbort ? 'timeout or abort' : err?.message || 'fetch failed'
    }
  } finally {
    t.cancel()
  }
}
