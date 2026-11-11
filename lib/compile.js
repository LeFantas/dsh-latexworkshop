/**
 * dsh-dmzlatexworkshop host — 编译与 SyncTeX 定位核心逻辑。
 * 纯 node 内置模块实现，不依赖 DSH 服务，可脱离应用单独测试。
 * 设计约束：不做 AI 调用、不读会话内容，只跑本地 TeX 工具链。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, basename, extname, relative } from 'node:path'

/** TeX 发行版常见安装目录（PATH 里找不到时按序回退；实测这台机器是第一个）。 */
const TEX_DIRS = [
  'C:\\texlive\\2024\\bin\\windows',
  'C:\\texlive\\2025\\bin\\windows',
  'C:\\texlive\\2023\\bin\\windows',
  'C:\\Program Files\\MiKTeX\\miktex\\bin\\x64',
  'C:\\Program Files\\MiKTeX 2.9\\miktex\\bin\\x64',
]

/** 单次编译上限（大论文 + 大量图表会慢，但超过 4 分钟基本是死循环）。 */
const COMPILE_TIMEOUT_MS = 240000
/** 保留给前端展示的输出尾部行数。 */
const TAIL_LINES = 40
/** latexmk 输出的落盘后缀。与 TeX 自己的 `.log` 分开，互不覆盖。 */
const MK_LOG_SUFFIX = '.latexmk.log'
/** 落盘上限：超过就掐头去尾留中间说明，不能因为一次疯狂输出把工作区塞满。 */
const MK_LOG_MAX_CHARS = 512 * 1024

/**
 * 把 latexmk 的完整输出写进工作区。
 *
 * 为什么要落盘：TeX 的 `.log` 里只有 xelatex 那一层的东西，latexmk **自己**的判断
 * （缺引擎、缺 .sty、多趟编译中途放弃、`Missing input file`）只在它的 stdout/stderr 里，
 * 原来这份输出随 RPC 响应返回给客户端后就被丢掉了 —— 而客户端从未用过 `tail` 字段。
 * 结果是最难查的那类失败（latexmk 压根没把活干完）反而没有任何可看的痕迹。
 *
 * 落盘位置刻意选在**源文件同目录**：AI 或人只要知道 .tex 在哪，就能按固定规则找到它，
 * 不需要知道 `~/.dsh` 在哪、也不受日志轮转影响。文件名带 `.latexmk.log` 而不是 `.log`，
 * 免得覆盖 TeX 自己的日志（那份有出错行上下文，同样有用）。
 *
 * @param absPath 目标文件绝对路径
 * @param info 头部信息（文档名、退出码、耗时等）
 * @param out 合并后的 stdout+stderr
 * @returns 是否写入成功
 */
export function writeLatexmkLog(absPath, info, out) {
  const stem = String(info.texFile || '').replace(/\.tex$/i, '')
  const head = [
    '# latexmk 完整输出 — dsh-dmzlatexworkshop',
    '# 生成于 ' + new Date().toISOString(),
    '# 文档：' + info.texFile,
    '# 命令：latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error ' + info.texFile,
    '# 退出码：' + info.code + (info.code === 0 ? '（成功）' : '（失败）'),
    '# 耗时：' + info.durationMs + 'ms',
    '# 同目录的 ' + stem + '.log 是 TeX 引擎自己的日志（含出错行的源码上下文），两者互补',
    '# ' + '-'.repeat(64),
    '',
  ].join('\n')
  let body = String(out || '')
  if (body.length > MK_LOG_MAX_CHARS) {
    const keep = Math.floor(MK_LOG_MAX_CHARS / 2)
    const dropped = body.length - MK_LOG_MAX_CHARS
    body = body.slice(0, keep)
      + '\n\n... [中间省略 ' + dropped + ' 字符，全文共 ' + body.length + ' 字符] ...\n\n'
      + body.slice(-keep)
  }
  try {
    writeFileSync(absPath, head + body, 'utf8')
    return true
  } catch {
    // 目录只读 / 磁盘满：诊断信息写不进去不该让编译本身失败
    return false
  }
}

/**
 * 定位可执行文件：先扫 PATH，再回退 TeX 常见目录。
 * @param name 不含扩展名的命令名
 * @returns 绝对路径或原名（交给 spawn 报错）
 */
