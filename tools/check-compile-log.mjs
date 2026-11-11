/**
 * latexmk 输出落盘的单元测试（不需要装 TeX，纯函数级）。
 *
 * 为什么单独测这个：这份日志是给人和 AI 看「编译到底为什么没成」的唯一入口，
 * 写坏了不会有任何报错 —— 只会安静地缺一段信息，然后在真正排查时才发现没得看。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanArtifacts, compile, listArtifacts, synctexView, writeLatexmkLog } from '../lib/compile.js'

let failed = 0
function check(label, ok, extra) {
  console.log((ok ? '  PASS ' : '  FAIL ') + label + (extra === undefined ? '' : '  ' + extra))
  if (!ok) failed++
}

const dir = mkdtempSync(join(tmpdir(), 'dmzmk-'))
const file = join(dir, 'doc.latexmk.log')
const baseInfo = { texFile: 'doc.tex', code: 12, durationMs: 2087 }

console.log('[1] 正常写入')
{
  const out = 'Latexmk: This is Latexmk\nLatexmk: Missing input file x.toc\n'
  check('返回 true', writeLatexmkLog(file, baseInfo, out) === true)
  const text = readFileSync(file, 'utf8')
  check('文件存在', existsSync(file))
  check('含工具标识', text.includes('dsh-dmzlatexworkshop'), )
  check('含文档名', text.includes('doc.tex'))
  check('含退出码与成败判定', /退出码：12（失败）/.test(text), (text.match(/# 退出码：.*/) || [''])[0])
  check('含耗时', text.includes('2087ms'))
  check('提示了同目录 .log 的存在', text.includes('doc.log'))
  check('原文完整保留', text.includes('Latexmk: Missing input file x.toc'))
  check('头部用 # 注释（便于 grep -v "^#" 只看正文）',
    text.split('\n').filter((l) => l.startsWith('#')).length >= 6)
}

