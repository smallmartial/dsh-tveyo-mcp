/**
 * 客户端 bundle 的离线冒烟测试。
 *
 * 不启动浏览器，只用最小桩验证：
 *   1. factory 能执行且不抛错；
 *   2. apply() 注册了两个插件页 slot；
 *   3. 卡片在「需要授权 / 授权中 / 已连接」三种状态下渲染出正确的按钮。
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let loaded
const fakeWindow = {
  __ModuleLoader__: {
    load({ id, factory }) {
      loaded = { id, factory }
    },
  },
}
globalThis.window = fakeWindow
new Function('window', source)(fakeWindow)

if (loaded === undefined) throw new Error('client bundle did not call __ModuleLoader__.load')
if (loaded.id !== 'dsh-tveyo-mcp') throw new Error('unexpected module id: ' + loaded.id)

/* 最小 React 桩：useState 依次消费 queue 里的预设值，渲染前由 reset() 复位。 */
const queue = []
let cursor = 0
const reset = (values) => {
  queue.length = 0
  queue.push(...values)
  cursor = 0
}
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: () => [queue[cursor++], () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (value) => ({ current: value }),
}

const module = loaded.factory((name) => {
  if (name === 'react') return react
  throw new Error('unexpected require: ' + name)
})

const slots = []
const ctx = {
  slots: {
    inject: (_name, run) => run(),
    register: (entry, component) => {
      slots.push({ entry, component })
      return () => {}
    },
  },
  effect: (factory) => factory(),
  locale: { register: () => () => {}, bind: () => (key) => key },
}

if (typeof module.apply !== 'function') throw new Error('client module exports no apply')
module.apply(ctx)

if (slots.length !== 2) throw new Error('expected 2 slot registrations, got ' + slots.length)
for (const slot of slots) {
  if (slot.entry.key !== 'dsh-tveyo-mcp') throw new Error('unexpected slot key: ' + slot.entry.key)
  if (typeof slot.component !== 'function') throw new Error('slot has no component')
}

function render(state) {
  reset([state, false, null])
  return JSON.stringify(slots[0].component({}))
}

const needsAuth = render({
  connected: false,
  state: 'needs-auth',
  label: '需要授权',
  attempting: false,
  spaces: [],
  tools: [],
})
if (!needsAuth.includes('连接旅映')) throw new Error('needs-auth 状态缺少「连接旅映」按钮')
if (needsAuth.includes('最近错误')) throw new Error('needs-auth 不应显示错误')
if (needsAuth.includes('取消授权')) throw new Error('needs-auth 不应显示取消按钮')

const inFlight = render({
  connected: false,
  state: 'needs-auth',
  label: '等待浏览器授权',
  attempting: true,
  notice: { message: '请在浏览器完成旅映登录', url: 'https://example.com/authorize' },
  spaces: [],
  tools: [],
})
if (!inFlight.includes('取消授权')) throw new Error('进行中状态缺少「取消授权」按钮')
if (!inFlight.includes('example.com')) throw new Error('进行中状态缺少授权链接')

const connected = render({
  connected: true,
  state: 'ready',
  label: '已连接',
  attempting: false,
  spaces: [{ id: 's1', name: '个人空间', kind: 'personal' }],
  tools: ['tveyo_spaces'],
})
if (!connected.includes('断开连接')) throw new Error('已连接状态缺少「断开连接」按钮')
if (!connected.includes('个人空间')) throw new Error('已连接状态缺少空间名')

console.log('client bundle ok: slots=' + slots.length + ', states=needs-auth/attempting/connected')
