/**
 * dsh-dmzlatexworkshop host half — 注册 /latex/rpc 路由，执行本地 TeX 编译与 SyncTeX 查询。
 *
 * 为什么需要宿主半：浏览器里没法 spawn 子进程，编译必须由宿主进程执行。
 * 这条路径完全不经过 AI/模型，纯粹是本地工具链调用。
 */

import { cleanArtifacts, compile, listArtifacts, synctexEdit, synctexView, resolveWorkspacePath, toWorkspaceRelative, liveSessionsNewestFirst, sessionCwdOf, projectRootOfSession, rememberObservedScope, observedProjectRoot, observedSessionId } from './compile.js'
import { readVscodeTheme } from './vscode-theme.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 路由路径（避开 vscode-mode 的 /edrv 前缀）。 */
const RPC_PATH = '/latex/rpc'
/** 客户端诊断上报（排查渲染类问题用）。 */
const LOG_PATH = '/latex/log'
/** 请求体上限（仅几个路径字段，64KB 足够）。 */
const MAX_BODY = 64 * 1024
/** 客户端日志上限，超出后轮转一次。 */
const LOG_MAX_BYTES = 512 * 1024
/** 随包附带的第三方运行时（katex，用于公式预览）。 */
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'katex')

/** 自带静态资源的根目录（monaco / pdfjs / katex）。 */
const VENDOR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor')
/** 静态资源路由前缀。客户端所有 vendor 请求都走这里，不再借 vscode-mode 的 /edrv。 */
const VENDOR_PATH = '/dmzlatex/vendor'

/** 扩展名 → MIME。缺省用 octet-stream 而不是猜，避免浏览器把 .mjs 当脚本以外的东西。 */
const VENDOR_MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
}

export const name = 'dsh-dmzlatexworkshop'
export const inject = ['webServer']

/** 工作台文件列表里认的扩展名（可编辑/可预览的文本类）。 */
const DOC_EXTS = new Set(['.tex', '.md', '.markdown', '.bib', '.sty', '.cls', '.ltx'])
/** 列目录上限，避免大仓库一次回传过多。 */
const DOC_MAX_FILES = 600
/** 单个文件读取上限。 */
const DOC_MAX_BYTES = 8 * 1024 * 1024
/** 递归时直接跳过的目录。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', '.cache', '.venv', '__pycache__'])

/** 统一取错误消息。 */
function msgOf(error) {
  return String(error && error.message ? error.message : error)
}

/**
 * 确定工作区根目录。
 * @param ctx DSH 上下文
 * @param dir 可选的显式目录（绝对路径或相对第一个会话 cwd）
 * @returns {abs} 或 {error}
 */
function workspaceRootOf(ctx, dir, sessionId) {
  if (dir && typeof dir === 'string') {
    if (existsSync(dir)) return { abs: dir }
    const resolved = resolveWorkspacePath(ctx, dir, sessionId)
    if (!resolved.error && statSync(resolved.abs).isDirectory()) return { abs: resolved.abs }
  }
  // 客户端指名了会话：直接问宿主要它的项目根。侧边栏文件树就是这么做的
  // （`workspaceFiles.list(sessionId, ...)`），所以这和用户看到的「当前项目」同源。
  const own = projectRootOfSession(ctx, sessionId) || projectRootOfSession(ctx, observedSessionId())
  if (own) {
    try { if (statSync(own).isDirectory()) return { abs: own } } catch { /* 目录没了就回落 */ }
  }
  // 再次：侧边栏最近实际访问过的项目（用户在侧边栏点过文件就一定命中）
  const seen = observedProjectRoot()
  if (seen) return { abs: seen }
  // 兜底：宿主 sessions.list() 是「创建顺序」，多会话并行时会指向最早那个（串台）。
  // 这里按活跃度倒序，并且用 workingDirectory 服务的「当前目录」而不是 header.cwd。
  const list = liveSessionsNewestFirst(ctx)
  for (const session of list) {
    const cwd = sessionCwdOf(ctx, session)
    if (cwd && existsSync(cwd)) return { abs: cwd }
  }
  return { error: '没有可用工作区（无活跃会话 cwd）' }
}

/**
 * 递归收集可编辑文档。
 * @param root 根目录绝对路径
 * @param rel 当前相对路径
 * @param depth 当前深度
 * @param out 结果数组
 * @param limit 数量上限
 */
