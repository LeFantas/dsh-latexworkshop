/**
 * dsh-dmzlatexworkshop — 读取 VSCode 配色设定
 *
 * 目标：让编辑器里的 LaTeX 配色与用户 VSCode 里看到的一致，
 * 而不是用 DSH 皮肤里那套与 LaTeX 无关的通用色板。
 *
 * 做的事：
 *  1. 定位 VSCode 安装目录（新版把 app 放在哈希子目录里，两种布局都要兼容）
 *  2. 从 %APPDATA%/Code/User/settings.json 读 workbench.colorTheme
 *  3. 在内置扩展与用户扩展的 contributes.themes 里找到该主题的文件路径
 *  4. 递归展开 include 链，合并 tokenColors
 *  5. 对给定的 scope 列表逐个求「最具体匹配」的颜色（TextMate 的规则），
 *     并把结果一并返回
 *
 * 求值放在宿主侧做，是因为客户端半是打包过的 CJS，不适合塞进大段解析逻辑；
 * 而且同一份主题会被反复用到，宿主侧可以按 mtime 缓存。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'

/** 主题解析结果缓存（按主题文件 + mtime）。 */
let cache = { key: '', value: null }

/**
 * 去掉 JSONC 的注释与尾逗号后解析。
 * 用状态机而不是正则，避免误伤字符串里的 `//`（路径与 URL 里很常见）。
 * @param text 原文
 * @returns 解析后的对象
 */
export function parseJsonc(text) {
  const src = String(text).replace(/^\uFEFF/, '')
  let out = ''
  let inStr = false
  let esc = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i++
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

/**
 * 列出所有可能的 VSCode 安装根目录。
 * @returns 存在的根目录列表（可能为空）
 */
function vscodeRoots() {
  const out = []
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const cands = [
    local && join(local, 'Programs', 'Microsoft VS Code'),
    local && join(local, 'Programs', 'Microsoft VS Code Insiders'),
    join(pf, 'Microsoft VS Code'),
    join(pf86, 'Microsoft VS Code'),
  ].filter(Boolean)
  for (const c of cands) {
    try { if (statSync(c).isDirectory()) out.push(c) } catch (error) { /* 不存在 */ }
  }
  return out
}

/**
 * 在安装根目录下找内置扩展目录。
 * 旧布局是 `<root>/resources/app/extensions`，
 * 新布局是 `<root>/<hash>/resources/app/extensions`（哈希随版本变化）。
 * @param root 安装根目录
 * @returns 扩展目录路径，找不到返回 null
 */
function builtinExtensionsDir(root) {
  const direct = join(root, 'resources', 'app', 'extensions')
  if (existsSync(direct)) return direct
  let entries = []
  try { entries = readdirSync(root, { withFileTypes: true }) } catch (error) { return null }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const p = join(root, e.name, 'resources', 'app', 'extensions')
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 读取 VSCode 用户设置里的主题名。
 * @returns 主题名，读不到返回空串
 */
function userThemeName() {
  const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const files = [
    join(appData, 'Code', 'User', 'settings.json'),
    join(appData, 'Code - Insiders', 'User', 'settings.json'),
  ]
  for (const f of files) {
    if (!existsSync(f)) continue
    try {
      const j = parseJsonc(readFileSync(f, 'utf8'))
      const name = j['workbench.colorTheme']
      if (typeof name === 'string' && name) return { name, file: f }
    } catch (error) { /* 设置文件坏了就换下一个 */ }
  }
  return { name: '', file: '' }
}

/**
 * 读扩展的本地化文案。
 * VSCode 内置主题的 label 是 `%lightModernThemeLabel%` 这种占位符，
 * 真实名字在 package.nls.json（以及各语言包）里，必须展开才能对上设置里的主题名。
 * @param extDir 扩展目录
 * @returns 占位符 → 文本
 */
function nlsTable(extDir) {
  const out = {}
  const files = ['package.nls.json', 'package.nls.zh-cn.json', 'package.nls.zh-hans.json', 'package.nls.zh-tw.json']
  for (const f of files) {
    const p = join(extDir, f)
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'))
      for (const k of Object.keys(j)) {
        if (typeof j[k] === 'string' && !(k in out)) out[k] = j[k]
      }
    } catch (error) { /* 语言包坏了跳过 */ }
  }
  return out
}

/** 展开 `%key%`，展开不了就返回空串。 */
function expandLabel(raw, nls) {
  const text = String(raw || '').trim()
  if (!text) return ''
  const m = /^%(.*)%$/.exec(text)
  if (!m) return text
  return nls[m[1]] || ''
}

/**
 * 在扩展目录集合里按主题名找主题文件。
 * 一个主题可能有多重身份：id、英文 label、本地化 label，三者都算匹配。
 * @param dirs 扩展根目录列表
 * @param name 设置里写的主题名
 * @returns 主题文件路径，或 { missing, fallback }
 */
function findThemeFile(dirs, name) {
  const want = String(name).trim().toLowerCase()
  const fallback = []
  for (const dir of dirs) {
    let subs = []
    try { subs = readdirSync(dir, { withFileTypes: true }) } catch (error) { continue }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const extDir = join(dir, sub.name)
      const pkgFile = join(extDir, 'package.json')
      if (!existsSync(pkgFile)) continue
      let pkg
      try { pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) } catch (error) { continue }
      const themes = pkg && pkg.contributes && pkg.contributes.themes
      if (!Array.isArray(themes)) continue
      const nls = nlsTable(extDir)
      for (const t of themes) {
        if (!t || !t.path) continue
        const file = resolvePath(extDir, t.path)
        if (!existsSync(file)) continue
        const names = [
          String(t.id || '').trim(),
          expandLabel(t.label, nls),
          String(t.label || '').indexOf('%') === 0 ? '' : String(t.label || ''),
        ].filter(Boolean)
        const display = expandLabel(t.label, nls) || String(t.id || '')
        for (const n of names) {
          if (n.trim().toLowerCase() === want) return file
        }
        fallback.push({ file, ui: String(t.uiTheme || ''), label: display })
      }
    }
  }
  return { missing: true, fallback }
}

