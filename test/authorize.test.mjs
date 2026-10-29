/**
 * 卡片点击授权的行为测试。
 *
 * 验证：
 *   1. 点击时同步开窗（浏览器手势要求）；
 *   2. 拿到授权地址后把弹窗导航过去，而不是停留在当前页；
 *   3. Host 侧不需要重复开浏览器。
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
  open: (...args) => {
    fakeWindow.__opened.push(args)
    return fakeWindow.__popup
  },
  __opened: [],
  __popup: null,
}
globalThis.window = fakeWindow
new Function('window', source)(fakeWindow)

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
module.apply(ctx)

/* 模拟 fetch：connect 返回 202，state 第一次无 notice、第二次给授权地址。 */
const calls = []
let stateReads = 0
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), method: (init && init.method) || 'GET' })
  if (String(url).endsWith('/connect')) return { ok: true, status: 202, json: async () => ({ started: true }) }
  if (String(url).endsWith('/state')) {
    stateReads += 1
    const body =
      stateReads === 1
        ? { connected: false, state: 'needs-auth', attempting: false }
        : {
            connected: false,
            state: 'needs-auth',
            attempting: true,
            notice: { message: '请登录', url: 'https://app.tveyo.com/authorize?x=1' },
          }
    return { ok: true, status: 200, json: async () => body }
  }
  return { ok: true, status: 200, json: async () => ({}) }
}

/* 弹窗桩：记录被导航到的地址。 */
const popup = {
  closed: false,
  location: { replace: (url) => { popup.navigatedTo = url } },
  close: () => { popup.closed = true },
  opener: null,
}
fakeWindow.__popup = popup

reset([{ connected: false, state: 'needs-auth', attempting: false, spaces: [], tools: [] }, false, null])
const tree = slots[0].component({})

/* 找到「连接旅映」按钮并触发 onClick。 */
function findButton(node, label) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findButton(child, label)
      if (hit) return hit
    }
    return null
  }
  const children = node.children || []
  const texts = children.filter((child) => typeof child === 'string').join('')
  if (node.type === 'button' && texts.includes(label)) return node
  for (const child of children) {
    const hit = findButton(child, label)
    if (hit) return hit
  }
  return null
}

const button = findButton(tree, '连接旅映')
if (button === null) throw new Error('未找到「连接旅映」按钮')

const pending = button.props.onClick()
if (fakeWindow.__opened.length !== 1) throw new Error('点击时没有同步开窗')
if (fakeWindow.__opened[0][0] !== 'about:blank') throw new Error('应先用 about:blank 占位')

await pending
if (popup.navigatedTo !== 'https://app.tveyo.com/authorize?x=1') {
  throw new Error('弹窗没有被导航到授权地址：' + String(popup.navigatedTo))
}
if (!calls.some((call) => call.url.includes('surface=card'))) {
  throw new Error('connect 请求没有带 surface=card 标记')
}

console.log('card authorize ok: popup navigated to authorization url')