function collectDocs(root, rel, depth, out, limit) {
  if (out.length >= limit || depth > 6) return
  let entries = []
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (out.length >= limit) return
    const childRel = rel ? rel + '/' + entry.name : entry.name
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      collectDocs(root, childRel, depth + 1, out, limit)
      continue
    }
    if (!entry.isFile()) continue
    const ext = extname(entry.name).toLowerCase()
    if (!DOC_EXTS.has(ext)) continue
    out.push({ path: childRel, name: entry.name, ext })
  }
}

/**
 * 读插件自己的配置文件（可选）。
 * `~/.dsh/dsh-dmzlatexworkshop/config.json`，支持的字段：
 *  - `followVscode` 布尔，默认 true；false 时改用内置色板
 *  - `vscodeTheme`  字符串，指定要读取哪个 VSCode 主题（默认取 VSCode 当前设置）
 * @returns 配置对象，读不到返回空对象
 */
function readConfig() {
  const file = join(homedir(), '.dsh', 'dsh-dmzlatexworkshop', 'config.json')
  if (!existsSync(file)) return {}
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch (error) {
    return {}
  }
}

/**
 * 读取并解析 JSON 请求体。
 * @param req Node 请求
 * @returns 解析后的对象
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text ? JSON.parse(text) : {})
      } catch (error) {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 回写 JSON。
 * @param res Node 响应
 * @param status HTTP 状态码
 * @param payload 响应体
 */
