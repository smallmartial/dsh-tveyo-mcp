/**
 * 插件自带的回环 HTTP 服务，只为 OAuth 而存在。
 *
 * 为什么不复用 DSH 的 webServer：
 *   OAuth 的 redirect_uri 必须与动态注册时提交的值逐字一致，而 DSH 的
 *   端口是每次启动随机分配的。若跟着它变，客户端注册和令牌都会失效，
 *   用户每次重启都要重新授权。这里固定一组回环端口，把 redirect_uri
 *   钉死，注册信息与刷新令牌才能跨重启存活。
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
  const withoutPort = hostHeader.replace(/:\d+$/, '')
  return withoutPort
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

/** 状态页：只展示本地状态，不渲染任何远端内容。 */
function statusPage(state) {
  const rows = [
    ['状态', state.label],
    ['账号', state.account ?? '—'],
    [
      '空间',
      state.spaces?.length
        ? state.spaces.map((space) => `${space.name}（${space.kind === 'personal' ? '个人' : '团队'}）`).join('、')
        : '—',
    ],
    ['能力', state.scopes?.length ? state.scopes.join('、') : '—'],
    ['工具', state.tools?.length ? state.tools.join('、') : '—'],
    ['令牌到期', state.expiresAt ? new Date(state.expiresAt).toLocaleString('zh-CN') : '—'],
  ]
  const actions = state.connected
    ? '<form method="post" action="/disconnect"><button type="submit">断开连接</button></form>'
    : '<a class="primary" href="/connect">连接旅映</a>'
  const error = state.lastError
    ? `<p class="error">最近一次错误：${escapeHtml(state.lastError)}</p>`
    : ''
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>旅映 MCP · DeepSeek Harness</title>
<style>
:root{color-scheme:light dark}
body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;max-width:640px;margin:48px auto;padding:0 24px}
h1{font-size:20px;margin:0 0 4px}
p.sub{color:#888;margin:0 0 28px}
table{border-collapse:collapse;width:100%}
td{padding:8px 0;border-bottom:1px solid #8883;vertical-align:top}
td:first-child{width:96px;color:#888}
button,a.primary{display:inline-block;margin-top:24px;padding:8px 18px;border-radius:8px;border:1px solid #8886;background:#3b82f6;color:#fff;text-decoration:none;font:inherit;cursor:pointer}
button{background:none;color:inherit}
p.error{margin-top:20px;padding:10px 14px;border-radius:8px;background:#ef444422;color:#ef4444}
</style>
<h1>旅映 MCP</h1><p class="sub">DeepSeek Harness 插件 · 本地授权页</p>
<table>${rows.map(([key, value]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
${actions}${error}
</body></html>`
}

/**
 * 在第一个可用端口上启动回环服务。
 *
 * @param options.handlers { getState, beginAuth, finishAuth, disconnect }
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

    if (path === '/' || path === '/index.html') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      return sendHtml(res, 200, statusPage(await handlers.getState()))
    }
    if (path === '/status') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      return sendJson(res, 200, await handlers.getState())
    }
    if (path === '/connect') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const { url: target } = await handlers.beginAuth()
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' })
        return res.end()
      } catch (error) {
        log?.('发起授权失败', error)
        return sendHtml(
          res,
          500,
          '<p>发起授权失败：' + escapeHtml(error?.message ?? error) + '</p><p><a href="/">返回</a></p>',
        )
      }
    }
    if (path === CALLBACK_PATH) {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method-not-allowed' })
      try {
        const result = await handlers.finishAuth(url.searchParams)
        if (result.ok) {
          res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' })
          return res.end()
        }
        return sendHtml(
          res,
          400,
          '<p>授权未完成：' + escapeHtml(result.message ?? '') + '</p><p><a href="/">返回</a></p>',
        )
      } catch (error) {
        log?.('授权回调失败', error)
        return sendHtml(
          res,
          400,
          '<p>授权回调失败：' + escapeHtml(error?.message ?? error) + '</p><p><a href="/">返回</a></p>',
        )
      }
    }
    if (path === '/disconnect') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      await handlers.disconnect()
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store' })
      return res.end()
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
      log?.(`本地授权页：${origin}`)
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
    `无法绑定本地授权端口（${CANDIDATE_PORTS.join(' / ')}）：${lastError?.message ?? '未知原因'}`,
  )
}