/**
 * 递归展开主题的 include 链。
 * VSCode 的语义：子主题的 colors 覆盖父主题，tokenColors 追加在后（后面的规则优先）。
 * @param file 主题文件
 * @param depth 递归深度
 * @returns 合并后的主题
 */
function loadTheme(file, depth) {
  const raw = parseJsonc(readFileSync(file, 'utf8'))
  const merged = {
    name: raw.name || '',
    type: raw.type || '',
    colors: {},
    tokenColors: [],
    files: [file],
  }
  if (raw.include && (depth || 0) < 8) {
    const inc = resolvePath(dirname(file), raw.include)
    if (existsSync(inc)) {
      const parent = loadTheme(inc, (depth || 0) + 1)
      merged.colors = parent.colors
      merged.tokenColors = parent.tokenColors
      merged.files = parent.files.concat(file)
      if (!merged.type) merged.type = parent.type
    }
  }
  if (raw.colors) merged.colors = Object.assign({}, merged.colors, raw.colors)
  let tc = raw.tokenColors
  if (typeof tc === 'string') {
    // 少数主题把 tokenColors 放进独立文件
    const p = resolvePath(dirname(file), tc)
    try {
      const sub = parseJsonc(readFileSync(p, 'utf8'))
      tc = Array.isArray(sub) ? sub : (sub.tokenColors || [])
    } catch (error) { tc = [] }
  }
  if (Array.isArray(tc)) merged.tokenColors = merged.tokenColors.concat(tc)
  return merged
}

/**
 * 把 tokenColors 展开成「单 scope → 样式」的规则表。
 * 原文里 scope 可以是字符串、数组，字符串里还能用逗号分隔。
 *
 * 带空格的 scope 是后代选择器（如 `source.css variable`），
 * VSCode 判断的是「整条 scope 栈」里有没有这个祖先；Monaco 的 token 只有单条链，
 * 表达不了上下文。这类规则必须**丢弃**而不是取最后一段——实测取最后一段会让
 * `source.css variable` 抢走通用的 `variable` 规则，把 LaTeX 的环境名染成红色。
 * @param tokenColors 原始 tokenColors
 * @returns 规则数组
 */
