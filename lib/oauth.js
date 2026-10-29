/**
 * 旅映 MCP 的 OAuth 客户端提供者。
 *
 * 旅映服务端用 @cloudflare/workers-oauth-provider：
 *   - /api/mcp 未授权返回 401 + WWW-Authenticate（resource_metadata 指向
 *     /.well-known/oauth-protected-resource/api/mcp）
 *   - 授权服务器支持动态客户端注册、PKCE S256、refresh_token、RFC 7009 撤销
 *   - 回调只接受本机 loopback
 *
 * 这里只做"把 MCP SDK 的 OAuthClientProvider 接口接到 DSH 凭据存储"，
 * 协议细节（发现、PKCE、DCR、刷新）全部交给 @modelcontextprotocol/client。
 */
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** 插件在凭据存储里的作用域名。 */
export const CREDENTIAL_SCOPE = 'dsh-tveyo-mcp'
/** OAuth 授权记录（access/refresh token + 客户端注册信息）的 id。 */
export const OAUTH_RECORD = 'oauth'
/** 回调路径；必须与动态注册时提交的 redirect_uri 完全一致。 */
export const CALLBACK_PATH = '/oauth/callback'

/**
 * 一次授权流程中只在内存里存在的易失状态。
 *
 * codeVerifier 与 state 必须跨"发起授权 → 浏览器回来"存活，但它们属于
 * 同一次流程、失败即作废，写进磁盘只会留下无法回收的垃圾。进程重启后
 * 用户重新点一次连接即可。
 */
export function createVolatileAuthState() {
  let verifier
  let state
  let pendingUrl
  return {
    get verifier() {
      return verifier
    },
    get state() {
      return state
    },
    /** SDK 拼好的授权地址；flow 用它通知界面并打开浏览器。 */
    get pendingUrl() {
      return pendingUrl
    },
    setVerifier(value) {
      verifier = value
    },
    setState(value) {
      state = value
    },
    setPendingUrl(value) {
      pendingUrl = value
    },
    clear() {
      verifier = undefined
      state = undefined
      pendingUrl = undefined
    },
  }
}

/**
 * 构造 OAuthClientProvider。
 *
 * @param options.credentials  DSH 凭据服务（ctx.credentials）
 * @param options.redirectUrl  完整回调地址，形如 http://127.0.0.1:45871/oauth/callback
 * @param options.scope        申请的能力，空格分隔
 * @param options.volatileState 见 createVolatileAuthState
 * @param options.log          日志
 */
export function createOAuthProvider(options) {
  const { credentials, redirectUrl, scope, volatileState, log } = options
  const key = credentialKey(CREDENTIAL_SCOPE, OAUTH_RECORD)

  /**
   * 读取整条授权记录。
   *
   * redirect_uri 变了意味着本地授权端口变了：旧 client_id 与旧 refresh_token
   * 都绑在那个回调地址上，继续用只会在刷新时失败。此时按"没有授权"处理，
   * 让用户重新连一次，而不是抛一个看不懂的 OAuth 错误。
   */
  async function readRecord() {
    const hit = await credentials.readRecord(key)
    if (hit === undefined || hit.kind !== 'grant') return undefined
    const payload = hit.payload
    if (payload?.redirectUrl !== redirectUrl) {
      log?.('本地授权端口已变化，旧授权作废，需要重新连接')
      return undefined
    }
    return payload
  }

  /** 读-改-写；mutate 返回 undefined 表示保持原样。 */
  async function updateRecord(mutate) {
    return credentials.modifyRecord(key, async (current) => {
      const payload = current?.kind === 'grant' ? current.payload : {}
      const next = await mutate(payload)
      return next === undefined ? current : { kind: 'grant', payload: next }
    })
  }

  const provider = {
    get redirectUrl() {
      return redirectUrl
    },

    get clientMetadata() {
      return {
        client_name: 'dsh-tveyo-mcp',
        client_uri: 'https://app.tveyo.com',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope,
      }
    },

    async clientInformation() {
      const record = await readRecord()
      return record?.clientInformation
    },

    async saveClientInformation(info) {
      await updateRecord((payload) => ({ ...payload, redirectUrl, clientInformation: info }))
    },

    async tokens() {
      const record = await readRecord()
      return record?.tokens
    },

    async saveTokens(tokens) {
      await updateRecord((payload) => ({ ...payload, redirectUrl, tokens }))
    },

    async saveCodeVerifier(verifier) {
      volatileState.setVerifier(verifier)
    },

    async codeVerifier() {
      const verifier = volatileState.verifier
      if (verifier === undefined) throw new Error('授权流程已失效，请重新连接旅映')
      return verifier
    },

    async redirectToAuthorization(url) {
      /* 只记录地址；打开浏览器与通知界面由 authorization flow 负责。 */
      volatileState.setPendingUrl(url.href)
    },

    async invalidateCredentials(scopeKind) {
      await updateRecord((payload) => {
        const next = { ...payload }
        if (scopeKind === 'all' || scopeKind === 'client') delete next.clientInformation
        if (scopeKind === 'all' || scopeKind === 'tokens') delete next.tokens
        return next
      })
    },
  }

  return {
    provider,
    readRecord,
    /** 撤销连接：删除整条记录，下次使用会重新走授权。 */
    async clear() {
      await credentials.deleteRecord(key)
      volatileState.clear()
    },
  }
}

/**
 * 向旅映撤销一个 refresh token（RFC 7009）。
 *
 * 旅映把 revocation_endpoint 指向 /oauth/token，实测无效 token 返回 200，
 * 说明按规范实现。撤销失败不阻断本地清理：本地记录已删，下次必须重新授权，
 * 旅映侧的 grant 最迟在令牌过期后失效。
 *
 * @returns 是否成功撤销
 */
export async function revokeAtServer(options) {
  const { token, clientId, tokenEndpoint, log } = options
  if (token === undefined || clientId === undefined) return false
  try {
    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token,
        token_type_hint: 'refresh_token',
        client_id: clientId,
      }),
    })
    if (!response.ok) {
      log?.('旅映撤销返回 ' + response.status + '，本地记录仍会删除')
      return false
    }
    return true
  } catch (error) {
    log?.('旅映撤销请求失败：' + String(error?.message ?? error))
    return false
  }
}
