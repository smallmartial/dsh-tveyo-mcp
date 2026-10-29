/**
 * 旅映 MCP 连接管理：一个 Client + 一条 Streamable HTTP 传输。
 *
 * 职责边界：
 *   - 连接/重连/断开由本模块负责，工具层只问"现在能不能用"；
 *   - 工具列表来自远端 tools/list，不在本地写死，服务端加工具不用改插件；
 *   - 401 由 MCP SDK 自己走 OAuth（authProvider），本模块只在彻底失败时降级。
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

/** 连接状态，供状态页和工具层读取。 */
export const STATE = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  READY: 'ready',
  NEEDS_AUTH: 'needs-auth',
  ERROR: 'error',
}

/**
 * 建立一条连接。
 *
 * @param options.url            MCP 端点
 * @param options.oauthProvider  见 oauth.js 的 provider
 * @param options.clientInfo     上报给旅映的客户端标识
 * @param options.log            日志
 * @returns 连接对象；调用方负责 connect() 与 close()
 */
export function createConnection(options) {
  const { url, oauthProvider, clientInfo, log } = options

  const client = new Client(clientInfo, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: oauthProvider,
  })

  return { client, transport }
}

/**
 * 把一次连接的失败翻译成对用户有意义的下一步。
 *
 * MCP SDK 在需要授权时会抛 UnauthorizedError（"redirect initiated"），
 * 这不是错误而是正常流程的一环，必须与真正的网络/协议失败区分开。
 */
export function classifyConnectionError(error) {
  const name = error?.name ?? ''
  const message = String(error?.message ?? error)

  if (name === 'UnauthorizedError' || /authentication requires user authorization/i.test(message)) {
    return {
      state: STATE.NEEDS_AUTH,
      message: '需要完成旅映授权',
      detail: '点击状态页的「连接旅映」按钮，在浏览器中登录并选择空间。',
    }
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message)) {
    return {
      state: STATE.ERROR,
      message: '无法连接旅映',
      detail: '检查网络与 https://app.tveyo.com 是否可达。',
    }
  }
  return { state: STATE.ERROR, message: '连接失败', detail: message.slice(0, 500) }
}

/**
 * 带退避的重连包装。
 *
 * 只对"可重试"的失败退避；授权缺失必须立刻停下等用户，否则会反复弹出浏览器。
 */
export async function connectWithRetry(options) {
  const { connect, onState, maxAttempts = 3, baseDelayMs = 500, log } = options
  let lastError
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      onState(STATE.CONNECTING, attempt === 1 ? '正在连接旅映…' : `第 ${attempt} 次重试…`)
      await connect()
      onState(STATE.READY, '已连接')
      return { ok: true }
    } catch (error) {
      lastError = error
      const verdict = classifyConnectionError(error)
      if (verdict.state === STATE.NEEDS_AUTH) {
        onState(STATE.NEEDS_AUTH, verdict.message)
        return { ok: false, needsAuth: true, error }
      }
      log?.(`连接失败（第 ${attempt} 次）：${verdict.detail}`)
      if (attempt === maxAttempts) break
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)))
    }
  }
  const verdict = classifyConnectionError(lastError)
  onState(verdict.state, verdict.message)
  return { ok: false, error: lastError }
}
