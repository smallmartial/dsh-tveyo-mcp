/**
 * 插件自带的回环 HTTP 服务，只承担一件事：接住旅映的 OAuth 回调。
 *
 * 为什么必须有它：
 *   OAuth 的 redirect_uri 必须与动态注册时提交的值逐字一致，而旅映只接受
 *   https 或本机 loopback（我实测自定义 scheme 会被拒：Redirect URI must
 *   use https, or http on a loopback host）。DSH 桌面版的端口每次启动随机，
 *   跟着它漂移会让 client_id 与 refresh_token 一起失效。
 *
 * 因此：固定一组回环端口，把 redirect_uri 钉死；注册时一次提交三个端口，
 * 多实例各占一个也不会互相踢掉授权。
 *
 * 用户看不到这个端口——发起授权、展示状态都由 DSH 的插件卡片完成。
 *
 * 安全边界：
 *   - 只绑定 127.0.0.1，不监听任何外部接口；
 *   - 校验 Host 头必须是回环地址，防 DNS rebinding；
 *   - 校验 Origin（若有）必须是回环，防跨站表单；
 *   - 回调额外校验 state，防授权码注入。
 */
import { createServer } from 'node:http'

/** 候选端口：注册时一次性提交全部，运行时取第一个可用的。 */
export const CANDIDATE_PORTS = [45871, 45872, 45873]

/** 回调路径，与动态注册的 redirect_uris 保持一致。 */
export const CALLBACK_PATH = '/oauth/callback'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function hostnameOf(hostHeader) {
  if (hostHeader === undefined) return ''
  return hostHeader.replace(/:\d+$/, '')
}

/** 只接受本机访问。 */
export function requireLoopback(req, res) {
  if (!LOOPBACK_HOSTS.has(hostnameOf(req.headers.host))) {
    sendJson(res, 403, { error: 'host-not-trusted' })
    return false
  }
  const origin = req.headers.origin
  if (origin !== undefined) {
    let originHost = ''
    try {
      originHost = new URL(origin).hostname
    } catch {
      originHost = ''
    }
    if (!LOOPBACK_HOSTS.has(originHost)) {
      sendJson(res, 403, { error: 'origin-not-trusted' })
      return false
    }
  }
  return true
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

export function sendHtml(res, status, html) {
  const payload = Buffer.from(html, 'utf8')
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'",
  })
  res.end(payload)
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])

/** 回调结束后展示的极简页面；真正的状态在 DSH 卡片里。 */
function callbackPage(title, detail) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 旅映</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;max-width:520px;margin:80px auto;padding:0 24px}
h1{font-size:18px;margin:0 0 8px}
p{color:#888;margin:0}
</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>
</body></html>`
}

/**
 * 在第一个可用端口上启动回环服务。
 *
 * @param options.handlers { onCallback(searchParams) }
 * @param options.log      日志
 * @returns { origin, port, close }
 */
export async function startLoopbackServer(options) {
  const { handlers, log } = options

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      log?.('本地授权服务处理失败', error)
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 500, { error: 'internal' })
    })
  })

  async function handle(req, res) {
    if (!requireLoopback(req, res)) return
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    if (path === CALLBACK_PATH) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const result = await handlers.onCallback(url.searchParams)
        if (result.ok) return sendHtml(res, 200, callbackPage('授权完成', '可以关闭此页面，回到 DeepSeek Harness。'))
        return sendHtml(res, 400, callbackPage('授权未完成', result.message ?? '请回到 DeepSeek Harness 重试。'))
      } catch (error) {
        log?.('授权回调失败', error)
        return sendHtml(res, 400, callbackPage('授权回调失败', String(error?.message ?? error)))
      }
    }

    /* 健康检查：供卡片判断本地服务是否就绪。 */
    if (path === '/health') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      return sendJson(res, 200, { ok: true })
    }

    sendJson(res, 404, { error: 'not-found' })
  }

  let lastError
  for (const port of CANDIDATE_PORTS) {
    const bound = await new Promise((resolve) => {
      const onError = (error) => {
        server.removeListener('listening', onListening)
        resolve({ ok: false, error })
      }
      const onListening = () => {
        server.removeListener('error', onError)
        resolve({ ok: true })
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(port, '127.0.0.1')
    })
    if (bound.ok) {
      const origin = `http://127.0.0.1:${port}`
      log?.(`OAuth 回调服务：${origin}${CALLBACK_PATH}`)
      return {
        origin,
        port,
        async close() {
          await new Promise((resolve) => server.close(() => resolve()))
        },
      }
    }
    lastError = bound.error
  }
  throw new Error(
    `无法绑定本地回调端口（${CANDIDATE_PORTS.join(' / ')}）：${lastError?.message ?? '未知原因'}`,
  )
}
