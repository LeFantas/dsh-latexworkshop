/**
 * 校验 LATEX_MONARCH 是否满足 Monaco 的规则约束。
 * 从 client.js 里抽出 S / CMD_RULES / LATEX_MONARCH 求值后逐条检查。
 *
 * 做的检查（都对应 Monaco monarchCompile 的真实限制）：
 *  1. 规则必须是 [正则, action] 二元组
 *  2. action 为对象时，token 必须是字符串 —— 数组会抛
 *     "a 'token' attribute must be of type string"
 *  3. action 为数组时，元素只能是字符串；数组形 action 无法携带 next
 *  4. next / switchTo 引用的状态必须存在
 *  5. 正则本身必须能被 RegExp 构造
 */
const fs = require('fs')
const path = require('path')

const file = path.join(process.argv[2] || path.join(__dirname, '..'), 'lib/client.js')
const src = fs.readFileSync(file, 'utf8')

const a = src.indexOf('    var S = {')
const b = src.indexOf('    function registerLatexLanguage')
if (a < 0 || b < 0) throw new Error('未找到 S / registerLatexLanguage 锚点')

const mod = new Function(src.slice(a, b) + '\nreturn { S: S, CMD_RULES: CMD_RULES, LATEX_MONARCH: LATEX_MONARCH, ALL_SCOPES: ALL_SCOPES };')()
const M = mod.LATEX_MONARCH
const TK = M.tokenizer
const states = Object.keys(TK)

const errors = []
const warns = []

function checkAction(stateName, idx, action, reSrc) {
  const where = stateName + '[' + idx + '] /' + String(reSrc).slice(0, 50) + '/'

  if (typeof action === 'string') return
  if (Array.isArray(action)) {
    // 数组形：Monaco 逐个 compileToken，只能接受字符串；返回 { group } 且丢弃 next
    for (let i = 0; i < action.length; i++) {
      const el = action[i]
      if (typeof el !== 'string') {
        errors.push(where + ' 数组形 action 第 ' + i + ' 项不是字符串（' + typeof el + '）：Monaco 会抛错')
      }
    }
    return
  }
  if (!action || typeof action !== 'object') {
    errors.push(where + ' action 类型非法：' + typeof action)
    return
  }

  const hasToken = Object.prototype.hasOwnProperty.call(action, 'token')
  if (hasToken && typeof action.token !== 'string') {
    errors.push(where + ' 对象形 action 的 token 不是字符串（' + (Array.isArray(action.token) ? '数组' : typeof action.token) + '）：Monaco 会抛 "a \'token\' attribute must be of type string"')
  }
  // token 里出现 $ 会触发 tokenSubst，只有 $1..$n 才有意义
  if (typeof action.token === 'string' && action.token.indexOf('$') >= 0) {
    warns.push(where + ' token 含 $，会走 $n 替换：' + action.token)
  }
  for (const key of ['next', 'switchTo']) {
    if (action[key] === undefined) continue
    const t = action[key]
    if (typeof t !== 'string') { errors.push(where + ' ' + key + ' 不是字符串'); continue }
    if (t === '@pop' || t === '@push' || t === '@popall') continue
    const name = t.replace(/^@/, '')
    if (!states.includes(name)) errors.push(where + ' ' + key + ' 指向不存在的状态：' + t)
  }
  if (!hasToken && action.next === undefined && action.switchTo === undefined
    && action.cases === undefined && action.include === undefined) {
    warns.push(where + ' action 既无 token 也无 next，可能是无效规则')
  }
}

for (const st of states) {
  const rules = TK[st]
  if (!Array.isArray(rules)) { errors.push(st + ' 不是数组'); continue }
  rules.forEach((rule, i) => {
    if (!Array.isArray(rule)) { errors.push(st + '[' + i + '] 规则不是数组'); return }
    const re = rule[0]
    if (!(re instanceof RegExp)) { errors.push(st + '[' + i + '] 第 0 项不是 RegExp'); return }
    try { new RegExp(re.source) } catch (e) { errors.push(st + '[' + i + '] 正则无法构造：' + e.message) }
    checkAction(st, i, rule[1], re.source)
  })
}

// brackets 里用到的 token 应当能在主题里解析
const bracketTokens = (M.brackets || []).map(x => x.token)
if (bracketTokens.some(t => typeof t !== 'string')) errors.push('brackets 里存在非字符串 token')

console.log('状态：' + states.join(', '))
console.log('规则总数：' + states.reduce((n, s) => n + TK[s].length, 0))
console.log('bracket token：' + bracketTokens.join(' | '))
console.log('')
if (warns.length) {
  console.log('警告 ' + warns.length + ' 条：')
  warns.forEach(w => console.log('  ! ' + w))
  console.log('')
}
if (errors.length) {
  console.log('错误 ' + errors.length + ' 条：')
  errors.forEach(e => console.log('  x ' + e))
  process.exit(1)
}
console.log('校验通过：所有 action 形态与状态跳转都合法')
