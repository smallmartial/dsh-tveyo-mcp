/**
 * OAuth 记录管理测试（不联网）。
 *
 * 覆盖两个曾经出问题的场景：
 *   1. 端口变化后仍能沿用同一个 client（注册时提交了全部候选端口）；
 *   2. 换了 client_id 时旧令牌必须被丢弃，否则 token 端点报 invalid_grant。
 */
import { createOAuthProvider, createVolatileAuthState } from '../lib/oauth.js'

const SCOPE = 'videos:read offline_access'
const PORTS = [45871, 45872, 45873]
const urls = PORTS.map((port) => 'http://127.0.0.1:' + port + '/oauth/callback')

/** 最小凭据服务桩：单条记录，行为与 credentials-local 一致。 */
function createCredentials(initial) {
  let record = initial
  return {
    async readRecord() {
      return record
    },
    async modifyRecord(_key, mutate) {
      const current = record
      const next = await mutate(current)
      if (next !== undefined) record = next
      return record
    },
    async deleteRecord() {
      record = undefined
    },
    peek() {
      return record
    },
  }
}

const grant = (payload) => ({ kind: 'grant', payload })

/* 1. 端口从 45871 换到 45872，仍应沿用同一个 client 与令牌 */
{
  const credentials = createCredentials(
    grant({
      redirectUrl: urls[0],
      clientInformation: { client_id: 'client-a', redirect_uris: urls },
      tokens: { access_token: 'at', refresh_token: 'rt', clientId: 'client-a' },
    }),
  )
  const provider = createOAuthProvider({
    credentials,
    redirectUrl: urls[1],
    redirectUrls: urls,
    scope: SCOPE,
    volatileState: createVolatileAuthState(),
  })
  const record = await provider.readRecord()
  if (record === undefined) throw new Error('端口变化后不应丢弃授权')
  if (record.clientInformation.client_id !== 'client-a') throw new Error('client 不应被重置')
  const tokens = await provider.provider.tokens()
  if (tokens?.refresh_token !== 'rt') throw new Error('令牌应保留')
  if (provider.provider.redirectUrl !== urls[1]) throw new Error('当前回调地址应为新端口')
  if (!provider.provider.clientMetadata.redirect_uris.includes(urls[1])) {
    throw new Error('clientMetadata 应包含全部候选端口')
  }
}

/* 2. 旧版本只注册过一个端口时，应判定为需要重新授权 */
{
  const credentials = createCredentials(
    grant({
      redirectUrl: urls[0],
      clientInformation: { client_id: 'client-old', redirect_uris: [urls[0]] },
      tokens: { access_token: 'at', refresh_token: 'rt', clientId: 'client-old' },
    }),
  )
  const provider = createOAuthProvider({
    credentials,
    redirectUrl: urls[1],
    redirectUrls: urls,
    scope: SCOPE,
    volatileState: createVolatileAuthState(),
  })
  const record = await provider.readRecord()
  if (record !== undefined) throw new Error('已注册地址不含当前端口时应视为未授权')
}

/* 3. 换了 client_id，旧令牌必须清掉 */
{
  const credentials = createCredentials(
    grant({
      redirectUrl: urls[0],
      clientInformation: { client_id: 'client-old', redirect_uris: urls },
      tokens: { access_token: 'old', refresh_token: 'old-rt', clientId: 'client-old' },
    }),
  )
  const provider = createOAuthProvider({
    credentials,
    redirectUrl: urls[0],
    redirectUrls: urls,
    scope: SCOPE,
    volatileState: createVolatileAuthState(),
  })
  await provider.provider.saveClientInformation({ client_id: 'client-new', redirect_uris: urls })
  const stored = credentials.peek()
  if (stored.payload.tokens !== undefined) throw new Error('换 client 后旧令牌应被删除')
  const tokens = await provider.provider.tokens()
  if (tokens !== undefined) throw new Error('旧令牌不应再被读出')
}

/* 4. 同一 client 刷新令牌时不应误删 */
{
  const credentials = createCredentials(
    grant({
      redirectUrl: urls[0],
      clientInformation: { client_id: 'client-a', redirect_uris: urls },
      tokens: { access_token: 'at', refresh_token: 'rt', clientId: 'client-a' },
    }),
  )
  const provider = createOAuthProvider({
    credentials,
    redirectUrl: urls[0],
    redirectUrls: urls,
    scope: SCOPE,
    volatileState: createVolatileAuthState(),
  })
  await provider.provider.saveTokens({ access_token: 'at2', refresh_token: 'rt2' })
  const tokens = await provider.provider.tokens()
  if (tokens?.refresh_token !== 'rt2') throw new Error('同 client 的令牌更新应保留')
  if (tokens?.clientId !== 'client-a') throw new Error('令牌应记录签发它的 client')
}

console.log('oauth record ok: 4 scenarios')
