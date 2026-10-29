import { selectTools, allTools } from '../lib/catalog.js'

let pass = 0
let fail = 0
const check = (name, fn) => {
  try { fn(); pass++; console.log('  ok  ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' :: ' + e.message) }
}

console.log('== 1. 工具名唯一 ==')
check('no duplicates', () => {
  const names = allTools().map((t) => t.name)
  if (new Set(names).size !== names.length) throw new Error('duplicate names')
})

console.log('\n== 2. 每个工具都有描述与参数对象 ==')
for (const tool of allTools()) {
  check(tool.name, () => {
    if (!tool.description || tool.description.length < 10) throw new Error('description too short')
    if (typeof tool.parameters !== 'object' || tool.parameters === null) throw new Error('bad parameters')
    if (typeof tool.route !== 'function') throw new Error('bad route')
    if (!Array.isArray(tool.requires)) throw new Error('bad requires')
  })
}

console.log('\n== 3. 只读档位 ==')
const readOnly = selectTools({ grantedScopes: ['videos:read', 'research:read', 'assets:download'], enableCreationRead: false, enableCreationWrite: false })
check('只出现 4 个只读工具', () => {
  if (readOnly.length !== 4) throw new Error('got ' + readOnly.length + ': ' + readOnly.map(t => t.name))
})

console.log('\n== 4. 缺 scope 时不出现 ==')
const noResearch = selectTools({ grantedScopes: ['videos:read'], enableCreationRead: false, enableCreationWrite: false })
check('没有 research:read 就没有 tveyo_analysis', () => {
  if (noResearch.some((t) => t.name === 'tveyo_analysis')) throw new Error('analysis leaked')
})

console.log('\n== 5. 创作写入三处开关 ==')
const writeOn = selectTools({ grantedScopes: ['videos:read', 'research:read', 'assets:download', 'creation:read', 'creation:write'], enableCreationRead: true, enableCreationWrite: true })
check('全开时 13 个', () => {
  if (writeOn.length !== 13) throw new Error('got ' + writeOn.length + ': ' + writeOn.map(t => t.name).join(','))
})
const writeScopeOnly = selectTools({ grantedScopes: ['videos:read', 'creation:read', 'creation:write'], enableCreationRead: true, enableCreationWrite: false })
check('配置关时写入工具不出现', () => {
  if (writeScopeOnly.some((t) => t.requires.includes('creation:write'))) throw new Error('write leaked')
})
const configOnly = selectTools({ grantedScopes: ['videos:read'], enableCreationRead: true, enableCreationWrite: true })
check('旅映没给 scope 时写入工具不出现', () => {
  if (configOnly.some((t) => t.requires.includes('creation:write'))) throw new Error('write leaked')
})

console.log('\n== 6. 路由翻译 ==')
const materials = allTools().find((t) => t.name === 'tveyo_materials')
check('search 路由', () => {
  const r = materials.route({ action: 'search', spaceId: 's1', q: '咖啡' })
  if (r.tool !== 'search_materials' || r.args.spaceId !== 's1' || r.args.q !== '咖啡') throw new Error(JSON.stringify(r))
})
check('get 路由', () => {
  const r = materials.route({ action: 'get', spaceId: 's1', videoId: 'v1' })
  if (r.tool !== 'get_material' || r.args.videoId !== 'v1') throw new Error(JSON.stringify(r))
})
const tasks = allTools().find((t) => t.name === 'tveyo_tasks')
check('list 不带 spaceId 时不下发该字段', () => {
  const r = tasks.route({ action: 'list', status: 'pending' })
  if ('spaceId' in r.args) throw new Error('spaceId leaked: ' + JSON.stringify(r.args))
  if (r.args.status !== 'pending') throw new Error('status lost')
})
const createTask = allTools().find((t) => t.name === 'tveyo_create_task')
check('create_task 组装 config', () => {
  const r = createTask.route({ spaceId: 's', topicId: 't', expectedTopicVersion: 3, requestKey: 'k', format: 'video', durationSeconds: 30 })
  if (r.args.config.format !== 'video' || r.args.config.durationSeconds !== 30) throw new Error(JSON.stringify(r.args))
  if (r.args.config.skillId !== null) throw new Error('skillId 应为 null')
})

console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败')
if (fail > 0) process.exit(1)
