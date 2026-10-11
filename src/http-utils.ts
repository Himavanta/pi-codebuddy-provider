// 通用 HTTP 原语：URL 归一、响应头清洗、JSON/文本响应构造、可中止等待

/**
 * 取请求的真实 URL。
 *
 * url 可能是 string / URL / Request 三态：Request 的 toString() 会得到
 * "[object Request]"，导致路径匹配失败并静默绕过认证与重试。
 */
export function resolveRequestUrl(url: RequestInfo | URL): string {
  if (url instanceof Request) return url.url
  return typeof url === 'string' ? url : url.href
}

/** 复制响应头并去掉实体会话字段：改写后的 SSE 长度/编码已变，留着会误导 SDK。 */
export function headersWithoutEntity(headers: Headers): Headers {
  const h = new Headers(headers)
  h.delete('content-length')
  h.delete('content-encoding')
  h.delete('transfer-encoding')
  return h
}

/** 复制响应头并覆写 Content-Type 为 JSON。 */
function withJsonContentType(headers: Headers): Headers {
  const h = new Headers(headers)
  h.set('Content-Type', 'application/json')
  return h
}

/** 构造 JSON 响应；无论是否传入 headers，Content-Type 一律为 JSON。 */
export function jsonResponse(body: unknown, status: number, headers?: Headers): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: withJsonContentType(headers ?? new Headers())
  })
}

/** 原样透传文本内容的响应（不重新序列化 body，仅统一 Content-Type）。 */
export function textResponse(text: string, status: number, headers: Headers): Response {
  return new Response(text, { status, headers: withJsonContentType(headers) })
}

/** 读取响应文本；body 已被消费或不可读时返回空串，绝不抛错。 */
export async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

/** 可被 AbortSignal 中断的 sleep；中止时 reject，供调用方 break 重试循环。 */
export function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