function flattenRules(tokenColors) {
  const out = []
  for (const entry of tokenColors) {
    if (!entry || !entry.settings) continue
    const scopes = entry.scope === undefined ? [''] : [].concat(entry.scope)
    const st = entry.settings
    for (const raw of scopes) {
      // 没有 scope 的条目就是主题的默认文字样式，必须保留：
      // 它决定正文文字色（Light Modern 是 #3B3B3B，而 vs 内置是纯黑）。
      if (!String(raw).trim()) {
        out.push({ scope: '', fg: st.foreground, fontStyle: st.fontStyle })
        continue
      }
      for (const piece of String(raw).split(',')) {
        const clean = piece.trim()
        if (!clean) continue
        if (/\s/.test(clean)) continue // 后代选择器，无法表达，丢掉
        out.push({
          scope: clean,
          fg: st.foreground,
          fontStyle: st.fontStyle,
        })
      }
    }
  }
  return out
}

/** 归一化颜色：去 #、截到 6 位、大写。无效返回 null。 */
function normColor(value) {
  if (typeof value !== 'string') return null
  const hex = value.replace('#', '').trim()
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(hex)) return null
  return hex.slice(0, 6).toUpperCase()
}

/**
 * 为某个 scope 求最终样式：选「匹配段数最多」的规则，并列时取靠后的。
 * 这与 TextMate / VSCode 的评分基本一致（越具体的 scope 越优先）。
 * @param rules 规则表
 * @param scope 目标 scope，如 keyword.control.preamble.latex
 * @returns {fg, fontStyle, matched} 或 null
 */
function resolveScope(rules, scope) {
  const parts = scope.split('.')
  let best = null
  let bestScore = -1
  for (const rule of rules) {
    const target = rule.scope
    if (!target) continue
    const tp = target.split('.')
    if (tp.length > parts.length) continue
    let ok = true
    for (let i = 0; i < tp.length; i++) {
      if (tp[i] !== parts[i]) { ok = false; break }
    }
    if (!ok) continue
    const score = tp.length
    // 并列取靠后：后面的规则覆盖前面的
    if (score >= bestScore) { bestScore = score; best = rule }
  }
  if (!best) return null
  return {
    fg: normColor(best.fg),
    fontStyle: typeof best.fontStyle === 'string' ? best.fontStyle : '',
    matched: best.scope,
  }
}

/**
 * 求某个 scope 的样式，必要时按语义回退。
 *
 * 大多数主题不会给 `punctuation.definition.*` 单独定色，于是定界符会落到默认前景，
 * 公式的 `$`、注释的 `%` 就完全看不出来了。这类 token 的语义由它包裹的内容决定，
 * 所以退回同名宿主类：`punctuation.definition.string.*` → `string`，`comment` 同理。
 * @param rules 规则表
 * @param scope 目标 scope
 * @returns 样式对象或 null
 */
function resolveWithFallback(rules, scope) {
  const direct = resolveScope(rules, scope)
  if (direct && (normColor(direct.fg) || direct.fontStyle)) return direct
  const m = /^punctuation\.definition\.([a-z]+)\./.exec(scope)
  if (m) {
    const alt = resolveScope(rules, m[1])
    if (alt && (normColor(alt.fg) || alt.fontStyle)) {
      return { fg: normColor(alt.fg), fontStyle: alt.fontStyle || '', matched: alt.matched + '（语义回退）' }
    }
  }
  return direct
}

/** 由背景色亮度推断明暗。 */
function schemeOf(theme) {
  if (theme.type === 'light' || theme.type === 'dark') return theme.type
  const bg = normColor(theme.colors['editor.background'])
  if (!bg) return 'unknown'
  const r = parseInt(bg.slice(0, 2), 16)
  const g = parseInt(bg.slice(2, 4), 16)
  const b = parseInt(bg.slice(4, 6), 16)
  // 相对亮度近似
  return (0.299 * r + 0.587 * g + 0.114 * b) > 140 ? 'light' : 'dark'
}