export function which(name) {
  const exe = process.platform === 'win32' ? name + '.exe' : name
  const env = process.env.PATH || process.env.Path || ''
  for (const dir of env.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  for (const dir of TEX_DIRS) {
    const candidate = join(dir, exe)
    if (existsSync(candidate)) return candidate
  }
  return exe
}

/**
 * 子进程执行（收集 stdout+stderr，带超时与强杀）。
 * @param bin 可执行文件
 * @param argv 参数
 * @param cwd 工作目录
 * @param timeoutMs 超时
 * @returns {code, out}
 */
export function run(bin, argv, cwd, timeoutMs = COMPILE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const child = spawn(bin, argv, {
      cwd,
      windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      resolve({ code: -1, out: out + '\n[超时] 编译超过 ' + Math.round(timeoutMs / 1000) + ' 秒已终止' })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { out += chunk.toString('utf8') })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -2, out: out + '\n[启动失败] ' + String(error && error.message ? error.message : error) })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: typeof code === 'number' ? code : -1, out })
    })
  })
}

/**
 * 解析编译输出为结构化诊断。
 * 依赖 -file-line-error：错误被打成 `./file.tex:12: message` 单行，
 * 未带文件行的 `! ...` 兜底为无定位错误。
 * @param text 合并后的 stdout+stderr
 * @returns {errors, warnings}
 */
export function parseDiagnostics(text) {
  const errors = []
  const warnings = []
  const lines = text.split(/\r?\n/)
  const errRe = /^(?:\.\/)?([^:\r\n]+\.(?:tex|sty|cls|bib)):(\d+):\s*(.+)$/
  for (const line of lines) {
    const m = errRe.exec(line.trim())
    if (m) {
      errors.push({ file: m[1], line: Number(m[2]), message: m[3].trim(), severity: 'error' })
      continue
    }
    const trimmed = line.trim()
    if (trimmed.startsWith('! ') || trimmed === '!') {
      const message = trimmed.replace(/^!\s*/, '') || 'LaTeX 错误'
      // 紧跟的 `l.42` 行能补出行号
      errors.push({ file: '', line: 0, message, severity: 'error' })
      continue
    }
    if (/^(?:LaTeX|Package|Class)\b.*Warning:/i.test(trimmed) || /^Overfull \\hbox/i.test(trimmed)) {
      warnings.push({ message: trimmed.slice(0, 300) })
    }
  }
  return { errors, warnings: warnings.slice(0, 60) }
}

/**
 * 从日志里取页数（xelatex 分两步，会出现 `main.xdv` 与 `main.pdf` 两条，取最后一条）。
 * @param logText main.log 内容
 * @returns 页数或 null
 */
export function parsePages(logText) {
  if (!logText) return null
  const all = [...String(logText).matchAll(/Output written on .+?\((\d+) pages?/g)]
  if (!all.length) return null
  return Number(all[all.length - 1][1])
}

/**
 * 编译 LaTeX 文档。
 * @param texAbs 主 .tex 绝对路径
 * @returns 结构化结果（相对路径以 texAbs 所在目录为基准）
 */
export async function compile(texAbs) {
  const started = Date.now()
  if (!existsSync(texAbs)) {
    return { ok: false, fatal: '文件不存在：' + texAbs, errors: [], warnings: [], durationMs: 0 }
  }
  const dir = dirname(texAbs)
  const file = basename(texAbs)
  const bin = which('latexmk')
  const argv = [
    '-xelatex',
    '-synctex=1',
    '-interaction=nonstopmode',
    '-file-line-error',
    file,
  ]
  const { code, out } = await run(bin, argv, dir)
  const stem = file.replace(/\.tex$/i, '')
  const pdfAbs = join(dir, stem + '.pdf')
  const hasPdf = existsSync(pdfAbs)
  const { errors, warnings } = parseDiagnostics(out)
  let pages = null
  const logPath = join(dir, stem + '.log')
  if (existsSync(logPath)) {
    try {
      pages = parsePages(readFileSync(logPath, 'utf8'))
    } catch { /* 日志读取失败不影响编译结论 */ }
  }
  const ok = code === 0 && hasPdf && errors.length === 0
  const durationMs = Date.now() - started
  // latexmk 输出落盘：成功也写（AI 常需要看「哪些文件被读过」「为什么触发了重跑」），
  // 失败更是必须写。写不进去只影响可诊断性，不影响编译结论本身。
  const mkLogFile = stem + MK_LOG_SUFFIX
  const mkLogWritten = writeLatexmkLog(
    join(dir, mkLogFile),
    { texFile: file, code, durationMs },
    out,
  )
  const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-TAIL_LINES).join('\n')
  return {
    ok,
    exitCode: code,
    pdf: hasPdf ? stem + '.pdf' : null,
    pages,
    durationMs,
    errors: errors.slice(0, 200),
    warnings,
    tail,
    // 两份日志的相对位置（客户端拼进提示里，AI 按这个路径就能读到）
    latexmkLog: mkLogWritten ? mkLogFile : null,
    texLog: existsSync(logPath) ? stem + '.log' : null,
  }
}