console.log('\n[2] 成功时也写（AI 需要看哪些文件被读过）')
{
  const f2 = join(dir, 'ok.latexmk.log')
  writeLatexmkLog(f2, { texFile: 'ok.tex', code: 0, durationMs: 555 }, 'Output written on ok.xdv (19 pages)\n')
  const text = readFileSync(f2, 'utf8')
  check('成功也落盘', existsSync(f2))
  check('标注为成功', /退出码：0（成功）/.test(text), (text.match(/# 退出码：.*/) || [''])[0])
  check('保留页数信息', text.includes('19 pages'))
}

console.log('\n[3] 超长输出截断')
{
  const f3 = join(dir, 'big.latexmk.log')
  const huge = ('A'.repeat(1000) + '\n').repeat(2000) // ~2MB
  check('写入返回 true', writeLatexmkLog(f3, baseInfo, huge) === true)
  const text = readFileSync(f3, 'utf8')
  check('总长度受控（< 600KB）', text.length < 600 * 1024, String(text.length))
  check('有截断说明', text.includes('中间省略'))
  check('保留了开头', text.includes('AAAAAAAA'))
  check('说明了原文长度', /全文共 \d+ 字符/.test(text),
    (text.match(/全文共 \d+ 字符/) || [''])[0])
}

console.log('\n[4] 边界')
{
  check('空输出不抛错', writeLatexmkLog(join(dir, 'e.log'), baseInfo, '') === true)
  const text = readFileSync(join(dir, 'e.log'), 'utf8')
  check('空输出仍带头部', /退出码：12/.test(text))
  // 目录不存在 → 返回 false 而不是抛错（诊断写不进去不该让编译失败）
  let threw = false
  let res = null
  try { res = writeLatexmkLog(join(dir, 'no-such-dir', 'x.log'), baseInfo, 'x') } catch { threw = true }
  check('目录不存在时不抛错', threw === false)
  check('目录不存在时返回 false', res === false, String(res))
}

console.log('\n[5] 清理产物：只删白名单，绝不碰 .tex / .pdf')
{
  const cdir = mkdtempSync(join(tmpdir(), 'dmzclean-'))
  const tex = join(cdir, 'doc.tex')
  // 造一整套产物 + 两个必须留下的文件 + 一个必须留下的陌生文件
  const aux = ['.aux', '.log', '.latexmk.log', '.fls', '.fdb_latexmk', '.out', '.toc', '.xdv', '.synctex.gz', '.bbl']
  writeFileSync(tex, '\\documentclass{article}', 'utf8')
  writeFileSync(join(cdir, 'doc.pdf'), 'PDF', 'utf8')
  writeFileSync(join(cdir, 'refs.bib'), 'BIB', 'utf8')
  writeFileSync(join(cdir, 'notes.txt'), 'KEEP', 'utf8')
  for (const ext of aux) writeFileSync(join(cdir, 'doc' + ext), 'x'.repeat(100), 'utf8')
  // 同目录另一个文档的产物也不能动
  writeFileSync(join(cdir, 'other.tex'), 'x', 'utf8')
  writeFileSync(join(cdir, 'other.latexmk.log'), 'OTHER', 'utf8')

  const listed = listArtifacts(tex, 'aux')
  check('列出全部 10 个产物', listed.length === aux.length, String(listed.length))
  check('清单不含 .tex', !listed.some((x) => x.name.endsWith('.tex')))
  check('清单不含 .pdf', !listed.some((x) => x.name.endsWith('.pdf')))
  check('清单含我们自己的 .latexmk.log', listed.some((x) => x.name === 'doc.latexmk.log'))

  const r = cleanArtifacts(tex, 'aux')
  check('删除数量正确', r.removed.length === aux.length, String(r.removed.length))
  check('没有失败项', r.failed.length === 0, JSON.stringify(r.failed))
  check('累计字节数合理', r.bytes === aux.length * 100, String(r.bytes))
  for (const ext of aux) {
    check('已删除 doc' + ext, !existsSync(join(cdir, 'doc' + ext)))
  }
  check('保留 .tex', existsSync(tex))
  check('保留 .pdf', existsSync(join(cdir, 'doc.pdf')))
  check('保留 .bib', existsSync(join(cdir, 'refs.bib')))
  check('保留陌生扩展名 .txt', existsSync(join(cdir, 'notes.txt')))
  check('没误删别的文档的日志', existsSync(join(cdir, 'other.latexmk.log')))

  console.log('\n[6] log 档只清日志')
  {
    writeFileSync(join(cdir, 'doc.aux'), 'x', 'utf8')
    writeFileSync(join(cdir, 'doc.log'), 'x', 'utf8')
    writeFileSync(join(cdir, 'doc.latexmk.log'), 'x', 'utf8')
    const logList = listArtifacts(tex, 'log').map((x) => x.name).sort()
    check('log 档只列两个日志', logList.length === 2, JSON.stringify(logList))
    check('含 .latexmk.log', logList.includes('doc.latexmk.log'))
    check('含 .log', logList.includes('doc.log'))
    const r2 = cleanArtifacts(tex, 'log')
    check('删了 2 个', r2.removed.length === 2, String(r2.removed.length))
    check('log 已删', !existsSync(join(cdir, 'doc.log')))
    check('latexmk.log 已删', !existsSync(join(cdir, 'doc.latexmk.log')))
    check('aux 档没被牵连', existsSync(join(cdir, 'doc.aux')))
  }

  console.log('\n[7] 重复清理是幂等的')
  {
    // 上一段为验证「log 档不牵连 aux」特意留了 doc.aux，先收干净
    cleanArtifacts(tex, 'aux')
    const again = cleanArtifacts(tex, 'aux')
    check('第二次清理无事可做', again.removed.length === 0, JSON.stringify(again.removed))
    check('不抛错', true)
    check('文档仍然完好', existsSync(tex) && existsSync(join(cdir, 'doc.pdf')))
  }

  rmSync(cdir, { recursive: true, force: true })
}

  console.log('\n[8] 正向搜索的真实坐标（有 TeX 才跑，没有就跳过）')
  await realForwardSearch()

rmSync(dir, { recursive: true, force: true })
console.log('\n完成' + (failed ? '（有失败项）' : '（全部通过）'))
process.exit(failed ? 1 : 0)

/**
 * 正向搜索的核心假设只有两条：
 *  1. `synctex view` 的 y 是「页左上原点」（和 `synctex edit` 输入同一套），
 *     若哪天理解反了，整段纵向会翻过来；
 *  2. 传子文件的相对路径能命中，否则多文件项目里从子文件发起会跳到主文件同号行。
 * 这两条都只能在真 TeX 上验。没装 TeX 的机器直接跳过，不算失败。
 */
async function realForwardSearch() {
  const has = (cmd) => {
    try {
      const r = spawnSync(cmd, ['-v'], { stdio: 'ignore' })
      return r.status === 0 || r.status === 1
    } catch { return false }
  }
  if (!has('synctex') || !has('latexmk')) {
    console.log('  SKIP 本机没有 synctex / latexmk，跳过真实坐标验证')
    return
  }
  const cwd = mkdtempSync(join(tmpdir(), 'dmzfwd-'))
  try {
    mkdirSync(join(cwd, 'sec'), { recursive: true })
    const lines = [
      '\\documentclass{article}',
      '\\usepackage[paperwidth=160mm,paperheight=200mm]{geometry}',
      '\\begin{document}',
      '\\section{First}',
      '\\input{sec/a.tex}',
      '\\newpage',
      '\\section{Second}',
      'SECOND PAGE MARKER',
      '\\end{document}',
    ]
    const mainPath = join(cwd, 'main.tex')
    const subPath = join(cwd, 'sec', 'a.tex')
    writeFileSync(mainPath, lines.join('\n') + '\n', 'utf8')
    writeFileSync(subPath, 'IN SUBFILE MARKER\n', 'utf8')

    const res = await compile(mainPath)
    check('真实编译成功', res.ok === true, JSON.stringify({ ok: res.ok, errors: res.errors }))
    if (!res.ok) return

    const second = await synctexView(mainPath, 8, 1)
    check('第二页的行落到第 2 页', second.page === 2, JSON.stringify(second))
    // 页高 200mm ≈ 567bp；左上原点时顶部内容 y 应该是「小的正数」
    check('y 是左上原点（顶部内容 y 小）', typeof second.y === 'number' && second.y > 0 && second.y < 200,
      String(second && second.y))

    const sub = await synctexView(mainPath, 1, 1, subPath)
    check('子文件的行能查到', sub.page === 1, JSON.stringify(sub))
    check('子文件落点在第 1 页上部', typeof sub.y === 'number' && sub.y > 0 && sub.y < 200, String(sub && sub.y))

    const viaPdf = await synctexView(mainPath.replace(/\.tex$/, '.pdf'), 8, 1)
    check('只给 .pdf 也能查（退回同名 .tex）', viaPdf.page === 2, JSON.stringify(viaPdf))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