/** 只挑与代码区外观相关、且不会与宿主 UI 打架的 colors 键。 */
const COLOR_KEYS = [
  'editor.background',
  'editor.foreground',
  'editor.lineHighlightBackground',
  'editor.selectionBackground',
  'editor.selectionHighlightBackground',
  'editorCursor.foreground',
  'editorLineNumber.foreground',
  'editorLineNumber.activeForeground',
  'editorIndentGuide.background',
  'editorWhitespace.foreground',
  'editorBracketHighlight.foreground1',
  'editorBracketHighlight.foreground2',
  'editorBracketHighlight.foreground3',
  'editorBracketHighlight.foreground4',
  'editorBracketHighlight.foreground5',
  'editorBracketHighlight.foreground6',
  'editorBracketPairGuide.background1',
  'editorBracketPairGuide.background2',
]

/**
 * 主入口：读取 VSCode 主题并为指定 scope 求色。
 * @param scopes 客户端要用到的 scope 名数组
 * @param options.forceTheme 强制指定主题名（覆盖 settings.json）
 * @returns 结果对象
 */
export function readVscodeTheme(scopes, options) {
  const opts = options || {}
  const roots = vscodeRoots()
  const extDirs = []
  for (const r of roots) {
    const d = builtinExtensionsDir(r)
    if (d) extDirs.push(d)
  }
  // 用户安装的扩展（自定义主题大多在这）
  const userExt = join(homedir(), '.vscode', 'extensions')
  if (existsSync(userExt)) extDirs.push(userExt)
  const insidersExt = join(homedir(), '.vscode-insiders', 'extensions')
  if (existsSync(insidersExt)) extDirs.push(insidersExt)

  const wanted = String(opts.forceTheme || '').trim() || userThemeName().name
  if (!wanted) {
    return {
      ok: false,
      error: 'VSCode 用户设置里没有 workbench.colorTheme',
      roots,
      extDirs: extDirs.length,
    }
  }
  if (!extDirs.length) {
    return { ok: false, error: '未找到 VSCode 扩展目录（VSCode 可能没装在本机）', roots }
  }

  let found = findThemeFile(extDirs, wanted)
  let usedName = wanted
  if (found && found.missing) {
    // 主题名对不上：按明暗挑一个默认现代主题兜底
    const pick = (found.fallback || []).find((t) => /modern/i.test(t.label))
      || (found.fallback || [])[0]
    if (!pick) {
      return {
        ok: false,
        error: '找不到主题「' + wanted + '」',
        available: (found.fallback || []).map((t) => t.label).slice(0, 20),
      }
    }
    found = pick.file
    usedName = pick.label || wanted
  }
  if (!found) return { ok: false, error: '主题解析失败：' + wanted }

  let key = found
  try { key += '|' + statSync(found).mtimeMs } catch (error) { /* 用路径即可 */ }
  const list = Array.isArray(scopes) ? scopes : []
  const cacheKey = key + '|' + list.join(',')
  if (cache.value && cache.key === cacheKey) return cache.value

  let theme
  try {
    theme = loadTheme(found, 0)
  } catch (error) {
    return { ok: false, error: '主题文件解析失败：' + String(error && error.message ? error.message : error) }
  }

  const rules = flattenRules(theme.tokenColors)
  const out = {}
  for (const s of list) {
    const r = resolveWithFallback(rules, String(s))
    if (r && (r.fg || r.fontStyle)) out[s] = r
  }

  const colors = {}
  for (const k of COLOR_KEYS) {
    const v = theme.colors[k]
    if (v) colors[k] = v
  }

  // 全量规则：让其它语言也保持 VSCode 的配色，否则切换主题后
  // JS/Python 会退回 Monaco 内置色板，与 LaTeX 的观感割裂。
  const allRules = []
  for (const r of rules) {
    const fg = normColor(r.fg)
    const fs = typeof r.fontStyle === 'string' ? r.fontStyle.trim() : ''
    if (!fg && !fs) continue
    allRules.push({ token: r.scope || '', foreground: fg || '', fontStyle: fs })
  }

  const result = {
    ok: true,
    name: theme.name || usedName,
    requested: wanted,
    type: schemeOf(theme),
    files: theme.files,
    ruleCount: rules.length,
    scopeCount: list.length,
    matched: Object.keys(out).length,
    scopes: out,
    rules: allRules,
    colors,
    // 背景/前景供客户端判断能否整体套用
    background: normColor(theme.colors['editor.background']) || '',
    foreground: normColor(theme.colors['editor.foreground']) || '',
  }
  cache = { key: cacheKey, value: result }
  return result
}