/**
 * 正向搜索：源码行 → PDF 页与坐标。
 *
 * 两个路径要分开：`texAbs` 决定「哪份 PDF / 哪个编译目录」，`srcAbs` 是
 * 「光标所在的那个文件」。二者在多文件项目里通常不同——主文件 `main.tex`
 * 里 `\input{sec/a.tex}`，从 `sec/a.tex` 里发起正向搜索时，PDF 仍是
 * `main.pdf`，但要查的行属于 `sec/a.tex`。早先只传一个参数，子文件里的
 * 光标会被当成主文件的同号行，位置整体偏掉。
 *
 * @param texAbs 主 .tex 绝对路径（定位 PDF 与工作目录）
 * @param line 1-based 行号
 * @param column 1-based 列号（缺省 1）
 * @param srcAbs 光标所在的文件（缺省同 texAbs）
 * @returns {page, x, y} 或 {error}
 */
export async function synctexView(texAbs, line, column = 1, srcAbs) {
  const dir = dirname(texAbs)
  // 客户端可能直接给 .pdf（它手上只有 pdf 相对路径），两种都要能吃
  const stem = basename(texAbs).replace(/\.(tex|pdf)$/i, '')
  const pdf = stem + '.pdf'
  if (!existsSync(join(dir, pdf))) return { error: 'PDF 尚不存在，先编译' }
  // synctex 记录的是编译时工作目录下的相对路径，所以优先按相对路径查；
  // 换盘符时 relative() 会给绝对路径，原样交给它也能匹配到绝对记录。
  // 只给了 .pdf（客户端手上只有 PDF 相对路径）时，退回同名的 .tex。
  const texGuess = join(dir, stem + '.tex')
  const src = srcAbs && existsSync(srcAbs)
    ? srcAbs
    : (existsSync(texGuess) ? texGuess : texAbs)
  let input = relative(dir, src).replace(/\\/g, '/')
  if (!input) input = basename(src)
  const { code, out } = await run(which('synctex'), ['view', '-i', line + ':' + column + ':' + input, '-o', pdf], dir, 30000)
  if (code !== 0) return { error: 'synctex 未找到对应位置' }
  const page = /Page:\s*(\d+)/.exec(out)
  const x = /\bx:\s*([-\d.]+)/.exec(out)
  const y = /\by:\s*([-\d.]+)/.exec(out)
  if (!page) return { error: 'synctex 未找到对应位置' }
  return {
    page: Number(page[1]),
    x: x ? Number(x[1]) : 0,
    y: y ? Number(y[1]) : 0,
  }
}

/**
 * 反向搜索：PDF 页与坐标 → 源码位置。
 * @param texAbs 主 .tex 绝对路径（用于定位 PDF 与工作目录）
 * @param page 页码
 * @param x PDF 坐标（左上原点，bp）
 * @param y 同上
 * @returns {file, line} 或 null
 */
