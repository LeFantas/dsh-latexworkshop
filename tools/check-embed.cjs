/**
 * 嵌入右侧栏的集成测试：mock ctx / slots / sidebarRightTabs / react，
 * 跑一遍 client.js 的 factory + apply，验证注册链路与挂载逻辑。
 *
 * 这类错误（API 用法、参数形状）只有在应用里才会暴露，本地先抓一遍。
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const file = path.join(__dirname, '..', 'lib', 'client.js')
const src = fs.readFileSync(file, 'utf8')

const byId = new Map()
function makeEl(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', type: '', title: '', textContent: '', hidden: false, disabled: false,
    children: [], parentNode: null, dataset: {}, style: {}, attrs: {}, __events: {},
    style: { setProperty(k, v) { this[k] = v }, removeProperty(k) { delete this[k] } },
    classList: {
      _set: null,
      add(c) { const s = new Set(String(this._set || '').split(/\s+/).filter(Boolean)); s.add(c); this._set = [...s].join(' ') },
      remove(c) { const s = new Set(String(this._set || '').split(/\s+/).filter(Boolean)); s.delete(c); this._set = [...s].join(' ') },
      toggle(c, on) { if (on === false) this.remove(c); else this.add(c) },
      contains(c) { return String(this._set || '').split(/\s+/).includes(c) },
    },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null },
    removeAttribute(k) { delete this.attrs[k] },
    addEventListener(n, fn) { (this.__events[n] = this.__events[n] || []).push(fn) },
    removeEventListener(n, fn) { const l = this.__events[n]; if (l) this.__events[n] = l.filter((x) => x !== fn) },
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child)
      this.children.push(child); child.parentNode = this
      if (child.id) byId.set(child.id, child)
      return child
    },
    removeChild(child) {
      this.children = this.children.filter((x) => x !== child)
      child.parentNode = null
      // 同步清掉 byId，否则 getElementById 会返回已下树的陈旧节点
      if (child.id && byId.get(child.id) === child) byId.delete(child.id)
      return child
    },
    insertBefore(child) { return this.appendChild(child) },
    querySelector(sel) {
      // 支持 [attr] 与 .class 选择器（递归），模拟真实 querySelector 的子集
      const found = this.querySelectorAll(sel)
      return found.length ? found[0] : null
    },
    querySelectorAll(sel) {
      const mAttr = /^\[([A-Za-z][\w-]*)\]$/.exec(String(sel))
      const mCls = /^\.([A-Za-z][\w-]*)$/.exec(String(sel))
      const out = []
      const match = (n) => {
        if (mAttr) return n.attrs && n.attrs[mAttr[1]] !== undefined
        if (mCls) return String(n.className || '').split(/\s+/).includes(mCls[1])
        return false
      }
      const walk = (n) => {
        for (const c of n.children) {
          if (match(c)) out.push(c)
          walk(c)
        }
      }
      walk(this)
      return out
    },
    closest() { return null },
    contains() { return false },
    getBoundingClientRect() { return { width: 1200, height: 800, left: 0, top: 0, right: 1200, bottom: 800 } },
    getContext() { return null },
    focus() {},
    click() { (this.__events.click || []).forEach((fn) => fn({ preventDefault() {}, stopPropagation() {} })) },
  }
  return node
}

const document = {
  head: makeEl('head'), body: makeEl('body'), documentElement: makeEl('html'),
  createElement: makeEl,
  createTextNode: (t) => ({ textContent: t }),
  getElementById: (id) => byId.get(id) || null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  fonts: { ready: Promise.resolve() },
}

const window = {
  __ModuleLoader__: { load(def) { window.__def = def } },
  addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  innerWidth: 1600, innerHeight: 900, devicePixelRatio: 1,
  location: { href: 'dsh-app://app/' },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  fetch: () => Promise.reject(new Error('stub: no network')),
  console,
}

const sandbox = {
  window, document, location: window.location, localStorage: window.localStorage,
  fetch: window.fetch, console, setTimeout, clearTimeout, setInterval, clearInterval,
  MutationObserver: class { observe() {} disconnect() {} },
  IntersectionObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i && i.detail } },
  Event: class { constructor(t) { this.type = t } },
  navigator: { userAgent: 'node' },
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
}
const context = vm.createContext(sandbox)
context.globalThis = context

vm.runInContext(src, context, { filename: 'client.js' })
const def = window.__def
if (!def) { console.error('未捕获 factory'); process.exit(1) }

// ---- mock 外部依赖 ----
const calls = { tabTypes: [], bodySlots: [], openTabs: [], injected: [], effects: [], refs: [], commands: [] }

// 命令面板（`__edrvCommands__` 由 vscode-mode 提供）。入口全删掉后这条路径要能跑通，
// 所以桩必须存在——否则 registerCommand 会一直重试到 30 秒后放弃，测试也看不到注册。
window.__edrvCommands__ = { register(spec) { calls.commands.push(spec) } }

const reactMock = {
  createElement: (type, props, ...kids) => ({ __el: true, type, props: props || {}, kids }),
  useRef: (v) => { const r = { current: v }; calls.refs.push(r); return r },
  useEffect: (fn) => { calls.effects.push(fn) },
  Fragment: 'fragment',
}
const tabsMock = { register(spec) { calls.tabTypes.push(spec); return () => {} } }
const rightMock = { openTab(kind, opts) { calls.openTabs.push({ kind, opts }) } }
const slotsMock = {
  inject(name, fn) { calls.injected.push(name); const d = fn(); return typeof d === 'function' ? d : () => {} },
  register(spec, comp) { calls.bodySlots.push({ spec, comp }); return () => {} },
}
const ctxMock = {
  get(name) {
    if (name === 'sidebarRightTabs') return tabsMock
    if (name === 'sidebarRight') return rightMock
    return undefined
  },
  slots: slotsMock,
}
const req = (name) => {
  if (name === 'react') return reactMock
  return {}
}

// ---- Monaco 桩 + RPC 路由（必须在 apply 之前装好：effect 里就会建编辑器）----
// 走真实的 UI 链路：文件按钮 → 文件清单 → 点行开文件 → 标签栏。
function ok(data) {
  return Promise.resolve({ ok: true, status: 200, headers: { get: () => '' }, json: () => Promise.resolve({ ok: true, data }) })
}
const FILE_TEXTS = {
  // main.tex 需要够长：反向搜索的用例要跳第 42 行，行数不够会被夹到末行
  'main.tex': 'main-body\n' + Array.from({ length: 59 }, (_, i) => 'line ' + (i + 2)).join('\n'),
  'chap1.tex': 'chap1-body',
  'notes.md': 'note-body',
  // 4 行（末尾不留换行，否则 Monaco 会多算一个空行）
  'appendix.tex': 'a\nb\nc\nd',
}
context.fetch = window.fetch = (url, opts) => {
  const u = String(url)
  const body = opts && opts.body ? JSON.parse(opts.body) : {}
  if (u.indexOf('/latex/log') >= 0) return ok({})
  if (u.indexOf('/latex/rpc') < 0) return ok({})
  const args = body.args || {}
  if (body.method === 'fsList') {
    return ok({ root: '/w', files: [
      { name: 'main.tex', path: 'main.tex' },
      { name: 'chap1.tex', path: 'chap1.tex' },
      { name: 'notes.md', path: 'notes.md' },
      { name: 'appendix.tex', path: 'appendix.tex' },
    ] })
  }
  if (body.method === 'fsRead') {
    return ok({ abs: '/w/' + args.relPath, name: String(args.relPath).split('/').pop(), mtimeMs: 1, text: FILE_TEXTS[args.relPath] || '' })
  }
  if (body.method === 'fsWrite') {
    writes.push({ relPath: args.relPath, text: args.text, expectedMtimeMs: args.expectedMtimeMs })
    events.push({ type: 'write', relPath: args.relPath })
    if (writeFails) return Promise.resolve({ ok: true, status: 200, headers: { get: () => '' }, json: () => Promise.resolve({ ok: false, error: '磁盘忙' }) })
    // 同时更新内存里的假内容，让后续 fsRead 看到新内容（模拟真实落盘）
    if (typeof args.relPath === 'string') FILE_TEXTS[args.relPath] = args.text
    return ok({ mtimeMs: 2 })
  }
  // 编译结果由测试逐个用例改写，默认成功
  if (body.method === 'compile') {
    compileCalls.push(args.relPath)
    events.push({ type: 'compile', relPath: args.relPath })
    return ok(compileReply)
  }
  // readPdf 故意返回空数据：让 loadPdf 走到 pdf.js 之前就停下，
  // 本节测的是「失败时怎么标记」，不需要真渲染一份 PDF
  if (body.method === 'readPdf') return ok({ base64: '', bytes: 0, mtimeMs: 0 })
  if (body.method === 'cleanAux') {
    cleanCalls.push({ relPath: args.relPath, scope: args.scope })
    return ok(cleanReply)
  }
  if (body.method === 'synctexView') {
    viewCalls.push({ relPath: args.relPath, pdfRel: args.pdfRel, line: args.line, column: args.column })
    if (viewFail) {
      // 真实宿主是 200 + {ok:false,error}，不是 HTTP 错误码
      return Promise.resolve({
        ok: true, status: 200, headers: { get: () => '' },
        json: () => Promise.resolve({ ok: false, error: 'synctex 未找到对应位置' }),
      })
    }
    return ok(viewReply)
  }
  return ok({})
}
// 每个用例改这个变量来模拟编译结果
let compileReply = { ok: true, pages: 3, durationMs: 100 }
// fsWrite 的调用记录与失败开关（测「编译前保存」用）
const writes = []
let writeFails = false
// 记录 compile 收到的 relPath 顺序，验证「先保存再编译」
const compileCalls = []
// 写与编译混在一个序列里，才能断言「先存后编」这个顺序
const events = []
// cleanAux 的调用记录与预设返回
const cleanCalls = []
let cleanReply = { removed: ['a.aux', 'a.log'], failed: [], bytes: 2048, listed: 2 }
// synctexView（正向搜索）的调用记录与预设返回
const viewCalls = []
let viewReply = { page: 3, x: 72, y: 120, pdfRel: 'main.pdf' }
let viewFail = false

let modelSeq = 0
function makeModel(text) {
  const cbs = []
  return {
    __text: String(text), __lang: 'plaintext', __cbs: cbs,
    uri: { path: '/model/' + (++modelSeq) },
    getValue() { return this.__text },
    getLanguageId() { return this.__lang },
    getLineCount() { return this.__text.split('\n').length },
    getLineMaxColumn() { return 100 },
    getFullModelRange() { return {} },
    pushEditOperations(_u, ops) { if (ops && ops[0]) this.__text = ops[0].text },
    onDidChangeContent(fn) { cbs.push(fn); return { dispose() {} } },
    dispose() { this.__disposed = true },
    // 测试用：模拟用户输入，触发 onDidChangeContent
    __fireChange() { cbs.forEach((fn) => fn({})) },
  }
}
function makeEditor(model) {
  return {
    __model: model, __vs: 0, __pos: null, __revealed: null,
    getModel() { return this.__model },
    setModel(m) { this.__model = m },
    getValue() { return this.__model ? this.__model.getValue() : '' },
    saveViewState() { this.__vs += 1; return { n: this.__vs } },
    restoreViewState() {},
    setPosition(pos) { this.__pos = pos },
    getPosition() { return this.__pos || { lineNumber: 1, column: 1 } },
    revealLine(n) { this.__revealed = n },
    revealLineInCenter(n) { this.__revealed = n },
    focus() {}, layout() {}, updateOptions() {},
    addCommand() {}, onMouseMove() {}, onMouseLeave() {},
    deltaDecorations(_old, next) { return next },
  }
}
const fakeEditors = []
const fakeModels = []
const fakeMonaco = {
  __models: fakeModels, __editors: fakeEditors,
  editor: {
    create(_host, opts) {
      const ed = makeEditor(opts && typeof opts.value === 'string' ? makeModel(opts.value) : null)
      fakeEditors.push(ed)
      return ed
    },
    createModel(text, lang) {
      const m = makeModel(text)
      m.__lang = lang || 'plaintext'
      fakeModels.push(m)
      return m
    },
    setModelLanguage(m, lang) { if (m) m.__lang = lang },
    getModels() { return fakeModels.concat(fakeEditors.map((e) => e.__model).filter(Boolean)) },
    getEditors() { return fakeEditors },
    onDidCreateEditor() { return { dispose() {} } },
    onDidCreateModel() { return { dispose() {} } },
    defineTheme() {}, setTheme() {},
  },
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
  KeyCode: { KeyS: 83, KeyW: 87 },
}
// 故意不给 languages —— whenMonaco 的探测要求 languages 齐全，缺了它
// 语言链路不会跑，本套测试专注注册/嵌入/标签逻辑。
window.monaco = fakeMonaco

const exportsObj = def.factory(req)
console.log('导出：' + Object.keys(exportsObj || {}).join(', '))
console.log('inject = ' + JSON.stringify(exportsObj.inject))

exportsObj.apply(ctxMock)

// ---- 断言 ----
function check(label, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (extra === undefined ? '' : '  ' + extra))
  if (!ok) process.exitCode = 1
}

console.log('\n[1] 页签类型注册')
const t0 = calls.tabTypes[0]
check('调用了 tabs.register', !!t0)
if (t0) {
  check('id 非空', typeof t0.id === 'string' && t0.id.length > 0, t0.id)
  check('kind 非空', typeof t0.kind === 'string' && t0.kind.length > 0, t0.kind)
  check('priority=extension', t0.priority === 'extension', t0.priority)
  check('title 是函数且返回字符串', typeof t0.title === 'function' && typeof t0.title() === 'string', t0.title && t0.title())

  // guide 结构：渲染方会 definition.title(...) / entry.title() 直接调用。
  // 传字符串会抛 "not a function"，而这一个错误会让整个引导页渲染失败 ——
  // 表现是右侧栏一片空白，连别人的卡片也一起消失（v2.2.1 踩过）。
  check('guide 是数组', Array.isArray(t0.guide), typeof t0.guide)
  for (const [gi, g] of (t0.guide || []).entries()) {
    const tag = 'guide[' + gi + ']'
    check(tag + '.id 非空（provider 内唯一，作 React key）', typeof g.id === 'string' && g.id.length > 0, g.id)
    check(tag + '.order 是数字', typeof g.order === 'number', g.order)
    check(tag + '.title 是函数', typeof g.title === 'function', typeof g.title)
    check(tag + '.description 是函数', typeof g.description === 'function', typeof g.description)
    check(tag + ' 调用不抛错且返回字符串',
      typeof g.title === 'function' && typeof g.title() === 'string',
      typeof g.title === 'function' ? JSON.stringify(g.title()) : 'n/a')
  }
}

console.log('\n[2] 正文 slot 注册')
check('inject 的 slot 名正确', calls.injected[0] === 'sidebar.right.pane.tab', calls.injected[0])
const b0 = calls.bodySlots[0]
check('调用了 slots.register', !!b0)
if (b0) {
  check('key === 类型 id', b0.spec.key === t0.id, b0.spec.key + ' vs ' + t0.id)
  check('name 正确', b0.spec.name === 'sidebar.right.pane.tab', b0.spec.name)
  check('正文是组件函数', typeof b0.comp === 'function')
}

console.log('\n[3] 模拟 DSH 挂载正文')
const el = b0.comp({ sessionId: 'sid', useTabInfo: () => ({ tab: {} }) })
check('返回 React 元素', !!el && el.__el === true)
check('ref 已传入', !!el.props.ref)
const host = makeEl('div')
el.props.ref.current = host
calls.effects.forEach((fn) => fn())
const wb = byId.get('dmz-latex-workbench')
check('工作台已挂进 host', !!wb && wb.parentNode === host)
check('不再挂到 body', !document.body.children.includes(wb))
if (wb) {
  check('未标 floating', String(wb.className).indexOf('dmz-wb-float') < 0, wb.className)
  const closeBtn = wb.querySelector('[data-dmz-wb-close]')
  check('关闭按钮被隐藏', !!closeBtn && closeBtn.style.display === 'none',
    closeBtn ? String(closeBtn.style.display) : 'none-found')
  const labels = wb.children[0] && wb.children[0].children
    ? wb.children[0].children.map((c) => c.textContent).filter(Boolean)
    : []
  check('工具栏有 文件/保存/编译', ['文件', '保存', '编译'].every((x) => labels.includes(x)), JSON.stringify(labels))
}

console.log('\n[4] 只保留右侧栏页签入口')
// v2.4.1 起，左侧栏底部按钮（sidebar.footer.action）和右下角浮动按钮都去掉了。
// 这两条断言是「反向」的：确保没人把它们加回来。
const side = calls.bodySlots.find((x) => x.spec.name === 'sidebar.footer.action')
check('不再注册 sidebar.footer.action', !side, side ? side.spec.id : '未注册')
check('不再创建右下角浮动按钮', !byId.get('dmz-latex-workbench-launcher'))
check('CSS 里不再有 launcher 样式', !/dmz-latex-workbench-launcher/.test(
  (byId.get('dmz-latex-workbench-style') || {}).textContent || ''))
check('CSS 里不再有侧栏入口样式', !/\.dmz-side-entry/.test(
  (byId.get('dmz-latex-workbench-style') || {}).textContent || ''))

console.log('\n[5] 命令面板兜底')
// 入口都删了，命令面板得留一条「打开工作台」，否则只剩快捷键这一条路
const cmds = calls.commands || []
check('注册了「打开工作台」命令', cmds.some((c) => c.id === 'dsh-dmzlatexworkshop.open'),
  JSON.stringify(cmds.map((c) => c.id)))
const openCmd = cmds.find((c) => c.id === 'dsh-dmzlatexworkshop.open')
if (openCmd) {
  check('label 可读', /打开工作台/.test(openCmd.label), openCmd.label)
  check('run 是函数', typeof openCmd.run === 'function')
  const before = calls.openTabs.length
  openCmd.run()
  check('执行后切到右侧栏页签', calls.openTabs.length === before + 1, String(calls.openTabs.length))
}

console.log('\n[6] CSS')
const styleEl = byId.get('dmz-latex-workbench-style')
check('样式已注入', !!styleEl)
if (styleEl) {
  const css = styleEl.textContent
  const open = (css.match(/\{/g) || []).length
  const close = (css.match(/\}/g) || []).length
  check('花括号配对', open === close, open + '/' + close)
  check('默认 absolute 定位', /#dmz-latex-workbench\{position:absolute/.test(css))
  check('浮层类存在', /\.dmz-wb-float\{position:fixed/.test(css))
  check('文件列表样式存在', /\.dmz-wb-files\{/.test(css))
}

console.log('\n[7] 预览折叠')
function findIn(root, pred) {
  for (const c of root.children) {
    if (pred(c)) return c
    const hit = findIn(c, pred)
    if (hit) return hit
  }
  return null
}
const previewBtn = wb.querySelector('[data-dmz-wb-preview]')
check('顶栏有「收起预览」按钮', !!previewBtn)
const pdfPane = wb ? findIn(wb, (n) => String(n.className).indexOf('dmz-wb-pdf') >= 0) : null
check('PDF 面板存在', !!pdfPane)
if (previewBtn && pdfPane) {
  check('初始文案 = 收起预览', previewBtn.textContent === '收起预览', previewBtn.textContent)
  check('初始预览可见', pdfPane.style.display === '', pdfPane.style.display)
  previewBtn.click()
  check('点击后文案 = 展开预览', previewBtn.textContent === '展开预览', previewBtn.textContent)
  check('点击后 PDF 面板隐藏', pdfPane.style.display === 'none', pdfPane.style.display)
  previewBtn.click()
  check('再点恢复展开', previewBtn.textContent === '收起预览' && pdfPane.style.display === '',
    previewBtn.textContent + ' / ' + pdfPane.style.display)
}

console.log('\n[8] 多标签')
// Monaco 桩与 RPC 路由已在顶部装好，这里走真实 UI 链路：
// 文件按钮 → 文件清单 → 点行开文件 → 标签栏。
function findButtons(label) {
  return (wb.children[0] ? wb.children[0].children : []).filter((c) => c.textContent === label)
}
function tabsNow() {
  return wb.querySelectorAll('[data-dmz-tab]')
}
const tick = () => new Promise((r) => setTimeout(r, 20))

;(async () => {
  // 打开 main.tex
  findButtons('文件')[0].click()
  await tick()
  check('编辑器已通过 Monaco 桩创建', fakeEditors.length >= 1, String(fakeEditors.length))
  let rows = wb.querySelectorAll('.dmz-wb-file')
  check('文件清单列出 4 行', rows.length === 4, String(rows.length))
  rows[0].click()
  await tick()

  let tabs = tabsNow()
  check('打开 1 个文件 → 1 个标签', tabs.length === 1, String(tabs.length))
  check('标签名 = main.tex', !!tabs[0] && tabs[0].querySelector('.dmz-wb-tab-name').textContent === 'main.tex',
    tabs[0] && tabs[0].querySelector('.dmz-wb-tab-name').textContent)
  check('顶栏标题 = main.tex', wb.children[0].children[0].textContent === 'main.tex', wb.children[0].children[0].textContent)
  check('标签栏可见', wb.querySelectorAll('[data-dmz-wb-tabs]')[0].style.display !== 'none')

  // 打开 chap1.tex
  findButtons('文件')[0].click()
  await tick()
  rows = wb.querySelectorAll('.dmz-wb-file')
  check('重新列出文件清单', rows.length === 4, String(rows.length))
  rows[1].click()
  await tick()

  tabs = tabsNow()
  check('两个标签并存', tabs.length === 2, String(tabs.length))
  check('新标签激活', String(tabs[1].className).indexOf('dmz-wb-tab-active') >= 0, tabs[1].className)
  check('旧标签未激活', String(tabs[0].className).indexOf('dmz-wb-tab-active') < 0, tabs[0].className)
  check('顶栏标题 = chap1.tex', wb.children[0].children[0].textContent === 'chap1.tex', wb.children[0].children[0].textContent)
  check('两个独立 model', fakeModels.length >= 2 && fakeModels[0] !== fakeModels[1],
    fakeModels.map((m) => m.__text).join(','))

  // 点第一个标签切回去
  tabs[0].click()
  await tick()
  tabs = tabsNow()
  check('点击后激活移到第 1 个', String(tabs[0].className).indexOf('dmz-wb-tab-active') >= 0, tabs[0].className)
  check('标题回到 main.tex', wb.children[0].children[0].textContent === 'main.tex', wb.children[0].children[0].textContent)
  check('切回时保存了视图状态', fakeEditors[0].__vs >= 1, String(fakeEditors[0].__vs))

  // 输入 → 脏点
  fakeModels[0].__fireChange()
  await tick()
  tabs = tabsNow()
  check('未保存时标签出现圆点', tabs[0].querySelectorAll('.dmz-wb-tab-dot').length === 1,
    String(tabs[0].querySelectorAll('.dmz-wb-tab-dot').length))
  check('标题带 • 标记', wb.children[0].children[0].textContent.indexOf('•') >= 0, wb.children[0].children[0].textContent)

  // 关干净的标签（chap1）
  tabs[1].querySelector('.dmz-wb-tab-close').click()
  await tick()
  tabs = tabsNow()
  check('关闭后剩 1 个标签', tabs.length === 1, String(tabs.length))
  check('main.tex 仍激活', String(tabs[0].className).indexOf('dmz-wb-tab-active') >= 0, tabs[0].className)

  // 关脏标签：先拒绝，再同意
  window.confirm = () => false
  tabs[0].querySelector('.dmz-wb-tab-close').click()
  await tick()
  check('取消后标签还在', tabsNow().length === 1, String(tabsNow().length))
  window.confirm = () => true
  tabsNow()[0].querySelector('.dmz-wb-tab-close').click()
  await tick()
  check('确定后标签清空', tabsNow().length === 0, String(tabsNow().length))
  check('标签栏隐藏', wb.querySelectorAll('[data-dmz-wb-tabs]')[0].style.display === 'none',
    wb.querySelectorAll('[data-dmz-wb-tabs]')[0].style.display)
  check('标题回到未打开文件', wb.children[0].children[0].textContent === '未打开文件', wb.children[0].children[0].textContent)

  // 重新打开两个文件，验证已打开的文件走「切换」而不是重复开标签
  findButtons('文件')[0].click()
  await tick()
  wb.querySelectorAll('.dmz-wb-file')[2].click() // notes.md
  await tick()
  findButtons('文件')[0].click()
  await tick()
  wb.querySelectorAll('.dmz-wb-file')[0].click() // main.tex
  await tick()
  check('两个文件 → 2 个标签', tabsNow().length === 2, String(tabsNow().length))
  findButtons('文件')[0].click()
  await tick()
  wb.querySelectorAll('.dmz-wb-file')[2].click() // notes.md 再点一次
  await tick()
  check('重复打开不新增标签', tabsNow().length === 2, String(tabsNow().length))
  check('且切回了 notes.md', wb.children[0].children[0].textContent === 'notes.md', wb.children[0].children[0].textContent)

  console.log('\n[9] 反向搜索跳转（jumpToSource）')
  // 这条链路原来只 dispatch `edrv:open-editor`（vscode-mode 的事件），
  // 工作台自带 Monaco 之后没人接 → Ctrl+点击 PDF 没反应。现在改在内部跳。
  const dbg = exportsObj.__debug ? exportsObj.__debug() : null
  check('暴露了调试出口', !!dbg)
  if (dbg) {
    const ed = fakeEditors[0]

    // 1) 跳到已打开但不是前台的标签
    const okJump = dbg.jumpToSource('main.tex', 42, 5)
    await tick()
    check('受理跳转', okJump === true, String(okJump))
    check('激活到 main.tex', dbg.active() && dbg.active().relPath === 'main.tex',
      dbg.active() && dbg.active().relPath)
    check('编辑器换到 main.tex 的 model',
      !!ed.__model && String(ed.__model.getValue()).indexOf('main-body') === 0,
      ed.__model && String(ed.__model.getValue()).split('\n')[0])
    check('光标落在 42:5', !!ed.__pos && ed.__pos.lineNumber === 42 && ed.__pos.column === 5,
      JSON.stringify(ed.__pos))
    check('滚到该行', ed.__revealed === 42, String(ed.__revealed))

    // 2) 大小写与分隔符不影响匹配（Windows 上 synctex 回的是磁盘真实大小写）
    ed.__pos = null
    dbg.jumpToSource('.\\MAIN.TEX', 7, 1)
    await tick()
    check('路径大小写不敏感', !!ed.__pos && ed.__pos.lineNumber === 7, JSON.stringify(ed.__pos))
    check('没有为此新开标签', tabsNow().length === 2, String(tabsNow().length))

    // 3) 跳到没打开过的文件：开成新标签再定位
    const before = tabsNow().length
    dbg.jumpToSource('appendix.tex', 3, 1)
    await tick()
    check('新文件被开成标签', tabsNow().length === before + 1, String(tabsNow().length))
    check('并成为前台', dbg.active() && dbg.active().relPath === 'appendix.tex',
      dbg.active() && dbg.active().relPath)
    check('定位到第 3 行', !!ed.__pos && ed.__pos.lineNumber === 3, JSON.stringify(ed.__pos))

    // 4) 行号超出文件长度时夹到末行（synctex 会给出源码里不存在的行）
    ed.__pos = null
    dbg.placeCursor(9999, 1)
    check('超界行号被夹到末行', !!ed.__pos && ed.__pos.lineNumber === 4,
      JSON.stringify(ed.__pos) + ' / 共 4 行')

    // 5) 路径规范化
    check('normRel 统一分隔符', dbg.normRel('.\\a\\b.tex') === 'a/b.tex', dbg.normRel('.\\a\\b.tex'))
    check('空路径不误匹配', dbg.findTabByPath('') === null)
  }

  console.log('\n[10] 编译失败时把预览标成陈旧')
  // 关键点：latexmk 失败不覆盖磁盘上的 PDF，预览里还是上次成功的那份。
  // 不标出来的话「看起来一切正常」，比白屏更误导。这里验证三条信息都到位：
  // 红条文案、页面变暗、错误可点。
  {
    // 回到 main.tex，并确保面板已建（正常流程里是编译成功时建的）
    dbg.jumpToSource('main.tex', 1, 1)
    await tick()
    dbg.buildPanel()
    await tick()
    const p = dbg.panel()
    check('面板已建立', !!p.el)
    const staleEl = () => findIn(p.el, (n) => String(n.className).indexOf('dsh-dmzlatexworkshop-stale') === 0)
    check('初始无陈旧横幅', !staleEl() || staleEl().style.display === 'none',
      staleEl() ? String(staleEl().style.display) : 'none')
    check('初始未标陈旧', !p.el.getAttribute('data-dlx-stale'))

    // 一个错误
    compileReply = { ok: false, errors: [
      { file: 'main.tex', line: 12, message: 'Undefined control sequence' },
    ] }
    await dbg.compileNow()
    await tick()
    check('失败后标记陈旧', p.el.getAttribute('data-dlx-stale') === '1', String(p.el.getAttribute('data-dlx-stale')))
    check('页面变暗（class 生效）', p.el.classList.contains('dlx-stale'))
    check('横幅显示', staleEl() && staleEl().style.display === 'flex',
      staleEl() ? String(staleEl().style.display) : 'none')
    const text = p.staleTextEl.textContent
    check('横幅含「编译失败」', /编译失败/.test(text), JSON.stringify(text))
    check('横幅含文件:行', /main\.tex:12/.test(text), JSON.stringify(text))
    check('横幅含错误信息', /Undefined control sequence/.test(text), JSON.stringify(text))
    check('横幅提到是旧版本', /旧版本|旧的 PDF/.test(text), JSON.stringify(text))
    const list = p.staleListEl
    check('单条错误默认不展开列表', list.style.display === 'none', String(list.style.display))
    check('列表里已备好错误行', list.children.length === 1, String(list.children.length))

    // 多条错误 → 默认展开
    compileReply = { ok: false, errors: [
      { file: 'main.tex', line: 12, message: 'Undefined control sequence' },
      { file: 'main.tex', line: 30, message: 'Missing $ inserted' },
      { file: 'main.tex', line: 44, message: 'Too many closing braces' },
    ] }
    await dbg.compileNow()
    await tick()
    check('多条错误时列表展开', p.staleListEl.style.display === 'flex', String(p.staleListEl.style.display))
    check('错误行数正确', p.staleListEl.children.length === 3, String(p.staleListEl.children.length))
    check('横幅标出总数', /共 3 个错误/.test(p.staleTextEl.textContent), JSON.stringify(p.staleTextEl.textContent))

    // 点错误行 → 跳到源码对应行
    const ed2 = fakeEditors[0]
    ed2.__pos = null
    p.staleListEl.children[1].click()
    await tick()
    check('点错误行跳到对应行', !!ed2.__pos && ed2.__pos.lineNumber === 30, JSON.stringify(ed2.__pos))

    // 再次编译成功 → 解除
    compileReply = { ok: true, pages: 3, durationMs: 100 }
    await dbg.compileNow()
    await tick()
    check('成功后解除陈旧', !p.el.getAttribute('data-dlx-stale'))
    check('成功后去掉变暗 class', !p.el.classList.contains('dlx-stale'))
    check('成功后横幅隐藏', p.staleEl.style.display === 'none', String(p.staleEl.style.display))
    check('成功后清空错误列表', p.staleListEl.children.length === 0, String(p.staleListEl.children.length))

    // 还没有面板时（首次编译即失败）→ 预览栏里铺错误卡片
    p.el = null
    compileReply = { ok: false, fatal: '找不到 latexmk' }
    await dbg.compileNow()
    await tick()
    const card = findIn(wb, (n) => n.attrs && n.attrs['data-dlx-failcard'] !== undefined)
    check('无面板时显示错误卡片', !!card)
    if (card) {
      const head = card.children[0]
      check('卡片标题含原因', /找不到 latexmk/.test(head.textContent), JSON.stringify(head.textContent))
      check('卡片说明还没生成 PDF', /还没有生成 PDF/.test(head.textContent), JSON.stringify(head.textContent))
    }
    // 成功一次就收走卡片
    dbg.jumpToSource('main.tex', 1, 1)
    await tick()
    compileReply = { ok: true, pages: 3, durationMs: 100 }
    await dbg.compileNow()
    await tick()
    check('成功后错误卡片被收走',
      !findIn(wb, (n) => n.attrs && n.attrs['data-dlx-failcard'] !== undefined))
  }

  console.log('\n[11] 编译前先保存（否则改的是内存、编的是磁盘）')
  // 这是「预览不跟随改动」的真正原因：编译器读磁盘，编辑器内容只在内存。
  // 不保存就编译 → 编旧文件 → 报成功，你的修改一个字都没进去。
  {
    // 关掉所有标签重来，避免前面用例的状态干扰
    window.confirm = () => true
    tabsNow().slice().forEach((t) => t.querySelector('.dmz-wb-tab-close').click())
    await tick()
    writes.length = 0
    compileCalls.length = 0
    events.length = 0

    findButtons('文件')[0].click()
    await tick()
    wb.querySelectorAll('.dmz-wb-file')[0].click() // main.tex
    await tick()
    const dbg2 = exportsObj.__debug()

    // 干净文件：不该产生任何写入
    compileReply = { ok: true, pages: 3, durationMs: 100 }
    await dbg2.compileNow()
    await tick()
    check('无改动时不写盘', writes.length === 0, JSON.stringify(writes.map((w) => w.relPath)))
    check('但仍然编译', compileCalls.length === 1, String(compileCalls.length))

    // 改一个字符 → 变脏 → 编译必须先保存，且顺序在编译之前
    writes.length = 0
    compileCalls.length = 0
    events.length = 0
    const mainTab = dbg2.tabs().find((t) => t.relPath === 'main.tex')
    mainTab.model.__text = 'edited-in-editor'
    mainTab.model.__fireChange()
    await tick()
    check('改动后标签变脏', mainTab.dirty === true)
    await dbg2.compileNow()
    await tick()
    check('编译前发生写盘', writes.length === 1, String(writes.length))
    check('写的是改过的内容', writes[0] && writes[0].text === 'edited-in-editor',
      writes[0] && JSON.stringify(writes[0].text))
    check('先写后编', events.length === 2 && events[0].type === 'write' && events[1].type === 'compile',
      JSON.stringify(events))
    check('保存后不再脏', mainTab.dirty === false)
    check('磁盘内容已更新', FILE_TEXTS['main.tex'] === 'edited-in-editor', FILE_TEXTS['main.tex'])

    // 多个脏标签：全部保存，串行
    findButtons('文件')[0].click()
    await tick()
    wb.querySelectorAll('.dmz-wb-file')[1].click() // chap1.tex
    await tick()
    writes.length = 0
    compileCalls.length = 0
    const chapTab = dbg2.tabs().find((t) => t.relPath === 'chap1.tex')
    mainTab.model.__fireChange()
    chapTab.model.__fireChange()
    await tick()
    await dbg2.compileNow()
    await tick()
    check('两个脏标签都写了', writes.length === 2, JSON.stringify(writes.map((w) => w.relPath)))
    check('写的都是 tex', writes.every((w) => /\.tex$/.test(w.relPath)),
      JSON.stringify(writes.map((w) => w.relPath)))

    // 保存失败 → 中止编译，不能拿旧结果冒充新结果
    writes.length = 0
    compileCalls.length = 0
    writeFails = true
    mainTab.model.__fireChange()
    await tick()
    await dbg2.compileNow()
    await tick()
    check('保存失败时不编译', compileCalls.length === 0, String(compileCalls.length))
    check('确实尝试过保存', writes.length > 0, String(writes.length))
    writeFails = false
    // 失败后 busy 要复位，否则「正在编译中」会永远卡住
    mainTab.model.__fireChange()
    await tick()
    await dbg2.compileNow()
    await tick()
    check('失败后仍能再次编译', compileCalls.length === 1, String(compileCalls.length))

    // 激活标签是 md 时：编译目标退回 tex 标签，而不是把 md 交给 latexmk
    findButtons('文件')[0].click()
    await tick()
    wb.querySelectorAll('.dmz-wb-file')[2].click() // notes.md
    await tick()
    check('激活的是 notes.md', dbg2.active() && dbg2.active().relPath === 'notes.md',
      dbg2.active() && dbg2.active().relPath)
    compileCalls.length = 0
    await dbg2.compileNow()
    await tick()
    check('激活 md 时改编 tex', compileCalls.length === 1 && /\.tex$/.test(compileCalls[0]),
      JSON.stringify(compileCalls))
  }

  console.log('\n[12] 失败时把日志交出去（latexmk 层面的失败只有它说得清）')
  {
    dbg.jumpToSource('main.tex', 1, 1)
    await tick()
    dbg.buildPanel()
    await tick()
    const p = dbg.panel()
    const TAIL = 'Latexmk: Missing input file "x.toc"\nLatexmk: Errors, so I did not complete building'

    // 有结构化错误：不铺 tail（避免噪音），但要给出日志入口
    compileReply = {
      ok: false,
      errors: [{ file: 'main.tex', line: 12, message: 'Undefined control sequence' }],
      tail: TAIL,
      latexmkLog: 'main.latexmk.log',
      texLog: 'main.log',
    }
    await dbg.compileNow()
    await tick()
    check('横幅提到旧版', /旧版本|旧的 PDF/.test(p.staleTextEl.textContent),
      JSON.stringify(p.staleTextEl.textContent))
    check('出现日志入口', p.staleLogEl.style.display !== 'none', String(p.staleLogEl.style.display))
    check('日志入口写明文件名', /main\.latexmk\.log/.test(p.staleLogEl.textContent),
      JSON.stringify(p.staleLogEl.textContent))
    check('有结构化错误时不铺 tail',
      !findIn(p.staleListEl, (n) => String(n.className).indexOf('stale-tail') >= 0))

    // 无结构化错误（latexmk 中途放弃）：tail 必须顶上来，这就补上了原来的盲区
    compileReply = {
      ok: false,
      errors: [],
      fatal: '',
      tail: TAIL,
      latexmkLog: 'main.latexmk.log',
      texLog: null,
    }
    await dbg.compileNow()
    await tick()
    const tailEl = findIn(p.staleListEl, (n) => String(n.className).indexOf('stale-tail') >= 0)
    check('无结构化错误时铺 tail', !!tailEl)
    if (tailEl) {
      check('tail 内容正确', /did not complete building/.test(tailEl.textContent),
        JSON.stringify(tailEl.textContent.slice(0, 60)))
    }
    check('无结构化错误时列表自动展开', p.staleListEl.style.display === 'flex',
      String(p.staleListEl.style.display))
    check('横幅摘要取 tail 末行', /did not complete building/.test(p.staleTextEl.textContent),
      JSON.stringify(p.staleTextEl.textContent))

    // 点日志入口：在工作台里开成标签，且不要把 PDF 预览收起来
    const pdfPane = findIn(wb, (n) => String(n.className).indexOf('dmz-wb-pdf') >= 0)
    check('找到 PDF 面板', !!pdfPane)
    // 先显式展开预览：否则「没收起」可能只是因为它本来就收着，断言会白过
    const previewToggle = wb.querySelector('[data-dmz-wb-preview]')
    if (pdfPane && pdfPane.style.display === 'none' && previewToggle) {
      previewToggle.click()
      await tick()
    }
    check('预览已展开（前置条件）', pdfPane.style.display === '', String(pdfPane.style.display))
    const tabsBefore = tabsNow().length
    p.staleLogEl.click()
    await tick()
    check('日志被开成标签', tabsNow().length === tabsBefore + 1, String(tabsNow().length))
    check('日志标签路径正确',
      dbg.tabs().some((t) => t.relPath === 'main.latexmk.log'),
      JSON.stringify(dbg.tabs().map((t) => t.relPath)))
    check('打开日志后预览仍展开', pdfPane.style.display === '', String(pdfPane.style.display))

    // 没有日志字段时入口应隐藏（老宿主 / 写入失败）
    compileReply = { ok: false, errors: [{ file: 'main.tex', line: 5, message: 'x' }], tail: '', latexmkLog: null }
    await dbg.compileNow()
    await tick()
    check('无日志字段时入口隐藏', p.staleLogEl.style.display === 'none',
      String(p.staleLogEl.style.display))
  }

  console.log('\n[13] 清理编译产物')
  {
    // 命令面板里应有两条（aux / log 两档），入口全删掉后这是唯一的触发方式
    const cleanCmd = cmds.find((c) => c.id === 'dsh-dmzlatexworkshop.cleanAux')
    const cleanLogCmd = cmds.find((c) => c.id === 'dsh-dmzlatexworkshop.cleanLog')
    check('注册了「清理编译产物」', !!cleanCmd, JSON.stringify(cmds.map((c) => c.id)))
    check('注册了「只清理日志」', !!cleanLogCmd)
    check('label 说明保留 .tex/.pdf', /保留 \.tex 与 \.pdf/.test(cleanCmd.label), cleanCmd.label)

    dbg.jumpToSource('main.tex', 1, 1)
    await tick()

    cleanCalls.length = 0
    cleanReply = { removed: ['a.aux', 'a.log', 'a.latexmk.log'], failed: [], bytes: 3000, listed: 3 }
    cleanCmd.run()
    await tick()
    check('发出了 cleanAux', cleanCalls.length === 1, String(cleanCalls.length))
    check('scope=aux', cleanCalls[0] && cleanCalls[0].scope === 'aux',
      cleanCalls[0] && cleanCalls[0].scope)
    check('清理的是当前文档', cleanCalls[0] && cleanCalls[0].relPath === 'main.tex',
      cleanCalls[0] && cleanCalls[0].relPath)

    cleanCalls.length = 0
    cleanLogCmd.run()
    await tick()
    check('log 档 scope=log', cleanCalls[0] && cleanCalls[0].scope === 'log',
      cleanCalls[0] && cleanCalls[0].scope)

    // 无事可清：不该报错（幂等）
    cleanCalls.length = 0
    cleanReply = { removed: [], failed: [], bytes: 0, listed: 0 }
    cleanCmd.run()
    await tick()
    check('无产物时不抛错且仍发了请求', cleanCalls.length === 1, String(cleanCalls.length))

    // 部分失败（文件被占用）：仍算成功，但要报告失败数
    cleanReply = { removed: ['a.aux'], failed: ['a.log'], bytes: 100, listed: 2 }
    cleanCmd.run()
    await tick()
    check('部分失败不中断', cleanCalls.length === 2, String(cleanCalls.length))
  }

  console.log('\n[14] 顶栏「清理」按钮')
  {
    const bar = wb.children[0]
    const iCompile = bar.children.findIndex((c) => c.textContent === '编译')
    const iClean = bar.children.findIndex((c) => c.querySelector && c.querySelector('[data-dmz-wb-clean]'))
    const iPreview = bar.children.findIndex((c) => c.attrs && c.attrs['data-dmz-wb-preview'] !== undefined)
    check('顶栏有清理按钮', iClean >= 0, String(iClean))
    check('位置在编译之后', iClean > iCompile, iClean + ' vs ' + iCompile)
    check('位置在收起预览之前', iClean < iPreview, iClean + ' vs ' + iPreview)

    const menu = wb.querySelector('[data-dmz-wb-menu]')
    check('菜单默认隐藏', !!menu && menu.hidden === true, menu && String(menu.hidden))
    const items = menu.children.filter((c) => String(c.className) === 'dmz-wb-menu-item')
    check('两项粒度：全部产物 / 只清日志', items.length === 2, String(items.length))
    check('第一项是清理产物', items[0].textContent === '清理编译产物', items[0].textContent)
    check('第二项是只清日志', items[1].textContent === '只清理日志', items[1].textContent)

    const cleanBtn = bar.children[iClean].querySelector('[data-dmz-wb-clean]')
    cleanBtn.click()
    check('点按钮展开菜单', menu.hidden === false)

    dbg.jumpToSource('main.tex', 1, 1)
    await tick()
    cleanCalls.length = 0
    cleanReply = { removed: ['a.aux', 'a.log'], failed: [], bytes: 2048, listed: 2 }
    items[0].click()
    await tick()
    check('菜单项一 → scope=aux', cleanCalls[0] && cleanCalls[0].scope === 'aux',
      cleanCalls[0] && cleanCalls[0].scope)
    check('点完菜单收起', menu.hidden === true)

    cleanBtn.click()
    cleanCalls.length = 0
    items[1].click()
    await tick()
    check('菜单项二 → scope=log', cleanCalls[0] && cleanCalls[0].scope === 'log',
      cleanCalls[0] && cleanCalls[0].scope)

    // 再点一次按钮 = 收起（不是又开一层）
    cleanBtn.click()
    check('按钮可再次展开', menu.hidden === false)
    cleanBtn.click()
    check('再点一次收起', menu.hidden === true)
  }

  console.log('\n[15] 正向搜索（源码 → PDF）')
  {
    const fwdCmd = cmds.find((c) => c.id === 'dsh-dmzlatexworkshop.forward')
    check('注册了正向搜索命令', !!fwdCmd, JSON.stringify(cmds.map((c) => c.id)))
    check('label 写明正向搜索', /正向搜索/.test(fwdCmd.label), fwdCmd.label)

    // 造一个「已经打开着 PDF」的预览状态：不经过 pdf.js，本节只验坐标与滚动
    const p = dbg.panel()
    p.pdfRel = 'main.pdf'
    p.doc = { numPages: 5 }
    p.scale = 1.5
    const slot = makeEl('div')
    slot.className = 'dsh-dmzlatexworkshop-slot'
    slot.setAttribute('data-page', '3')
    slot.setAttribute('data-state', 'done')
    slot.getBoundingClientRect = () => ({ top: 700, bottom: 1000, left: 0, right: 600, width: 600, height: 300 })
    // 页槽按页号索引，所以 3 页要真的有三格（第 3 页的 top 定在 700）
    p.slots = []
    for (let i = 0; i < 5; i++) {
      const s = i === 2 ? slot : makeEl('div')
      if (i !== 2) {
        s.className = 'dsh-dmzlatexworkshop-slot'
        s.setAttribute('data-page', String(i + 1))
        s.setAttribute('data-state', 'done')
      }
      p.slots.push(s)
    }
    p.scrollEl = {
      scrollTop: 0,
      clientHeight: 600,
      getBoundingClientRect: () => ({ top: 100, left: 0, width: 600, height: 600 }),
    }

    const ed = fakeEditors[0]
    ed.__pos = { lineNumber: 42, column: 7 }
    viewCalls.length = 0
    viewReply = { page: 3, x: 72, y: 100, pdfRel: 'main.pdf' }
    await dbg.forwardSearch()
    await tick()

    check('发出了 synctexView', viewCalls.length === 1, String(viewCalls.length))
    check('行号取自光标', viewCalls[0] && viewCalls[0].line === 42, String(viewCalls[0] && viewCalls[0].line))
    check('列号也带上', viewCalls[0] && viewCalls[0].column === 7, String(viewCalls[0] && viewCalls[0].column))
    check('源文件是光标所在标签', viewCalls[0] && viewCalls[0].relPath === 'main.tex',
      viewCalls[0] && viewCalls[0].relPath)
    check('PDF 归属单独传', viewCalls[0] && viewCalls[0].pdfRel === 'main.pdf',
      viewCalls[0] && viewCalls[0].pdfRel)

    // 750 = (700-100) + 100*1.5；落点留在视口上三分之一（-200）
    check('滚到落点上方三分之一处', p.scrollEl.scrollTop === 550, String(p.scrollEl.scrollTop))
    const mark = slot.children.find((c) => String(c.className).indexOf('dsh-dmzlatexworkshop-flash') === 0)
    check('落点有高亮', !!mark)
    check('高亮位置= y*scale - 半高', mark && mark.style.top === '140px', mark && mark.style.top)

    // 从子文件发起：PDF 仍是主文档那份，行号用子文件的
    dbg.jumpToSource('chap1.tex', 10, 1)
    await tick()
    ed.__pos = { lineNumber: 10, column: 1 }
    viewCalls.length = 0
    await dbg.forwardSearch()
    await tick()
    check('子文件发起时源文件是子文件', viewCalls[0] && viewCalls[0].relPath === 'chap1.tex',
      viewCalls[0] && viewCalls[0].relPath)
    check('子文件发起时 PDF 仍是主文档', viewCalls[0] && viewCalls[0].pdfRel === 'main.pdf',
      viewCalls[0] && viewCalls[0].pdfRel)

    // 页号越界不该抛错
    check('页号越界返回 false', dbg.scrollPdfTo(99, 0, 0) === false)

    // 失败原因是经 edrv:status 事件出去的，这里收一下
    const statuses = []
    const origDispatch = window.dispatchEvent
    window.dispatchEvent = (ev) => {
      if (ev && ev.type === 'edrv:status' && ev.detail) statuses.push(ev.detail.text)
      return true
    }
    // synctex 找不到位置：给提示，不崩，也不再滚动
    viewFail = true
    viewCalls.length = 0
    p.scrollEl.scrollTop = 0
    await dbg.forwardSearch()
    await tick()
    check('宿主报错时仍发了一次请求', viewCalls.length === 1, String(viewCalls.length))
    check('失败时不滚动页面', p.scrollEl.scrollTop === 0, String(p.scrollEl.scrollTop))
    const last = statuses[statuses.length - 1] || ''
    check('把宿主的原因告诉用户', /定位不到/.test(last) && /synctex 未找到对应位置/.test(last), last)
    window.dispatchEvent = origDispatch
    viewFail = false
  }

  console.log('\n[16] Monaco 迟到时语言层还能装上（v2.7.2 回归）')
  {
    // 真实现象：启动时页面没有 Monaco，自带 vendor 只在「打开工作台」那一刻注入。
    // 用户过了一小时才点开页签，语言层早就在 600 次轮询后放弃了 → 代码全无颜色。
    // 测试桩故意不长 languages（见上面 fakeMonaco 的注释），正好复现「残缺实例」，
    // 于是这个等待者从 apply 起就一直排在队列里 —— 跟线上完全一致。
    const stub = window.monaco
    delete window.monaco
    check('没有 Monaco 时探测为空', dbg.probeMonaco() === null, String(dbg.probeMonaco()))

    const waiting = dbg.langState()
    check('语言层一直在等（无超时放弃）', waiting.waiters >= 1, String(waiting.waiters))
    check('且在轮询', waiting.polling === true, String(waiting.polling))

    let woke = 0
    dbg.whenMonaco(() => { woke++ })
    check('未就绪时不立即回调', woke === 0, String(woke))
    check('新等待者也入队', dbg.langState().waiters === waiting.waiters + 1,
      String(dbg.langState().waiters))

    // 残缺实例（只有 editor、没有 languages）不能把队列清空，否则语言层再没人负责
    const partial = { editor: { getModels: () => [] } }
    check('残缺实例不唤醒', dbg.flushMonacoWaiters(partial) === false)
    check('等待者没被清空', dbg.langState().waiters === waiting.waiters + 1,
      String(dbg.langState().waiters))
    check('轮询没停', dbg.langState().polling === true)

    // 真正的 Monaco 到位
    const full = Object.assign({}, stub)
    full.languages = {
      getLanguages: () => [],
      register: () => {},
      setLanguageConfiguration: () => {},
      setMonarchTokensProvider: () => {},
    }
    window.monaco = full
    check('就绪时唤醒', dbg.flushMonacoWaiters(full) === true)
    check('回调只跑一次', woke === 1, String(woke))
    check('队列已清空', dbg.langState().waiters === 0, String(dbg.langState().waiters))
    check('轮询已停', dbg.langState().polling === false, String(dbg.langState().polling))
    check('语言层绑在这个实例上', dbg.langState().ready === full, String(!!dbg.langState().ready))

    // 这就是用户看得见的结果：已经打开的 tex 标签必须被补成 LaTeX
    const mainTab = dbg.tabs().find((t) => t.relPath === 'main.tex')
    check('已打开的 tex 标签补上语法',
      !!mainTab && mainTab.model.getLanguageId() === 'latex',
      mainTab && mainTab.model.getLanguageId())
    const mdTab = dbg.tabs().find((t) => /\.md$/.test(t.relPath))
    check('md 标签仍是纯文本', !!mdTab && mdTab.model.getLanguageId() === 'plaintext',
      mdTab && mdTab.model.getLanguageId())

    // 同一实例重复装 = 什么都不做（否则每点一次命令就多挂一套监听器）
    check('重复 setup 同实例返回 false', dbg.setupLanguageLayer(full) === false)
    check('全局钩子只挂一次', dbg.langState().hooksBound === true)

    // 手动补救命令存在且可执行（这是「不用重启」的逃生口）
    const reloadCmd = cmds.find((c) => c.id === 'dsh-dmzlatexworkshop.reloadSyntax')
    check('注册了「重新加载语法高亮」', !!reloadCmd, JSON.stringify(cmds.map((c) => c.id)))
    let threw = null
    try { reloadCmd.run() } catch (error) { threw = error }
    check('执行不抛错', threw === null, threw && String(threw.message))
    check('补救后标签仍是 LaTeX', mainTab.model.getLanguageId() === 'latex',
      mainTab.model.getLanguageId())
  }

  console.log('\n完成' + (process.exitCode ? '（有失败项）' : '（全部通过）'))
  process.exit(process.exitCode || 0)
})()
