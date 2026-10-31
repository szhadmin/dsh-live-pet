// client.js 冒烟渲染：假 React + 注入「加载完成后」的状态，跑一遍设置页
const fs = require('node:fs')

const file = 'D:/project/live/dsh-live-pet-src/client.js'
const code = fs.readFileSync(file, 'utf8')

function createElement(type, props, ...children) {
  return { type, props: props || {}, children: children.flat(4) }
}

// 按 useState 的声明顺序喂数据（顺序取自 client.js 里的 state 声明）
const plan = [
  { skinDir: '', petName: '大肥鲸', sceneEnabled: true, sceneMinimized: false, posesCustom: [],
    multiAgent: { enabled: true, mode: 'argue', nameB: '小海豚', showPetB: true } },
  { douyin: { state: 'connected' }, songs: {}, gift_actions: { actions: {} } },
  true,
  {},
  { douyin: {}, songs: {}, gift_actions: { actions: {} } },
  [],
  '{}',
  false,
  { kind: '', text: '' },
  { running: true, base: 'http://127.0.0.1:8791', baseDir: 'D:/live-data', pid: 1 },
  false,
  { missing: [], python: 'python' },
  [],
  false,
  [{ id: 'hop', label: '蹦一下' }],
  '[]',
  [{ name: '小海豚', dir: 'C:/pkg/skins/x', active: false, count: 3,
    emotions: { happy: { kind: 'gif' }, coding: { kind: 'gif' }, crying: { kind: 'gif' } } }],
  false,
  { total: 1234, turns: 5, turnsA: 3, turnsB: 2, input: 100, output: 20, cacheRead: 1114,
    avgPerTurn: 246, last: { slot: 'b', input: 10, output: 2 } },
  'C:/Users/x/.dsh/profiles/desktop/node_modules/dsh-live-pet/config.json',
]

let cursor = 0
const React = {
  createElement,
  useState(initial) {
    const injected = plan[cursor]
    cursor += 1
    if (cursor <= plan.length) return [injected, () => {}]
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useMemo(fn) { return fn() },
  useRef(v) { return { current: v } },
}

global.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
global.window = { prompt: () => 'x', confirm: () => true, setTimeout }

let definition = null
global.window.__ModuleLoader__ = { load(def) { definition = def } }
new Function('window', 'fetch', code)(global.window, global.fetch)
const moduleExports = definition.factory((name) => {
  if (name === 'react') return React
  throw new Error('unknown module ' + name)
})

let Component = null
moduleExports.apply({
  slots: {
    inject(_name, factory) { if (typeof factory === 'function') factory() },
    register(spec, comp) { if (spec.id === 'live-pet') Component = comp; return spec },
  },
})
if (!Component) throw new Error('no component')

const tree = Component({})
const texts = []
function walk(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return
  if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
  if (Array.isArray(node)) { node.forEach(walk); return }
  if (typeof node.type === 'function') { walk(node.type(Object.assign({}, node.props, { children: node.children }))); return }
  const kids = Array.isArray(node.children) ? node.children : [node.children]
  kids.forEach(walk)
}
walk(tree)

const joined = texts.join('\n')
console.log('text chunks: ' + texts.length)
const needles = [
  '形象（换成自己的动图）',
  '当前形象',
  'Token 用量',
  '配置存在哪',
  'B 也出镜',
  '建一个形象文件夹',
  '清零重新统计',
  '小海豚',
  '1234 token',
]
for (const needle of needles) console.log((joined.includes(needle) ? 'OK   ' : 'MISS ') + needle)
console.log('first 8:')
console.log(texts.slice(0, 8).map((t) => '  - ' + t.slice(0, 70)).join('\n'))