export async function synctexEdit(texAbs, page, x, y) {
  const dir = dirname(texAbs)
  const stem = basename(texAbs).replace(/\.tex$/i, '')
  const pdf = stem + '.pdf'
  if (!existsSync(join(dir, pdf))) return { error: 'PDF 尚不存在' }
  const arg = Math.round(page) + ':' + Math.round(x) + ':' + Math.round(y) + ':' + pdf
  const { code, out } = await run(which('synctex'), ['edit', '-o', arg], dir, 30000)
  if (code !== 0) return { error: 'synctex 反向查找失败' }
  const input = /Input:([^\r\n]+)/.exec(out)
  const line = /Line:\s*(-?\d+)/.exec(out)
  const column = /Column:\s*(-?\d+)/.exec(out)
  if (!input || !line) return { error: 'synctex 未返回源码位置' }
  // Input 形如 C:/..././main.tex，规范化并去重分隔符
  const file = input[1].trim().replace(/[\\/]+/g, '/').replace(/\/\.\//g, '/')
  return {
    file,
    line: Math.max(1, Number(line[1])),
    column: column && Number(column[1]) > 0 ? Number(column[1]) : 1,
  }
}

/**
 * 取一个会话当前真正的工作目录。
 *
 * `session.header.cwd` 只是**创建时**记下的原始目录，用户 `cd` 之后就不准了。
 * `workingDirectory` 服务记录的是每个会话的**当前**目录（投影状态），优先用它。
 * 服务缺失（老版本宿主）时回落到 header.cwd。
 *
 * @param ctx DSH 上下文
 * @param session 会话对象
 * @returns 绝对路径，或 null
 */
export function sessionCwdOf(ctx, session) {
  if (!session) return null
  try {
    const wd = ctx.get('workingDirectory')
    if (wd && typeof wd.get === 'function') {
      const dir = wd.get(session)
      if (typeof dir === 'string' && dir.length > 0 && isAbsolute(dir)) return dir
    }
  } catch { /* 服务缺失就回落 */ }
  const cwd = session.header ? session.header.cwd : null
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/**
 * 列出所有 live 会话，**最近活跃的排在最前**。
 *
 * 宿主 `sessions.list()` 明确是「in creation order」——最早的排最前，直接用会把
 * 「当前会话」定位到很久以前那个会话上（多项目并行时必然串台）。
 *
 * 活跃度取会话日志里**最后一个事件的 time**；空会话回落到 header.createdAt。
 * 这比「创建时间」准得多：一个三天前创建、但刚刚还在对话的会话会正确排到最前。
 *
 * @param ctx DSH 上下文
 * @returns 会话数组（活跃 → 沉寂）
 */
export function liveSessionsNewestFirst(ctx) {
  let sessions = null
  try { sessions = ctx.get('sessions') } catch { /* 服务缺失 */ }
  const list = sessions && typeof sessions.list === 'function' ? sessions.list() : []
  return list.slice().sort((a, b) => lastActivityOf(b) - lastActivityOf(a))
}

/** 会话最近活跃时间（最后一个事件的时间），拿不到就回落到创建时间，再不行当 0。 */
function lastActivityOf(session) {
  try {
    const events = session && session.events
    if (Array.isArray(events) && events.length > 0) {
      const t = events[events.length - 1] && events[events.length - 1].time
      if (typeof t === 'number' && Number.isFinite(t)) return t
    }
  } catch { /* 快照不可用就回落 */ }
  const created = session && session.header ? session.header.createdAt : null
  return typeof created === 'number' && Number.isFinite(created) ? created : 0
}

/**
 * 侧边栏最近一次访问的项目（被动观察来的，见 index.js 的 `watchWorkspaceFiles`）。
 *
 * 侧边栏文件树调宿主 `workspaceFiles` 时，第一个参数是
 * `{ sessionId, workspaceRoot }`，其中 `workspaceRoot` 就是 `session.header.cwd`，
 * 也正是文件树顶上那个根。记录下来就是「用户此刻在看哪个项目」的直接证据。
 */
const observed = { sessionId: null, root: null, at: 0 }

/**
 * 接受一次 `workspaceFiles` 调用的 scope 并记住它。
 * @param scope `{ sessionId, workspaceRoot }`
 */
export function rememberObservedScope(scope) {
  if (!scope || typeof scope !== 'object') return
  try {
    if (typeof scope.sessionId === 'string' && scope.sessionId) observed.sessionId = scope.sessionId
    const root = scope.workspaceRoot
    if (typeof root === 'string' && root.length > 0) {
      observed.root = root
      observed.at = Date.now()
    }
  } catch { /* 记录失败不影响主流程 */ }
}

/**
 * 侧边栏最近访问的项目根（只在这个目录还存在时才认）。
 * @returns 绝对路径，或 null
 */
export function observedProjectRoot() {
  if (!observed.root) return null
  try {
    if (!existsSync(observed.root)) return null
    if (!statSync(observed.root).isDirectory()) return null
  } catch { return null }
  return observed.root
}

/** 观察到的会话 id（客户端没上报时的备用线索）。 */
export function observedSessionId() {
  return observed.sessionId
}

/**
 * 按 sessionId 定位它所属的「项目根」。
 *
 * 侧边栏文件树走的也是 sessionId —— `remote.workspaceFiles.list(sessionId, path)`
 * （见 `dsh-client-ui-sidebar-files`），所以这条路和用户看到的「当前项目」**同源**。
 * 比「最近活跃会话」猜出来的结果准得多：切到一个安静的老会话也照样对。
 *
 * 三级回落：
 *  1. `workspaceRegistry`：workspace 就是侧边栏里的「项目」，`path` 就是那个根。
 *     它的 `sessionIds` 已按 canonical cwd 过滤，含这个 session 就说明归属它。
 *  2. 该会话的当前目录（`workingDirectory` 投影，跟着 `cd` 走）。
 *  3. 什么都没有就返回 null，由调用方回落到旧的「最近活跃」逻辑。
 *
 * @param ctx DSH 上下文
 * @param sessionId 会话 id（客户端随 RPC 上报）
 * @returns 绝对路径，或 null
 */
export function projectRootOfSession(ctx, sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null
  const usable = (p) => typeof p === 'string' && p.length > 0 && existsSync(p)

  // 1) 归属的 workspace —— 最贴近「当前项目」的语义
  try {
    const registry = ctx.get('workspaceRegistry')
    const workspaces = registry && typeof registry.list === 'function' ? registry.list() : []
    for (const workspace of workspaces) {
      let ids = null
      let root = null
      try { ids = workspace && workspace.sessionIds } catch { ids = null }
      try { root = workspace && workspace.path } catch { root = null }
      if (Array.isArray(ids) && ids.includes(sessionId) && usable(root)) return root
    }
  } catch { /* 服务缺失（老版本宿主）就回落 */ }

  // 2) 该会话的当前目录
  try {
    const sessions = ctx.get('sessions')
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : null
    const cwd = session ? sessionCwdOf(ctx, session) : null
    if (usable(cwd)) return cwd
  } catch { /* 服务缺失就回落 */ }

  return null
}

/**
 * 把相对路径解析为绝对路径：逐个 live 会话的工作区根试探，命中即用。
 * @param ctx DSH 上下文
 * @param relPath 工作区相对路径（也接受绝对路径）
 * @param sessionId 客户端指名的会话（可选）；给了就先在它的项目里找
 * @returns {abs} 或 {error}
 */
export function resolveWorkspacePath(ctx, relPath, sessionId) {
  if (!relPath || typeof relPath !== 'string') return { error: '缺少文件路径' }
  if (isAbsolute(relPath) && existsSync(relPath)) return { abs: relPath }
  const tried = []
  // 指名了会话就**只认它的项目**：多项目并行时去别人家目录里翻文件正是串台的根源，
  // 找不到就老实报错，让人知道路径不对，而不是悄悄打开另一个项目的同名文件。
  const own = projectRootOfSession(ctx, sessionId) || projectRootOfSession(ctx, observedSessionId())
  if (own) {
    const candidate = join(own, relPath)
    if (existsSync(candidate)) return { abs: candidate }
    return { error: '找不到文件 ' + relPath + '（当前项目 ' + own + '）' }
  }
  // 拿不到会话才退回猜测：侧边栏最近访问过的项目优先
  const seen = observedProjectRoot()
  if (seen) {
    const candidate = join(seen, relPath)
    if (existsSync(candidate)) return { abs: candidate }
    tried.push(candidate)
  }
  for (const session of liveSessionsNewestFirst(ctx)) {
    const cwd = sessionCwdOf(ctx, session)
    if (!cwd) continue
    const candidate = join(cwd, relPath)
    if (existsSync(candidate)) return { abs: candidate }
    tried.push(candidate)
  }
  const hint = tried.length ? '（已尝试：' + tried.slice(0, 3).join(' / ') + '）' : '（没有活跃会话可用于解析相对路径）'
  return { error: '找不到文件 ' + relPath + ' ' + hint }
}

/**
 * 绝对路径 → 工作区相对路径（编辑器跳转要相对路径，绝对路径会被归一化失败）。
 * @param ctx DSH 上下文
 * @param absFile 绝对路径
 * @param sessionId 客户端指名的会话（可选）；命中它的项目就直接切
 * @returns 相对路径（无匹配会话时原样返回绝对路径）
 */
export function toWorkspaceRelative(ctx, absFile, sessionId) {
  if (!absFile) return absFile
  const normalized = absFile.replace(/\\/g, '/')
  // 文件就在当前项目里：不用再猜，直接切
  const own = projectRootOfSession(ctx, sessionId) || projectRootOfSession(ctx, observedSessionId())
  if (own) {
    const ownRoot = own.replace(/\\/g, '/').replace(/\/+$/, '')
    if (ownRoot && normalized !== ownRoot && normalized.startsWith(ownRoot + '/')) {
      return normalized.slice(ownRoot.length + 1)
    }
  }
  const seen = observedProjectRoot()
  if (seen) {
    const seenRoot = seen.replace(/\\/g, '/').replace(/\/+$/, '')
    if (seenRoot && normalized !== seenRoot && normalized.startsWith(seenRoot + '/')) {
      return normalized.slice(seenRoot.length + 1)
    }
  }
  let best = null
  for (const session of liveSessionsNewestFirst(ctx)) {
    const cwd = sessionCwdOf(ctx, session)
    if (!cwd) continue
    const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized === root) continue
    if (!normalized.startsWith(root + '/')) continue
    // 命中多个根时取最长（最深）的那个，避免父目录抢先匹配
    if (best === null || root.length > best.length) best = root
  }
  if (best === null) return normalized
  return normalized.slice(best.length + 1)
}

/**
 * 编译产物清单。分两档，都是「跑一次编译就能重新生成」的东西。
 *
 * 为什么不直接调 `latexmk -C`：
 *  1. latexmk 不认识我们自己写的 `.latexmk.log`，处理不了那个孤儿；
 *  2. `-C` 会连 PDF 一起删，而 PDF 正是你要看的东西；
 *  3. 走 shell 还得再拼一次命令、再处理一次失败路径。
 *
 * 明确**不删**：`.tex`（源）、`.pdf`（成品）、`.bib`（数据）、以及任何不认识的扩展名。
 * 清理功能误删源文件是不可接受的，所以这里走白名单而不是通配符。
 */
const AUX_EXTS = [
  '.aux', '.log', '.blg', '.out', '.toc', '.lof', '.lot',
  '.fls', '.fdb_latexmk', '.xdv', '.synctex.gz', '.synctex',
  '.nav', '.snm', '.vrb', '.idx', '.ind', '.ilg', '.bcf', '.run.xml',
  '.bbl', '.gls', '.glo', '.glg', '.acn', '.acr', '.alg',
]
/** 我们自己写的 latexmk 日志（后缀较长，单独列出避免被 `.log` 规则误判）。 */
const MK_LOG_EXT = '.latexmk.log'

/**
 * 列出某个文档的编译产物（只列实际存在的）。
 * @param texAbs 主 .tex 绝对路径
 * @param scope 'log' 只列日志；'aux' 列全部可再生产物
 * @returns {name, size} 数组
 */
export function listArtifacts(texAbs, scope) {
  const dir = dirname(texAbs)
  const stem = basename(texAbs).replace(/\.tex$/i, '')
  const out = []
  const exts = scope === 'log'
    ? [MK_LOG_EXT, '.log', '.blg']
    : [MK_LOG_EXT].concat(AUX_EXTS)
  const seen = new Set()
  for (const ext of exts) {
    if (seen.has(ext)) continue
    seen.add(ext)
    const name = stem + ext
    const abs = join(dir, name)
    try {
      if (!existsSync(abs)) continue
      // 只清文件；同名目录不动（极少见，但真删了会很难解释）
      const st = statSync(abs)
      if (!st.isFile()) continue
      out.push({ name, size: st.size })
    } catch { /* 权限之类，跳过 */ }
  }
  return out
}

/**
 * 清理编译产物。
 * @param texAbs 主 .tex 绝对路径
 * @param scope 'log' | 'aux'
 * @returns {removed: string[], failed: string[], bytes: number}
 */
export function cleanArtifacts(texAbs, scope) {
  const dir = dirname(texAbs)
  const removed = []
  const failed = []
  let bytes = 0
  for (const item of listArtifacts(texAbs, scope)) {
    try {
      bytes += item.size
      rmSync(join(dir, item.name), { force: true })
      removed.push(item.name)
    } catch {
      failed.push(item.name)
    }
  }
  return { removed, failed, bytes }
}

export { extname }