function replyJson(res, status, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 服务 vendor 目录下的静态资源（monaco / pdfjs / katex）。
 *
 * 不做鉴权：这里只有第三方库文件，不含任何用户数据；而 Monaco 的 AMD loader
 * 与 pdf.js 的 worker 都是浏览器自己发起的请求，带不上 RPC 那套请求头，
 * 一旦拦下就表现为「编辑器永远白屏」，排查起来非常费劲。
 * 路径穿越靠两处拦：段级别的 `..` 检查 + normalize 后的前缀比较。
 *
 * @param req Node 请求
 * @param res Node 响应
 */
function serveVendor(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' })
    res.end()
    return
  }
  const url = String(req.url || '')
  let rel = url.startsWith(VENDOR_PATH) ? url.slice(VENDOR_PATH.length) : ''
  const query = rel.indexOf('?')
  if (query >= 0) rel = rel.slice(0, query)
  try {
    rel = decodeURIComponent(rel)
  } catch {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  rel = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!rel || rel.split('/').some((seg) => seg === '..')) {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  const abs = normalize(join(VENDOR_ROOT, rel))
  if (abs !== VENDOR_ROOT && !abs.startsWith(VENDOR_ROOT + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let info
  try {
    info = statSync(abs)
  } catch {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (!info.isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  res.writeHead(200, {
    'content-type': VENDOR_MIME[extname(abs).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'public, max-age=86400',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  try {
    res.end(readFileSync(abs))
  } catch {
    try { res.destroy() } catch { /* 客户端已断开 */ }
  }
}

/**
 * 鉴权：宿主 connection 服务可用时沿用它的判定，缺失则放行（本机回环）。
 * @param ctx DSH 上下文
 * @param req Node 请求
 * @returns 拒绝状态码或 undefined
 */
function rejectionOf(ctx, req) {
  try {
    const connection = ctx.get('connection')
    if (connection && typeof connection.requestRejection === 'function') {
      return connection.requestRejection(req)
    }
  } catch { /* 服务缺失按放行处理 */ }
  return undefined
}

/**
 * 业务分发。
 * @param ctx DSH 上下文
 * @param method 方法名
 * @param args 参数
 * @returns 结果对象
 */
async function dispatch(ctx, method, args) {
  const relPath = args && args.relPath
  // 客户端每次请求都带上它所在的会话 id —— 宿主据此定位「当前项目」，
  // 而不是去猜哪个会话最近活跃。
  const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null
  if (method === 'ping') return { ok: true, data: { pong: Date.now() } }
  if (method === 'readPdf') {
    const target = resolveWorkspacePath(ctx, relPath, sessionId)
    if (target.error) return { ok: false, error: target.error }
    try {
      const buf = readFileSync(target.abs)
      if (buf.length > 40 * 1024 * 1024) return { ok: false, error: 'PDF 过大（>40MB），跳过自检' }
      // mtimeMs 用来判断「这份 PDF 是哪次编译留下的」：编译失败时磁盘上还是旧的，
      // 客户端据此在预览上标出「上次成功的版本」而不至于让人以为改动没生效。
      let mtimeMs = 0
      try { mtimeMs = statSync(target.abs).mtimeMs } catch { mtimeMs = 0 }
      return { ok: true, data: { base64: buf.toString('base64'), bytes: buf.length, mtimeMs } }
    } catch (error) {
      return { ok: false, error: '读取 PDF 失败：' + String(error && error.message ? error.message : error) }
    }
  }
  // --region 工作台的文件读写（自带编辑器用，不依赖 better-sidebar / vscode-mode）
  if (method === 'cleanAux') {
    // 清理编译产物。白名单在 compile.js 里（AUX_EXTS），.tex / .pdf / .bib 一律不碰。
    // scope: 'log' 只清日志，'aux' 清全部可再生产物；默认 'aux'。
    const target = resolveWorkspacePath(ctx, relPath, sessionId)
    if (target.error) return { ok: false, error: target.error }
    const scope = args && args.scope === 'log' ? 'log' : 'aux'
    try {
      const listed = listArtifacts(target.abs, scope)
      const result = cleanArtifacts(target.abs, scope)
      return { ok: true, data: { ...result, scope, listed: listed.length } }
    } catch (error) {
      return { ok: false, error: '清理失败：' + msgOf(error) }
    }
  }
  if (method === 'fsList') {
    const root = workspaceRootOf(ctx, args && args.dir, sessionId)
    if (root.error) return { ok: false, error: root.error }
    try {
      const files = []
      collectDocs(root.abs, '', 0, files, DOC_MAX_FILES)
      // 诊断：多项目时到底选中了哪个目录、依据是什么，出问题一眼能看出来
      try {
        const cands = liveSessionsNewestFirst(ctx).map((s) => sessionCwdOf(ctx, s)).filter(Boolean)
        writeClientLog('info', '[fsList] 选中=' + root.abs +
          ' | 会话=' + (sessionId || '(未上报)') +
          ' | 侧边栏观察=' + (observedProjectRoot() || '(无)') +
          ' | 候选=' + cands.slice(0, 5).join(' , '))
      } catch { /* 诊断失败不影响功能 */ }
      return { ok: true, data: { root: root.abs, files } }
    } catch (error) {
      return { ok: false, error: '列目录失败：' + msgOf(error) }
    }
  }
  if (method === 'fsRead') {
    const target = resolveWorkspacePath(ctx, relPath, sessionId)
    if (target.error) return { ok: false, error: target.error }
    try {
      const st = statSync(target.abs)
      if (st.size > DOC_MAX_BYTES) {
        return { ok: false, error: '文件过大（' + Math.round(st.size / 1024) + 'KB > 8MB）' }
      }
      const text = readFileSync(target.abs, 'utf8')
      return { ok: true, data: { text, mtimeMs: st.mtimeMs, abs: target.abs, name: basename(target.abs) } }
    } catch (error) {
      return { ok: false, error: '读取文件失败：' + msgOf(error) }
    }
  }
  if (method === 'fsWrite') {
    const target = resolveWorkspacePath(ctx, relPath, sessionId)
    if (target.error) return { ok: false, error: target.error }
    const expect = args && args.expectedMtimeMs
    try {
      // mtime 冲突检测：外部（git / 别的编辑器）改过就不覆盖，交给用户决定
      const st = statSync(target.abs)
      if (typeof expect === 'number' && Math.abs(st.mtimeMs - expect) > 1) {
        return {
          ok: false,
          conflict: true,
          mtimeMs: st.mtimeMs,
          error: '文件已被其它程序修改（磁盘 mtime 与本地基线不一致），未写入',
        }
      }
      writeFileSync(target.abs, String((args && args.text) ?? ''), 'utf8')
      const after = statSync(target.abs)
      return { ok: true, data: { mtimeMs: after.mtimeMs } }
    } catch (error) {
      return { ok: false, error: '写入文件失败：' + msgOf(error) }
    }
  }
  // --endregion

  if (method !== 'compile' && method !== 'synctexView' && method !== 'synctexEdit'
    && method !== 'readVendor' && method !== 'readKatex' && method !== 'vscodeTheme'
    && method !== 'fsList' && method !== 'fsRead' && method !== 'fsWrite'
    && method !== 'cleanAux') {
    return { ok: false, error: '未知方法：' + String(method) }
  }
  if (method === 'vscodeTheme') {
    // 读本机 VSCode 的配色设定，为客户端要用到的 LaTeX scope 逐个求色。
    // 求值放在宿主，是因为客户端半是打包过的 CJS，不适合塞大段解析逻辑。
    try {
      const cfg = readConfig()
      if (cfg.followVscode === false) {
        return {
          ok: true,
          data: { ok: false, error: 'config.json 里 followVscode 为 false，改用内置色板' },
        }
      }
      const scopes = Array.isArray(args && args.scopes) ? args.scopes.slice(0, 400) : []
      const theme = (args && args.theme) || cfg.vscodeTheme || ''
      return { ok: true, data: readVscodeTheme(scopes, { forceTheme: theme }) }
    } catch (error) {
      return { ok: false, error: '读取 VSCode 主题失败：' + String(error && error.message ? error.message : error) }
    }
  }
  if (method === 'readVendor') {
    // 白名单式文件名，避免路径穿越；只暴露 vendor/katex 下的 .js
    const name = String((args && args.name) || '')
    if (!/^[a-zA-Z0-9._-]+\.js$/.test(name)) return { ok: false, error: '文件名不合法：' + name }
    try {
      const text = readFileSync(join(VENDOR_DIR, name), 'utf8')
      return { ok: true, data: { text, bytes: text.length } }
    } catch (error) {
      return { ok: false, error: '读取 vendor 失败：' + String(error && error.message ? error.message : error) }
    }
  }

  if (method === 'readKatex') {
    // 一次性把运行时 + 样式交出去，字体以 data URI 内联进 CSS：
    // 客户端不需要静态路由，也不依赖 font-src 是否放行外部文件。
    try {
      const js = readFileSync(join(VENDOR_DIR, 'katex.min.js'), 'utf8')
      let css = readFileSync(join(VENDOR_DIR, 'katex.min.css'), 'utf8')
      // 随包只带 woff2，先摘掉 woff / ttf 的备用引用，避免 404 回退
      css = css.replace(/,url\(fonts\/[^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '')
      const names = readdirSync(VENDOR_DIR).filter((n) => /\.woff2$/i.test(n))
      for (const name of names) {
        const base64 = readFileSync(join(VENDOR_DIR, name)).toString('base64')
        css = css.split('url(fonts/' + name + ')').join('url(data:font/woff2;base64,' + base64 + ')')
      }
      const leftover = (css.match(/url\(fonts\//g) || []).length
      return { ok: true, data: { js, css, fonts: names.length, leftover, cssBytes: css.length } }
    } catch (error) {
      return { ok: false, error: '读取 katex 失败：' + String(error && error.message ? error.message : error) }
    }
  }
  const resolved = resolveWorkspacePath(ctx, relPath, sessionId)
  if (resolved.error) return { ok: false, error: resolved.error }
  const abs = resolved.abs

  if (method === 'compile') {
    const result = await compile(abs)
    return { ok: true, data: { ...result, abs } }
  }

  if (method === 'synctexView') {
    // relPath 是光标所在文件（可能是被 \input 的子文件），pdfRel 是编译主文档。
    // 二者分开传，子文件里的光标才不会被当成主文件的同号行。
    let docAbs = abs
    if (args && args.pdfRel) {
      const doc = resolveWorkspacePath(ctx, args.pdfRel, sessionId)
      if (!doc.error) docAbs = doc.abs
    }
    const result = await synctexView(docAbs, Number(args.line) || 1, Number(args.column) || 1, abs)
    if (result.error) return { ok: false, error: result.error }
    return { ok: true, data: { ...result, pdfRel: toWorkspaceRelative(ctx, docAbs.replace(/\.tex$/i, '.pdf'), sessionId) } }
  }

  const result = await synctexEdit(abs, Number(args.page) || 1, Number(args.x) || 0, Number(args.y) || 0)
  if (result.error) return { ok: false, error: result.error }
  return { ok: true, data: { ...result, relPath: toWorkspaceRelative(ctx, result.file, sessionId) } }
}

/**
 * 客户端诊断日志落盘：`$DSH_HOME/dsh-dmzlatexworkshop/client.log`（默认 ~/.dsh）。
 * @param level 级别
 * @param text 内容
 */
function writeClientLog(level, text) {
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    const dir = join(home, 'dsh-dmzlatexworkshop')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const file = join(dir, 'client.log')
    if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) {
      try { renameSync(file, file + '.1') } catch { /* 轮转失败就继续追加 */ }
    }
    const line = new Date().toISOString() + ' [' + (level || 'info') + '] ' + String(text) + '\n'
    appendFileSync(file, line, 'utf8')
  } catch { /* 日志失败绝不影响业务 */ }
}

/**
 * 插件入口。
 * @param ctx DSH 宿主上下文
 */
/**
 * 给 `workspaceFiles` 服务套一层观察器（只读记录，不改任何行为）。
 *
 * 侧边栏文件树每次列目录、读文件都走宿主 `workspaceFiles` 服务，而它的第一个
 * 参数是 `{ sessionId, workspaceRoot }` —— `workspaceRoot` 取自 `session.header.cwd`，
 * 正是文件树顶上显示的那个根。顺手记下来，等于白捡一份「用户此刻在看哪个项目」
 * 的准确信号，不需要客户端配合、也不用猜哪个会话最近活跃。
 *
 * @param ctx DSH 上下文
 */
function watchWorkspaceFiles(ctx) {
  let service = null
  try { service = ctx.get('workspaceFiles') } catch { service = null }
  if (!service || service.__latexObserved) return
  // 侧边栏用 list；read/stat 是打开文件时走的，一并接上更稳
  for (const name of ['list', 'read', 'readBytes', 'stat', 'inspect']) {
    let original = null
    try { original = service[name] } catch { original = null }
    if (typeof original !== 'function') continue
    try {
      service[name] = function (scope, ...rest) {
        rememberObservedScope(scope)
        return original.apply(this, [scope, ...rest])
      }
    } catch { /* 方法不可写就跳过 */ }
  }
  try { service.__latexObserved = true } catch { /* 冻结对象也无妨 */ }
}

export function apply(ctx) {
  // 服务可能比插件晚就绪，挂个注入等它出现
  try { ctx.inject(['workspaceFiles'], (scope) => watchWorkspaceFiles(scope)) } catch { /* 老版本宿主没有这个服务 */ }

  const install = () => {
    const webServer = ctx.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('[dsh-dmzlatexworkshop] webServer 不可用，编译功能未挂载')
      return () => {}
    }
    const disposers = []

    // 诊断日志路由
    try {
      disposers.push(webServer.register({
        kind: 'exact',
        path: LOG_PATH,
        methods: ['POST'],
        handler: async (req, res) => {
          try {
            const body = await readJson(req)
            writeClientLog(body.level, body.text)
          } catch { /* 上报体不合法则忽略 */ }
          replyJson(res, 200, { ok: true })
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-dmzlatexworkshop] 日志路由注册失败：' + String(error))
    }

    // 自带静态资源路由（monaco / pdfjs / katex）。必须在 RPC 之前注册，
    // 但它用的是 prefix，与 exact 路由互不干扰。
    try {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: VENDOR_PATH,
        handler: async (req, res) => { serveVendor(req, res) },
      }))
    } catch (error) {
      ctx.logger?.warn?.('[dsh-dmzlatexworkshop] vendor 路由注册失败：' + String(error))
    }

    const disposeRpc = webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      methods: ['POST'],
      handler: async (req, res) => {
        const rejection = rejectionOf(ctx, req)
        if (rejection !== undefined) {
          const status = rejection === 401 || rejection === 403 ? rejection : 503
          replyJson(res, status, { ok: false, error: '宿主鉴权拒绝' })
          return
        }
        try {
          const body = await readJson(req)
          const result = await dispatch(ctx, body.method, body.args || {})
          replyJson(res, 200, result)
        } catch (error) {
          replyJson(res, 500, { ok: false, error: String(error && error.message ? error.message : error) })
        }
      },
    })
    disposers.push(disposeRpc)

    ctx.logger?.info?.('[dsh-dmzlatexworkshop] 已挂载 ' + RPC_PATH + ' / ' + LOG_PATH + ' / ' + VENDOR_PATH)
    return () => { disposers.forEach((fn) => { try { fn() } catch { /* 已释放 */ } }) }
  }
  ctx.effect(install, 'latex: rpc')
}
