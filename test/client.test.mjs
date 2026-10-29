/**
 * 客户端 bundle 的离线冒烟测试。
 *
 * 不启动浏览器，只用最小桩验证：
 *   1. factory 能执行且不抛错；
 *   2. apply() 注册了两个插件页 slot；
 *   3. 卡片组件能渲染出标题与按钮。
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
// eslint-disable-next-line no-new-func
new Function('window', source)(fakeWindow)

if (loaded === undefined) throw new Error('client bundle did not call __ModuleLoader__.load')
if (loaded.id !== 'dsh-tveyo-mcp') throw new Error('unexpected module id: ' + loaded.id)

/* 最小 React 桩：createElement 只记录调用。 */
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
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

/* 渲染一次，确认组件不是空壳。 */
const tree = slots[0].component({})
const text = JSON.stringify(tree)
if (!text.includes('旅映 MCP')) throw new Error('card does not render its title')

console.log('client bundle ok: slots=' + slots.length + ', title=旅映 MCP')
