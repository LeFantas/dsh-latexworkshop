/**
 * dsh-dmzlatexworkshop client half v1.0.0
 *
 * 编辑器内的本地 LaTeX 编译与 PDF 预览，全程不经过模型：
 * 按键 → 宿主 spawn latexmk → pdf.js 画 canvas → Ctrl+点击 PDF 跳回源码。
 *
 * 四块职责：
 *  1. 编译：POST /latex/rpc { compile }，宿主执行
 *     `latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error`。
 *  2. 预览：自建 canvas 渲染，不用 vscode-mode 的 PDFViewer
 *     （它在本机 promise 永久 pending，原因见 DEVELOPMENT.md）。
 *     字节走宿主 readPdf 的 base64，以 { data } 交给 pdf.js，绕开 URL 与 CSP。
 *  3. 停靠：压缩 `.edrv-editor-area` 宽度让出右侧空间，形成分栏而非浮层。
 *  4. 反向搜索：Ctrl+点击 PDF → `synctex edit` → 打开源码行。
 *
 * 依赖的接缝：__edrvCommands__ / edrv:open-editor / edrv:status，
 * 以及自带的 vendor 目录（/dmzlatex/vendor/pdfjs）。
 */
window.__ModuleLoader__ && window.__ModuleLoader__.load({
  id: 'dsh-dmzlatexworkshop',
  factory: function (require) {
    var exports = {}

    var RPC_PATH = '/latex/rpc'
    var LOG_PATH = '/latex/log'
    var PDF_VENDOR = '/dmzlatex/vendor/pdfjs'
    var VERSION = '1.0.0'

    var state = {
      tex: null,
      busy: false,
      commandReady: false,
      buttons: 0,
      // 工作台已打开的标签：{ relPath, abs, name, mtimeMs, dirty, model, viewState }
      // 每个标签一个 Monaco model，切走再切回光标/撤销栈都还在。
      wbTabs: [],
      // 当前激活的标签。旧代码大量引用 state.wbFile，保留这个别名，
      // 让 currentTex / 诊断 / 保存等既有链路一行不用改。
      wbFile: null,
      // 工作台所在会话的 id。由右侧栏页签的 slot props 带进来
      // （DSH 的 `sidebar.right.pane.tab` 是 session 作用域的），
      // 随后每次 RPC 都上报给宿主，宿主据此定位「当前项目」。
      // 浮层工作台拿不到 props，复用上一次记下的值。
      sessionId: null,
      // 这个会话的项目根（由宿主解析后回传，仅用于展示与诊断）
      projectRoot: null,
    }

    // --region 基础工具

    function appUrl(path) {
      try {
        var base = (typeof document !== 'undefined' && document.baseURI) || location.href
        return new URL(String(path).replace(/^\/+/, ''), new URL('.', base)).href
      } catch (error) {
        return path
      }
    }

    /** 上报到宿主日志文件（失败静默，绝不二次抛错）。 */
    function report(level, text) {
      try { console.log('[dsh-dmzlatexworkshop] ' + text) } catch (error) { /* 控制台不可用 */ }
      try {
        fetch(appUrl(LOG_PATH), {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ level: level || 'info', text: String(text) }),
        }).catch(function () {})
      } catch (error) { /* 上报失败不影响功能 */ }
    }

    function status(text) {
      try {
        window.dispatchEvent(new CustomEvent('edrv:status', { detail: { text: String(text) } }))
      } catch (error) { /* 状态栏缺失 */ }
    }

    function baseName(p) {
      var parts = String(p || '').split(/[\\/]/)
      return parts[parts.length - 1] || String(p || '')
    }

    function errText(error) {
      if (!error) return '未知错误'
      if (error.name && error.message) return error.name + ': ' + error.message
      return String(error.message || error)
    }

    /**
     * 从 DOM 现读当前会话 id。
     *
     * DSH 把右侧栏渲染在 `[data-sidebar-right-session]` 容器里（见
     * `dsh-client-ui-sidebar-right`），属性值就是会话 id。我们的工作台挂在这个容器
     * 里面，所以向上找一层就能拿到——**每次现读**，切会话立刻跟着变，不依赖任何
     * 组件重挂载或 props 注入。
     *
     * @returns 会话 id，或 null
     */
    function sessionIdFromDom() {
      try {
        var node = embed && embed.hostEl
        if (!node || typeof node.closest !== 'function') return null
        var owner = node.closest('[data-sidebar-right-session]')
        var id = owner && owner.dataset ? owner.dataset.sidebarRightSession : null
        return id || null
      } catch (error) {
        return null
      }
    }

    function rpc(method, args) {
      // 带上会话 id：宿主要靠它认出「当前项目」。
      // 浅拷贝而不是改调用方的对象——那些 args 有的来自 state，不该被污染。
      var payload = {}
      var src = args || {}
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) payload[k] = src[k]
      }
      var sid = sessionIdFromDom() || state.sessionId
      if (sid && !payload.sessionId) payload.sessionId = sid
      return fetch(appUrl(RPC_PATH), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: method, args: payload }),
      }).then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
    }

    function currentTex() {
      // 工作台自己打开了文件时以它为准：否则会和 vscode-mode 的页签抢「编译哪个」
      if (state.wbFile && state.wbFile.relPath) {
        // 激活的是 md/bib 时不能就拿它去编译 —— latexmk 会立刻 Emergency stop。
        // 退回「最近打开的那个 tex 标签」，一个都没有就返回 null（调用方会提示）。
        if (isTexPath(state.wbFile.relPath)) return state.wbFile.relPath
        for (var t = state.wbTabs.length - 1; t >= 0; t--) {
          if (isTexPath(state.wbTabs[t].relPath)) {
            if (state.wbTabs[t].relPath !== state.wbFile.relPath) {
              report('info', '当前是「' + state.wbFile.name + '」，编译目标改用 ' + state.wbTabs[t].name)
            }
            return state.wbTabs[t].relPath
          }
        }
        return null
      }
      try {
        var tabs = document.querySelectorAll('.edrv-tab-active[data-edrv-tab-path]')
        for (var i = tabs.length - 1; i >= 0; i--) {
          var p = tabs[i].getAttribute('data-edrv-tab-path')
          if (p && /\.tex$/i.test(p)) return p
        }
      } catch (error) { /* 退回缓存 */ }
      return state.tex
    }

    function trackNavigation() {
      window.addEventListener('edrv:open-editor', function (event) {
        var p = event && event.detail ? event.detail.path : null
        if (typeof p === 'string' && /\.tex$/i.test(p)) state.tex = p
      })
    }

    function base64ToBytes(base64) {
      var binary = atob(base64)
      var bytes = new Uint8Array(binary.length)
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes
    }

    // --endregion

    // --region 编译

    function compileNow() {
      var tex = currentTex()
      if (!tex) {
        status(state.wbFile
          ? 'LaTeX：「' + state.wbFile.name + '」不是 .tex，也没有其它 tex 标签可编译'
          : 'LaTeX：请先在编辑器里打开要编译的 .tex 文件')
        return Promise.resolve()
      }
      if (state.busy) { status('LaTeX：正在编译中…'); return Promise.resolve() }
      state.busy = true
      // 先把内存里的改动写进磁盘再编译：否则编的是旧文件，屏幕上却以为编的是新内容。
      // 这个坑不报任何错，只是「预览不跟随改动」，最难查。
      return saveAllDirtyBeforeCompile()
        .then(function (saved) {
          if (!saved) {
            status('LaTeX：有文件没能保存，已中止编译')
            report('error', '编译中止：存在未能保存的文件')
            return null
          }
          return doCompile(tex)
        })
        .catch(function (error) {
          var msg = 'LaTeX 编译异常：' + errText(error)
          status(msg); report('error', msg)
          if (panel.el) markPreviewStale(tex, [], errText(error))
          else showFailureCard(tex, [], errText(error))
        })
        .then(function () { state.busy = false })
    }

    /** 真正发起编译（保存已在 compileNow 里完成）。 */
    function doCompile(tex) {
      status('LaTeX：正在编译 ' + baseName(tex) + ' …')
      report('info', 'v' + VERSION + ' compile 开始：' + tex)
      if (panel.metaEl) panel.metaEl.textContent = '编译中…'
      return rpc('compile', { relPath: tex })
        .then(function (res) {
          if (!res || res.ok !== true) {
            var msg = 'LaTeX 编译失败：' + ((res && res.error) || '宿主无响应')
            status(msg); report('error', msg)
            // 宿主都没回话，PDF 当然还是旧的：同样要标出来
            markPreviewStale(tex, [], (res && res.error) || '宿主无响应')
            return null
          }
          var data = res.data || {}
          if (data.ok) {
            var text = '✓ 编译成功 · ' + (data.pages || '?') + ' 页 · ' + data.durationMs + 'ms'
            if (data.warnings && data.warnings.length) text += ' · ' + data.warnings.length + ' 条警告'
            status(text); report('info', text)
            recordCompileDiagnostics(tex, [])
            clearPreviewStale()
            clearFailureCard()
            // 用 tex 路径推导 PDF 相对路径（compile 返回的 pdf 只是文件名，丢了目录）
            var pdfRel = tex.replace(/\.tex$/i, '.pdf')
            void openPdf(pdfRel)
            return null
          }
          if (data.fatal) {
            status('✗ ' + data.fatal); report('error', data.fatal)
            recordCompileDiagnostics(tex, [])
            // fatal 通常是 latexmk 压根没跑起来（缺引擎、缺文件）：
            // 此时磁盘上的 PDF 未必存在，面板也就未必在，两种情况都要交代
            var fatalExtra = { tail: data.tail, latexmkLog: data.latexmkLog }
            if (panel.el) markPreviewStale(tex, [], data.fatal, fatalExtra)
            else showFailureCard(tex, [], data.fatal, fatalExtra)
            return null
          }
          recordCompileDiagnostics(tex, data.errors || [])
          var first = data.errors && data.errors.length ? data.errors[0] : null
          var where = first && first.file ? first.file + ':' + first.line + ' ' : ''
          var line = '✗ 编译失败 · ' + where + ((first && first.message) || '见日志')
          status(line); report('error', line)
          if (data.errors) data.errors.slice(0, 10).forEach(function (e) {
            report('error', '  ' + (e.file || '?') + ':' + e.line + ' ' + e.message)
          })
          // 有面板就把旧 PDF 标成陈旧；没有面板（首次编译即失败）就铺错误卡片
          var failExtra = { tail: data.tail, latexmkLog: data.latexmkLog }
          if (panel.el) markPreviewStale(tex, data.errors || [], null, failExtra)
          else showFailureCard(tex, data.errors || [], null, failExtra)
          return null
        })
        .catch(function (error) {
          var msg = 'LaTeX 编译异常：' + errText(error)
          status(msg); report('error', msg)
          if (panel.el) markPreviewStale(tex, [], errText(error))
          else showFailureCard(tex, [], errText(error))
        })
    }

    // --endregion

    // --region 清理编译产物

    /** 人类可读的字节数。 */
    function humanSize(bytes) {
      var n = Number(bytes) || 0
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / 1024 / 1024).toFixed(1) + ' MB'
    }

    /**
     * 清理当前文档的编译产物（白名单在宿主侧，见 compile.js 的 AUX_EXTS）。
     *
     * 存在理由：`latexmk -C` 不认识我们写的 `.latexmk.log`，跑完会留一个孤儿。
     * 与其让你记着手动 rm，不如给个命令一起收拾。
     *
     * 不删 `.tex` / `.pdf`：前者是源，后者是成品，清理功能误删它们不可接受，
     * 所以走固定扩展名白名单而不是通配符。
     *
     * @param scope 'aux' 清全部可再生产物；'log' 只清日志
     */
    function cleanArtifactsNow(scope) {
      var tex = currentTex()
      if (!tex) { status('LaTeX：没有可清理的文档'); return Promise.resolve() }
      var what = scope === 'log' ? '日志' : '编译产物'
      status('LaTeX：正在清理 ' + baseName(tex) + ' 的' + what + '…')
      return rpc('cleanAux', { relPath: tex, scope: scope })
        .then(function (res) {
          if (!res || res.ok !== true) {
            var msg = 'LaTeX 清理失败：' + ((res && res.error) || '宿主无响应')
            status(msg); report('error', msg)
            return
          }
          var d = res.data || {}
          var removed = d.removed || []
          if (!removed.length) {
            status('LaTeX：没有 ' + what + '需要清理')
            report('info', '清理 ' + scope + '：' + tex + ' 无产物')
            return
          }
          var text = '✓ 已清理 ' + removed.length + ' 个' + what + ' · ' + humanSize(d.bytes)
          if (d.failed && d.failed.length) text += ' · ' + d.failed.length + ' 个失败（可能被占用）'
          status(text)
          report('info', '清理 ' + scope + '：' + removed.join(', ') + '（' + d.bytes + ' 字节）')
          // 删掉了 PDF 旁边的 aux 后，预览里那份 PDF 还是有效的（没删 .pdf），
          // 但「陈旧」标记的依据是 PDF 的 mtime，清理不影响它，保持原状即可。
          if (d.failed && d.failed.length) {
            report('warn', '未能删除：' + d.failed.join(', '))
          }
        })
        .catch(function (error) {
          status('LaTeX 清理异常：' + errText(error))
          report('error', '清理异常：' + errText(error))
        })
    }

    // --endregion

    // --region pdf.js 载入（只取 lib，不用它的 PDFViewer）

    var pdfLibPromise = null

    /**
     * 加载 pdf.js 的 lib 命名空间。
     *
     * 不用 `import()`：本客户端包是 CJS，打包器会改写动态 import 破坏 URL 语义
     * （vscode-mode 的 pdfLoader 注释里明确记过这个坑）。这里注入 inline
     * `<script type="module">`，让浏览器原生解析静态 import，结果挂到
     * `window.__dshLatexPdfLib` 再交接。
     */
    function loadPdfLib() {
      if (pdfLibPromise) return pdfLibPromise
      var base = appUrl(PDF_VENDOR)

      function adopt(lib) {
        try {
          if (lib && lib.GlobalWorkerOptions) {
            lib.GlobalWorkerOptions.workerSrc = base + '/build/pdf.worker.mjs'
          }
        } catch (error) { /* worker 配置失败留给 getDocument 报错 */ }
        return lib
      }

      var existing = null
      try { existing = window.__edrvPdfjs } catch (error) { existing = null }
      if (existing && existing.lib && typeof existing.lib.getDocument === 'function') {
        // 只在 worker 地址同源可用时复用它；vscode-mode 那份的 worker 在 /edrv 下，
        // 一旦插件被禁用就会 404，所以复用前先确认它确实用的是我们的 vendor。
        var sameVendor = false
        try {
          var ws = String((existing.lib.GlobalWorkerOptions || {}).workerSrc || '')
          sameVendor = ws.indexOf(PDF_VENDOR) >= 0
        } catch (error) { sameVendor = false }
        if (sameVendor) {
          report('info', '复用已加载的 pdf.js 实例')
          pdfLibPromise = Promise.resolve(adopt(existing.lib))
          return pdfLibPromise
        }
      }

      var cached = null
      try { cached = window.__dshLatexPdfLib } catch (error) { cached = null }
      if (cached && typeof cached.getDocument === 'function') {
        pdfLibPromise = Promise.resolve(adopt(cached))
        return pdfLibPromise
      }

      report('info', '注入 module script 加载 pdf.js：' + base + '/build/pdf.mjs')
      pdfLibPromise = new Promise(function (resolve, reject) {
        var settled = false
        function finish() {
          if (settled) return
          var lib = null
          try { lib = window.__dshLatexPdfLib } catch (error) { lib = null }
          if (!lib || typeof lib.getDocument !== 'function') {
            settled = true
            reject(new Error('pdf.js 模块未就导出 getDocument'))
            return
          }
          settled = true
          report('info', 'pdf.js 已就绪（独立实例）')
          resolve(adopt(lib))
        }

        var tag = document.querySelector('script[data-dsh-dmzlatexworkshop-pdfjs]')
        if (tag) {
          tag.addEventListener('dsh-dmzlatexworkshop-pdfjs-ready', finish, { once: true })
          setTimeout(finish, 1000)
          return
        }

        var s = document.createElement('script')
        s.type = 'module'
        s.textContent =
          'import * as lib from ' + JSON.stringify(base + '/build/pdf.mjs') + ';\n' +
          'window.__dshLatexPdfLib = lib;\n' +
          'document.querySelector("script[data-dsh-dmzlatexworkshop-pdfjs]").dispatchEvent(new Event("dsh-dmzlatexworkshop-pdfjs-ready"));'
        s.setAttribute('data-dsh-dmzlatexworkshop-pdfjs', '1')
        s.onload = finish
        s.onerror = function () {
          if (settled) return
          settled = true
          reject(new Error('pdf.js module script 加载失败（检查 ' + PDF_VENDOR + ' 路由）'))
        }
        ;(document.head || document.documentElement).appendChild(s)
        // onload 对 inline module 不可靠（实测不触发，只能靠超时兜底救场），
        // 改为轮询交接变量：通常 1 秒内就绪，而不是干等 15 秒。
        var tick = setInterval(function () {
          if (settled) { clearInterval(tick); return }
          var got = null
          try { got = window.__dshLatexPdfLib } catch (error) { got = null }
          if (got && typeof got.getDocument === 'function') { clearInterval(tick); finish() }
        }, 120)
        setTimeout(function () { if (!settled) { clearInterval(tick); finish() } }, 15000)
      }).catch(function (error) {
        pdfLibPromise = null
        report('error', 'pdf.js 加载失败：' + errText(error))
        throw error
      })
      return pdfLibPromise
    }

    // --endregion

    // --region PDF 预览面板

    var panel = {
      el: null,
      titleEl: null,
      metaEl: null,
      scrollEl: null,
      pagesEl: null,
      staleEl: null,
      staleTextEl: null,
      staleListEl: null,
      staleLogEl: null,
      staleMoreEl: null,
      stale: false,
      pdfMtimeMs: 0,
      doc: null,
      pdfRel: null,
      scale: 1,
      fit: true,
      slots: [],
      observer: null,
      token: 0,
      loading: false,
      baseSize: null,
    }

    function isDark() {
      try {
        var bg = getComputedStyle(document.body).backgroundColor
        var m = String(bg).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
        if (m) {
          var l = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255
          return l < 0.5
        }
      } catch (error) { /* 取不到就退回系统偏好 */ }
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch (error) { return false }
    }

    function injectStyle() {
      if (document.getElementById('dsh-dmzlatexworkshop-style')) return
      var style = document.createElement('style')
      style.id = 'dsh-dmzlatexworkshop-style'
      style.textContent = [
        '.dsh-dmzlatexworkshop-panel{position:fixed;right:0;display:flex;flex-direction:column;z-index:9000;',
        'border-left:1px solid var(--dlx-border);background:var(--dlx-bg);color:var(--dlx-fg);',
        'box-shadow:-8px 0 24px rgba(0,0,0,.20);font-family:var(--font-sans,-apple-system,"Segoe UI",sans-serif);',
        'font-size:13px;line-height:1.5}',
        '.dsh-dmzlatexworkshop-grip{position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:2}',
        '.dsh-dmzlatexworkshop-bar{display:flex;align-items:center;gap:6px;padding:6px 10px;flex:none;',
        'background:var(--dlx-bar);border-bottom:1px solid var(--dlx-border);min-height:34px}',
        '.dsh-dmzlatexworkshop-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}',
        '.dsh-dmzlatexworkshop-meta{color:var(--dlx-dim);font-size:12px;flex:none}',
        '.dsh-dmzlatexworkshop-spacer{flex:1}',
        '.dsh-dmzlatexworkshop-btn{flex:none;height:24px;min-width:26px;padding:0 7px;border-radius:5px;cursor:pointer;',
        'border:1px solid var(--dlx-border);background:var(--dlx-btn);color:var(--dlx-fg);font-size:12px;',
        'font-family:inherit;line-height:1}',
        '.dsh-dmzlatexworkshop-btn:hover{background:var(--dlx-btn-hover)}',
        '.dsh-dmzlatexworkshop-scroll{flex:1;overflow:auto;padding:14px 0 24px;display:flex;flex-direction:column;',
        'align-items:center;gap:14px;background:var(--dlx-stage)}',
        '.dsh-dmzlatexworkshop-slot{position:relative;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.22);flex:none}',
        '.dsh-dmzlatexworkshop-slot canvas{display:block;border-radius:1px}',
        '.dsh-dmzlatexworkshop-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
        'color:#b4b2a9;font-size:12px;background:#fff}',
        '.dsh-dmzlatexworkshop-err{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
        'padding:20px;color:#a32d2d;font-size:12px;text-align:center;background:#fcebeb}',
        '.dsh-dmzlatexworkshop-hint{padding:24px;color:var(--dlx-dim);font-size:12px;text-align:center;max-width:80%}',
        // 正向搜索落点：一块很快淡出的高亮，扫一眼就知道跳到哪了
        '.dsh-dmzlatexworkshop-flash{position:absolute;pointer-events:none;border-radius:3px;',
        'background:rgba(255,193,7,.32);box-shadow:inset 0 0 0 1px rgba(226,146,0,.6);',
        'transition:opacity .35s ease}',
        // 编译失败横幅：贴在预览面板顶部，明说「下面这份不是当前的」
        '.dsh-dmzlatexworkshop-stale{flex:none;display:flex;flex-direction:column;gap:6px;',
        'padding:7px 10px;background:var(--dlx-bad-bg);color:var(--dlx-bad-fg);',
        'border-bottom:1px solid var(--dlx-bad-line);font-size:12px}',
        '.dsh-dmzlatexworkshop-stale-row{display:flex;align-items:center;gap:8px;min-width:0}',
        '.dsh-dmzlatexworkshop-stale-icon{flex:none;font-weight:600}',
        '.dsh-dmzlatexworkshop-stale-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dsh-dmzlatexworkshop-stale-btn{flex:none;height:20px;padding:0 7px;border-radius:4px;cursor:pointer;',
        'border:1px solid var(--dlx-bad-line);background:transparent;color:inherit;font-size:11px;font-family:inherit}',
        '.dsh-dmzlatexworkshop-stale-btn:hover{background:var(--dlx-bad-btn-hover)}',
        '.dsh-dmzlatexworkshop-stale-list{max-height:38vh;overflow:auto;display:flex;flex-direction:column;gap:1px;',
        'border-top:1px solid var(--dlx-bad-line);padding-top:5px;margin-top:1px}',
        '.dsh-dmzlatexworkshop-stale-item{display:flex;gap:8px;align-items:baseline;text-align:left;width:100%;',
        'border:0;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;',
        'padding:2px 4px;border-radius:3px}',
        '.dsh-dmzlatexworkshop-stale-item:hover{background:var(--dlx-bad-btn-hover)}',
        '.dsh-dmzlatexworkshop-stale-where{flex:none;opacity:.8;font-variant-numeric:tabular-nums}',
        '.dsh-dmzlatexworkshop-stale-msg{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        // 「完整输出：xxx.latexmk.log」——可点开成标签页
        '.dsh-dmzlatexworkshop-stale-log{appearance:none;border:0;background:transparent;',
        'color:inherit;font:inherit;font-size:11px;opacity:.8;text-align:left;cursor:pointer;',
        'padding:0;text-decoration:underline;text-underline-offset:2px;align-self:flex-start}',
        '.dsh-dmzlatexworkshop-stale-log:hover{opacity:1}',
        // 没有结构化错误时直接铺 latexmk 输出尾部
        '.dsh-dmzlatexworkshop-stale-tail{margin:0;padding:6px 8px;border-radius:4px;',
        'background:rgba(0,0,0,.06);font-family:var(--dmz-mono,ui-monospace,Consolas,monospace);',
        'font-size:11px;line-height:1.45;white-space:pre-wrap;word-break:break-all;',
        'max-height:34vh;overflow:auto}',
        // 陈旧内容变暗：不能只靠横幅——视线落在页面上时，必须一眼看出它「不是当前的」
        '.dsh-dmzlatexworkshop-panel.dlx-stale .dsh-dmzlatexworkshop-scroll{opacity:.45;filter:grayscale(.65)}',
        '.dsh-dmzlatexworkshop-panel.dlx-stale .dsh-dmzlatexworkshop-scroll:hover{opacity:.85}',
        // 还没有 PDF 时（首次编译就失败），直接在预览栏里列出错误
        '.dsh-dmzlatexworkshop-failcard{position:absolute;inset:0;overflow:auto;padding:14px;',
        'background:var(--dlx-bg);color:var(--dlx-fg);font-size:12px;display:flex;flex-direction:column;gap:8px}',
        '.dsh-dmzlatexworkshop-failcard h4{margin:0;font-size:12.5px;font-weight:500;color:var(--dlx-bad-fg)}',
        '.dsh-dmzlatexworkshop-failcard .dsh-dmzlatexworkshop-stale-item{font-size:12px}',
      ].join('')
      ;(document.head || document.documentElement).appendChild(style)
    }

    function applyTheme(el) {
      var dark = isDark()
      el.style.setProperty('--dlx-bg', dark ? '#1f1f1d' : '#f7f7f5')
      el.style.setProperty('--dlx-bar', dark ? '#272725' : '#ffffff')
      el.style.setProperty('--dlx-fg', dark ? '#e8e8e4' : '#2c2c2a')
      el.style.setProperty('--dlx-dim', dark ? '#9a9a94' : '#6b6b66')
      el.style.setProperty('--dlx-border', dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.13)')
      el.style.setProperty('--dlx-btn', dark ? '#333331' : '#f2f2ef')
      el.style.setProperty('--dlx-btn-hover', dark ? '#3d3d3a' : '#e6e6e1')
      el.style.setProperty('--dlx-stage', dark ? '#161614' : '#e9e9e6')
      // 编译失败的红色系：暗色下要压低亮度，否则一片刺眼
      el.style.setProperty('--dlx-bad-bg', dark ? '#3a2220' : '#fcebeb')
      el.style.setProperty('--dlx-bad-fg', dark ? '#ff9f9a' : '#a32d2d')
      el.style.setProperty('--dlx-bad-line', dark ? 'rgba(255,120,110,.35)' : 'rgba(163,45,45,.28)')
      el.style.setProperty('--dlx-bad-btn-hover', dark ? 'rgba(255,120,110,.18)' : 'rgba(163,45,45,.10)')
    }

    function makeBtn(text, title, onClick) {
      var b = document.createElement('button')
      b.className = 'dsh-dmzlatexworkshop-btn'
      b.textContent = text
      b.title = title
      b.addEventListener('click', function (event) {
        event.preventDefault(); event.stopPropagation(); onClick()
      })
      return b
    }

    function buildPanel() {
      injectStyle()
      var el = document.createElement('div')
      el.className = 'dsh-dmzlatexworkshop-panel'
      applyTheme(el)

      // 工作台开着时 PDF 直接进右栏（同屏看代码与成品），
      // 否则退回贴右缘的浮层 + 压缩 vscode-mode 编辑区。
      // wb 在工作台区才初始化，这里必须防 undefined（var 提升）
      var embedded = !!(typeof wb !== 'undefined' && wb && wb.el && wb.pdfEl)
      if (embedded) {
        el.style.position = 'absolute'
        el.style.top = '0px'
        el.style.left = '0px'
        el.style.right = '0px'
        el.style.bottom = '0px'
        el.style.width = 'auto'
        el.style.boxShadow = 'none'
        el.style.zIndex = '1'
      } else {
        try {
          var anchor = document.querySelector('.edrv-tabs-row') || document.querySelector('.edrv-main')
          var rect = anchor ? anchor.getBoundingClientRect() : null
          el.style.top = Math.max(0, rect ? Math.round(rect.top) : 0) + 'px'
        } catch (error) { el.style.top = '0px' }
        el.style.bottom = '0px'
        el.style.width = Math.max(360, Math.round(window.innerWidth * 0.46)) + 'px'

        var grip = document.createElement('div')
        grip.className = 'dsh-dmzlatexworkshop-grip'
        el.appendChild(grip)
        bindDrag(grip, el)
      }

      var bar = document.createElement('div')
      bar.className = 'dsh-dmzlatexworkshop-bar'

      var nameEl = document.createElement('span')
      nameEl.className = 'dsh-dmzlatexworkshop-name'
      nameEl.textContent = 'PDF'
      var metaEl = document.createElement('span')
      metaEl.className = 'dsh-dmzlatexworkshop-meta'
      var spacer = document.createElement('span')
      spacer.className = 'dsh-dmzlatexworkshop-spacer'

      bar.appendChild(nameEl)
      bar.appendChild(metaEl)
      bar.appendChild(spacer)
      bar.appendChild(makeBtn('−', '缩小', function () { zoomBy(1 / 1.15) }))
      bar.appendChild(makeBtn('+', '放大', function () { zoomBy(1.15) }))
      bar.appendChild(makeBtn('适宽', '适应面板宽度', function () { setFit(true) }))
      bar.appendChild(makeBtn('↻', '重新读取 PDF', function () { if (panel.pdfRel) void loadPdf(panel.pdfRel) }))
      if (!embedded) bar.appendChild(makeBtn('×', '关闭预览', function () { closePanel() }))
      el.appendChild(bar)

      // 编译失败时插在工具栏与页面之间：明说「下面这份是旧的」，并列出错误
      var stale = document.createElement('div')
      stale.className = 'dsh-dmzlatexworkshop-stale'
      stale.style.display = 'none'
      var staleRow = document.createElement('div')
      staleRow.className = 'dsh-dmzlatexworkshop-stale-row'
      var staleIcon = document.createElement('span')
      staleIcon.className = 'dsh-dmzlatexworkshop-stale-icon'
      staleIcon.textContent = '✗'
      var staleText = document.createElement('span')
      staleText.className = 'dsh-dmzlatexworkshop-stale-text'
      var staleMore = document.createElement('button')
      staleMore.type = 'button'
      staleMore.className = 'dsh-dmzlatexworkshop-stale-btn'
      staleMore.textContent = '详情'
      staleRow.appendChild(staleIcon)
      staleRow.appendChild(staleText)
      staleRow.appendChild(staleMore)
      var staleList = document.createElement('div')
      staleList.className = 'dsh-dmzlatexworkshop-stale-list'
      staleList.style.display = 'none'
      // 「完整输出：xxx.latexmk.log」——点一下在工作台标签里打开。
      // latexmk 层面的失败（缺引擎、缺 .sty、中途放弃）只有这份输出说得清。
      var staleLog = document.createElement('button')
      staleLog.type = 'button'
      staleLog.className = 'dsh-dmzlatexworkshop-stale-log'
      staleLog.style.display = 'none'
      staleLog.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        var rel = staleLog.__dmzLogRel
        if (!rel) return
        // 打开日志时不要把 PDF 预览收起来：你多半要边看日志边对照成品
        void openWorkbenchFile(rel, { keepPreview: true })
      })
      stale.appendChild(staleRow)
      stale.appendChild(staleLog)
      stale.appendChild(staleList)
      el.appendChild(stale)

      var scroll = document.createElement('div')
      scroll.className = 'dsh-dmzlatexworkshop-scroll'
      var pages = document.createElement('div')
      pages.className = 'dsh-dmzlatexworkshop-pages'
      pages.style.display = 'flex'
      pages.style.flexDirection = 'column'
      pages.style.alignItems = 'center'
      pages.style.gap = '14px'
      scroll.appendChild(pages)
      el.appendChild(scroll)

      scroll.addEventListener('click', onPdfClick, true)

      if (embedded) {
        if (wb.pdfEl) {
          wb.pdfEl.textContent = ''
          wb.pdfEl.appendChild(el)
        }
      } else {
        document.body.appendChild(el)
        dockPanel(el)
      }
      panel.el = el
      panel.titleEl = nameEl
      panel.metaEl = metaEl
      panel.scrollEl = scroll
      panel.pagesEl = pages
      panel.staleEl = stale
      panel.staleTextEl = staleText
      panel.staleListEl = staleList
      panel.staleLogEl = staleLog
      panel.staleMoreEl = staleMore

      staleMore.addEventListener('click', function () {
        var open = staleList.style.display !== 'none'
        staleList.style.display = open ? 'none' : 'flex'
        staleMore.textContent = open ? '详情' : '收起'
      })

      report('info', 'PDF 面板已创建（' + (embedded ? '嵌入工作台右栏' : '浮层停靠') + '）')
      return el
    }

    var docked = { el: null, baseWidth: 0, targets: [] }

    /**
     * 找编辑区外壳：从标签栏往上找到第一个「占满视口高度」的祖先。
     * 给它加右侧外边距就能让编辑器真正变窄，而不是被面板盖住。
     */
    function findEditorShell() {
      try {
        var row = document.querySelector('.edrv-tabs-row')
        if (!row) return null
        var vh = window.innerHeight
        var node = row.parentElement
        while (node && node !== document.body && node !== document.documentElement) {
          var r = node.getBoundingClientRect()
          // 只看高度：编辑区必然占据大半视口；这样即使面板已让出一部分宽度也能再次命中
          if (r.height >= vh * 0.55 && r.width >= 360) {
            report('info', '编辑区外壳：' + (node.className || node.tagName) + ' '
              + Math.round(r.width) + 'x' + Math.round(r.height) + ' @' + Math.round(r.left))
            return node
          }
          node = node.parentElement
        }
        report('info', '编辑区外壳：未找到（从 .edrv-tabs-row 向上无高容器）')
      } catch (error) { /* 结构不符则放弃停靠 */ }
      return null
    }

    /**
     * 只收窄「代码区」，不动 tab 栏。
     * 外层 group 一起压的话 tab 栏也会跟着变窄（用户要的是边栏保持原宽）；
     * 所以目标限定在 `.edrv-editor-area`（flex 列容器）和 `.edrv-monaco-host`。
     */
    function collectDockTargets(shell) {
      var out = []
      try {
        var inner = shell.querySelectorAll('.edrv-editor-area, .edrv-monaco-host')
        for (var i = 0; i < inner.length; i++) {
          out.push({
            el: inner[i],
            prevMax: inner[i].style.maxWidth || '',
            prevMargin: inner[i].style.marginRight || '',
            prevWidth: inner[i].style.width || '',
          })
        }
      } catch (error) { /* 结构缺失走兜底 */ }
      if (!out.length) {
        // 类名对不上时退回压外壳：tab 栏会一起窄，但至少代码区能收
        out.push({
          el: shell,
          prevMax: shell.style.maxWidth || '',
          prevMargin: shell.style.marginRight || '',
          prevWidth: shell.style.width || '',
        })
        report('info', '未找到 .edrv-editor-area，退回收窄整个外壳')
      }
      return out
    }

    var relayoutTimer = null
    var layoutReported = false
    /** Monaco 用 automaticLayout + ResizeObserver 盯自己的绝对定位 div，容器换宽后要主动 layout 一次。 */
    function relayoutMonaco() {
      if (relayoutTimer) return
      relayoutTimer = setTimeout(function () {
        relayoutTimer = null
        try {
          var m = window.monaco
          if (!m || !m.editor || typeof m.editor.getEditors !== 'function') {
            if (!layoutReported) { layoutReported = true; report('error', 'Monaco 重排：window.monaco 不可用') }
            return
          }
          var list = m.editor.getEditors()
          for (var i = 0; i < list.length; i++) {
            try { list[i].layout() } catch (error) { /* 单个实例失败继续 */ }
          }
          if (!layoutReported) {
            layoutReported = true
            report('info', 'Monaco 重排 ' + list.length + ' 个编辑器')
          }
        } catch (error) { /* 无 monaco 全局则依赖 resize 事件 */ }
      }, 16)
    }

    var wrapBackup = null
    /**
     * 面板占据右侧空间后，长行会挤成横向滚动条。这里在预览期间打开自动换行
     * （等价 VSCode 的 editor.wordWrap: on），关闭预览时逐条还原原值。
     */
    function applyWrap(on) {
      try {
        var m = window.monaco
        if (!m || !m.editor || typeof m.editor.getEditors !== 'function') {
          report('error', '自动换行：window.monaco 不可用')
          return
        }
        var list = m.editor.getEditors()
        if (on) {
          if (wrapBackup) return
          wrapBackup = []
          for (var i = 0; i < list.length; i++) {
            var prev = 'off'
            try { prev = (list[i].getRawOptions && list[i].getRawOptions().wordWrap) || 'off' } catch (error) { prev = 'off' }
            wrapBackup.push({ ed: list[i], wordWrap: prev })
            try { list[i].updateOptions({ wordWrap: 'on' }) } catch (error) { /* 单实例失败继续 */ }
          }
          report('info', '已为 ' + list.length + ' 个编辑器开启自动换行')
        } else {
          if (!wrapBackup) return
          for (var k = 0; k < wrapBackup.length; k++) {
            try { wrapBackup[k].ed.updateOptions({ wordWrap: wrapBackup[k].wordWrap }) } catch (error) { /* 已销毁 */ }
          }
          report('info', '已还原 ' + wrapBackup.length + ' 个编辑器的换行设置')
          wrapBackup = null
        }
      } catch (error) { report('error', '自动换行设置失败：' + errText(error)) }
    }

    function dockWidthFor(baseWidth) {
      return Math.round(Math.min(Math.max(360, baseWidth * 0.48), 920))
    }

    var shellObs = null
    var docking = false

    /**
     * 盯住外壳宽度。左侧会话栏收起/展开、窗口缩放时外壳会变宽变窄，
     * 而面板用的是绝对像素 left，不重算就会飘离右边缘、空出一条。
     */
    function watchDockShell() {
      if (shellObs) { try { shellObs.disconnect() } catch (error) {} shellObs = null }
      if (!docked.el || typeof ResizeObserver !== 'function') return
      shellObs = new ResizeObserver(function () {
        if (docking || !docked.el || !panel.el) return
        var w = docked.el.getBoundingClientRect().width
        if (Math.abs(w - docked.baseWidth) < 6) return
        docking = true
        try {
          // 先还原内层量出「未压缩」宽度，再按新宽度重新压
          for (var i = 0; i < docked.targets.length; i++) {
            var t = docked.targets[i]
            t.el.style.width = t.prevWidth
            t.el.style.maxWidth = t.prevMax
          }
          var base = docked.targets.length
            ? docked.targets[0].el.getBoundingClientRect().width
            : w
          docked.baseWidth = Math.max(360, base)
          panel.el.style.width = dockWidthFor(docked.baseWidth) + 'px'
          syncDockWidth(panel.el)
          var row = docked.el.querySelector('.edrv-tabs-row')
          if (row) panel.el.style.top = Math.round(row.getBoundingClientRect().bottom) + 'px'
          report('info', '外壳变化 ' + Math.round(w) + 'px → 重新布局，代码区基数 '
            + Math.round(docked.baseWidth) + '，面板左边缘 ' + panel.el.style.left)
        } catch (error) {
          report('error', '外壳变化重排失败：' + errText(error))
        }
        docking = false
      })
      try { shellObs.observe(docked.el) } catch (error) { /* 观察失败就只靠窗口 resize */ }
    }

    /**
     * 同步让位尺寸。margin 对 flex/绝对定位的容器可能无效，
     * 所以同时压 maxWidth（像素值，优先于 width 与 flex 增长），两条路兜底。
     */
    function syncDockWidth(el) {
      if (!docked.el || !el) return
      try {
        var w = Math.round(el.getBoundingClientRect().width)
        var limit = Math.max(280, docked.baseWidth - w) + 'px'
        for (var i = 0; i < docked.targets.length; i++) {
          var t = docked.targets[i]
          t.el.style.maxWidth = limit
          if (t.el === docked.el) {
            t.el.style.marginRight = w + 'px'
          } else {
            // flex 子项的 max-width 有时会被更具体的选择器压过，直接给 width 更硬
            t.el.style.width = limit
          }
        }
        // 面板左边紧贴「代码区」右边缘（不是外壳右边缘——外壳没变窄）
        var anchor = docked.targets.length ? docked.targets[0].el : docked.el
        el.style.left = Math.round(anchor.getBoundingClientRect().right) + 'px'
        relayoutMonaco()
      } catch (error) { /* 元素已卸载 */ }
    }

    /** 让编辑区右侧退让，形成并排分栏（对齐 VSCode 编辑器组的行为）。 */
    function dockPanel(el) {
      var shell = findEditorShell()
      if (!shell) { report('info', '未找到编辑区外壳，预览仍为浮层'); return false }
      if (docked.el !== shell) {
        undockPanel()
        docked.el = shell
        docked.targets = collectDockTargets(shell)
        // 以「实际要收窄的那个容器」的宽度为基数，避免外壳带内边距时算偏
        docked.baseWidth = docked.targets.length
          ? docked.targets[0].el.getBoundingClientRect().width
          : shell.getBoundingClientRect().width
      }
      try {
        el.style.width = dockWidthFor(docked.baseWidth) + 'px'
        el.style.right = 'auto'
        syncDockWidth(el)
        el.style.boxShadow = 'none'
        // 顶边落在 tab 栏下方：边栏保持完整可见，不被面板压住
        var row = shell.querySelector('.edrv-tabs-row')
        if (row) el.style.top = Math.round(row.getBoundingClientRect().bottom) + 'px'
      } catch (error) { return false }
      var shrunk = docked.targets.map(function (t) {
        return (t.el.className || '').split(' ')[0] + '=' + Math.round(t.el.getBoundingClientRect().width)
      }).join(' ')
      report('info', '预览已停靠：' + Math.round(docked.baseWidth) + 'px 基数，面板左边缘 '
        + el.style.left + '；' + shrunk)
      try { window.dispatchEvent(new Event('resize')) } catch (error) {}
      watchDockShell()
      setTimeout(function () { if (docked.el) applyWrap(true) }, 150)
      return true
    }

    function undockPanel() {
      if (shellObs) { try { shellObs.disconnect() } catch (error) {} shellObs = null }
      if (!docked.el) { applyWrap(false); return }
      for (var i = 0; i < docked.targets.length; i++) {
        var t = docked.targets[i]
        try {
          t.el.style.maxWidth = t.prevMax
          t.el.style.marginRight = t.prevMargin
          t.el.style.width = t.prevWidth
        } catch (error) { /* 元素已卸载 */ }
      }
      docked.el = null
      docked.baseWidth = 0
      docked.targets = []
      try { window.dispatchEvent(new Event('resize')) } catch (error) {}
      relayoutMonaco()
      applyWrap(false)
    }

    function bindDrag(grip, el) {
      var dragging = false
      grip.addEventListener('mousedown', function (event) {
        event.preventDefault()
        dragging = true
        var right = el.getBoundingClientRect().right
        var move = function (e) {
          if (!dragging) return
          var maxW = docked.baseWidth ? docked.baseWidth - 280 : window.innerWidth - 240
          var w = Math.max(320, Math.min(right - e.clientX, maxW))
          el.style.width = Math.round(w) + 'px'
          syncDockWidth(el)
        }
        var up = function () {
          dragging = false
          window.removeEventListener('mousemove', move)
          window.removeEventListener('mouseup', up)
          syncDockWidth(el)
          if (panel.fit) relayout()
        }
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      })
    }

    function clearPages() {
      if (panel.observer) { try { panel.observer.disconnect() } catch (error) {} panel.observer = null }
      if (panel.pagesEl) panel.pagesEl.textContent = ''
      panel.slots = []
    }

    function hint(text) {
      clearPages()
      var div = document.createElement('div')
      div.className = 'dsh-dmzlatexworkshop-hint'
      div.textContent = text
      panel.pagesEl.appendChild(div)
    }

    function openPdf(pdfRel) {
      // 落位可能变了（浮层 ↔ 工作台右栏），父节点不一致就重建，避免 PDF 留在旧宿主里
      var wantHost = (wb && wb.el && wb.pdfEl) ? wb.pdfEl : null
      var curHost = panel.el && panel.el.parentNode ? panel.el.parentNode : null
      if (panel.el && curHost !== wantHost) closePanel()
      if (!panel.el) buildPanel()
      panel.pdfRel = pdfRel
      if (panel.titleEl) panel.titleEl.textContent = baseName(pdfRel)
      panel.el.style.display = 'flex'
      var loaded = loadPdf(pdfRel)
      // 预览收起时内容照常更新，但不抢着弹开——收起是你自己选的
      if (wb && wb.pdfEl && wb.pdfEl.style.display === 'none') {
        return loaded.then(function () {
          status('LaTeX：PDF 已更新（预览已收起，点「展开预览」查看）')
          return null
        })
      }
      return loaded
    }

    function closePanel() {
      panel.token++
      if (panel.doc) { try { panel.doc.destroy() } catch (error) {} panel.doc = null }
      clearPages()
      undockPanel()
      var host = panel.el && panel.el.parentNode ? panel.el.parentNode : null
      if (host) host.removeChild(panel.el)
      // 嵌在工作台右栏时，关掉后要留回占位，否则右栏会空成一片
      if (host && wb && wb.pdfEl && host === wb.pdfEl) {
        var ph = document.createElement('div')
        ph.className = 'dmz-wb-placeholder'
        ph.textContent = '编译后在这里显示 PDF'
        wb.pdfEl.appendChild(ph)
      }
      panel.el = null
      panel.pdfRel = null
      report('info', 'PDF 面板已关闭')
    }

    function loadPdf(pdfRel) {
      var myToken = ++panel.token
      panel.loading = true
      // 记住滚动相对位置：重编译后 PDF 常被刷新，落回顶部会很烦
      var prevRatio = 0
      try {
        if (panel.scrollEl && panel.scrollEl.scrollHeight > 0) {
          prevRatio = panel.scrollEl.scrollTop / panel.scrollEl.scrollHeight
        }
      } catch (error) { prevRatio = 0 }
      if (panel.metaEl) panel.metaEl.textContent = '读取中…'
      hint('正在读取 PDF…')

      return rpc('readPdf', { relPath: pdfRel })
        .then(function (res) {
          if (myToken !== panel.token) return null
          if (!res || res.ok !== true) throw new Error((res && res.error) || '宿主未返回数据')
          panel.pdfMtimeMs = Number(res.data.mtimeMs) || 0
          var bytes = base64ToBytes(res.data.base64)
          report('info', 'PDF 已读入 ' + bytes.length + ' 字节，交给 pdf.js')
          if (panel.metaEl) panel.metaEl.textContent = '解析中…'
          return loadPdfLib().then(function (lib) {
            var base = appUrl(PDF_VENDOR)
            var task = lib.getDocument({
              data: bytes,
              cMapUrl: base + '/cmaps/',
              cMapPacked: true,
              standardFontDataUrl: base + '/standard_fonts/',
              isEvalSupported: false,
            })
            return task.promise
          })
        })
        .then(function (doc) {
          if (!doc || myToken !== panel.token) return null
          if (panel.doc) { try { panel.doc.destroy() } catch (error) {} }
          panel.doc = doc
          panel.fit = true
          report('info', 'pdf.js 解析成功，共 ' + doc.numPages + ' 页')
          return doc.getPage(1).then(function (page) {
            var vp = page.getViewport({ scale: 1 })
            panel.baseSize = { width: vp.width, height: vp.height }
            buildPages()
            if (panel.metaEl) panel.metaEl.textContent = doc.numPages + ' 页 · ' + Math.round(panel.scale * 100) + '%'
            if (prevRatio > 0 && panel.scrollEl) {
              setTimeout(function () {
                try { panel.scrollEl.scrollTop = Math.round(panel.scrollEl.scrollHeight * prevRatio) } catch (error) {}
              }, 40)
            }
            status('LaTeX：PDF 已就绪 · ' + doc.numPages + ' 页')
            return null
          })
        })
        .catch(function (error) {
          if (myToken !== panel.token) return
          report('error', 'PDF 加载失败：' + errText(error))
          hint('PDF 无法加载：' + errText(error))
          if (panel.metaEl) panel.metaEl.textContent = '加载失败'
        })
        .then(function () { panel.loading = false })
    }

    function fitScale() {
      if (!panel.baseSize) return 1
      var avail = (panel.scrollEl ? panel.scrollEl.clientWidth : 600) - 32
      if (avail <= 0) avail = 600
      return Math.max(0.3, Math.min(4, avail / panel.baseSize.width))
    }

    function relayout() {
      if (!panel.doc) return
      buildPages()
      if (panel.metaEl) {
        panel.metaEl.textContent = panel.doc.numPages + ' 页 · ' + Math.round(panel.scale * 100) + '%'
      }
    }

    function setFit(on) {
      panel.fit = !!on
      panel.scale = panel.fit ? fitScale() : panel.scale
      relayout()
    }

    function zoomBy(factor) {
      panel.fit = false
      panel.scale = Math.max(0.3, Math.min(4, panel.scale * factor))
      relayout()
    }

    // --region 编译失败时的「陈旧预览」标记

    /**
     * 为什么需要这套东西：
     *
     * 编译失败时 latexmk 不覆盖磁盘上的 PDF，于是预览里显示的仍是上一次成功的版本。
     * 看起来「一切正常」，实际你改的东西一个字都没进去 —— 这是最误导人的一种状态，
     * 比白屏危险得多（白屏至少你知道出事了）。所以失败必须**在预览上**说出来，
     * 而不是只在状态栏留一行会被下一条消息冲掉的提示。
     *
     * 三条并存的信息，各管一件事：
     *  1. 顶部红条 —— 明确「编译失败」，附带第一条错误和发生时间；
     *  2. 页面变暗 —— 视线落在页面上时也能看出这不是当前版本；
     *  3. 错误清单 —— 点一行直接跳到源码那一行，不用去编辑器里找波浪线。
     *
     * 不销毁旧 PDF 是刻意的：改坏之后往往想对照上一版长什么样。
     */

    /** 把时间戳格式化成 HH:MM:SS，给「上次成功于」用。 */
    function clockOf(ms) {
      var d = new Date(Number(ms) || 0)
      if (!d.getTime()) return ''
      function pad(n) { return (n < 10 ? '0' : '') + n }
      return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    }

    /** 摘掉全部子节点。不用 `textContent=''`：写测试桩时那只是个普通属性，清不掉子节点。 */
    function clearChildren(el) {
      if (!el) return
      while (el.children && el.children.length) el.removeChild(el.children[0])
    }

    /**
     * 构造可点击的错误行（点一下跳到源码）。
     * @param errors 编译错误数组（可空）
     * @param fallback 没有具体错误时的兜底文案
     * @param tail 没有结构化错误时，用 latexmk 输出尾部顶上（latexmk 层面的失败只有它能说明白）
     */
    function buildErrorRows(errors, fallback, tail) {
      var rows = []
      var list = Array.isArray(errors) ? errors : []
      for (var i = 0; i < list.length && i < 200; i++) {
        ;(function (e) {
          var row = document.createElement('button')
          row.type = 'button'
          row.className = 'dsh-dmzlatexworkshop-stale-item'
          var where = document.createElement('span')
          where.className = 'dsh-dmzlatexworkshop-stale-where'
          var file = e && e.file ? baseName(e.file) : ''
          var line = e && e.line ? e.line : ''
          where.textContent = file ? (file + (line ? ':' + line : '')) : ('第 ' + (i + 1) + ' 条')
          var msg = document.createElement('span')
          msg.className = 'dsh-dmzlatexworkshop-stale-msg'
          msg.textContent = (e && e.message) || '（无描述）'
          row.title = '跳到源码' + (file ? '：' + file + (line ? ' 第 ' + line + ' 行' : '') : '')
          row.appendChild(where)
          row.appendChild(msg)
          row.addEventListener('click', function (event) {
            event.preventDefault()
            event.stopPropagation()
            if (!file || !line) return
            // 只跳本文件内的错误：跨文件跳转要开另一个标签，这里先不猜路径
            var target = state.wbFile ? state.wbFile.relPath : ''
            if (!target) return
            if (!jumpToSource(target, line, 1)) status('LaTeX：无法跳转（工作台未就绪）')
          })
          rows.push(row)
        })(list[i])
      }
      if (!rows.length) {
        // 没有结构化错误（latexmk 中途放弃、引擎没起来之类）。这时 latexmk 自己的输出
        // 是唯一线索 —— 它现在会落盘成 .latexmk.log，但当场给一段尾部更快。
        var chunk = String(tail || '').trim()
        if (chunk) {
          var pre = document.createElement('pre')
          pre.className = 'dsh-dmzlatexworkshop-stale-tail'
          pre.textContent = chunk
          rows.push(pre)
        } else {
          var row = document.createElement('div')
          row.className = 'dsh-dmzlatexworkshop-stale-item'
          row.style.cursor = 'default'
          row.textContent = fallback || '编译未通过，请查看日志'
          rows.push(row)
        }
      }
      return rows
    }

    /** 取同目录下的兄弟文件路径（relPath 的目录部分 + 文件名）。 */
    function siblingPath(relPath, fileName) {
      var p = normRel(relPath)
      var cut = p.lastIndexOf('/')
      return cut >= 0 ? (p.slice(0, cut + 1) + fileName) : fileName
    }

    /**
     * 标记预览为「陈旧」：显示红色横幅 + 变暗页面。
     * @param tex 编译的源文件
     * @param errors 编译错误（可空）
     * @param fatal 致命错误文案（无 errors 时用它）
     * @param extra { tail, latexmkLog } —— 没有结构化错误时靠它说话
     */
    function markPreviewStale(tex, errors, fatal, extra) {
      if (!panel.el) return
      var info = extra || {}
      var list = Array.isArray(errors) ? errors : []
      var first = list.length ? list[0] : null
      var when = clockOf(panel.pdfMtimeMs)
      var head = '编译失败'
      if (first) {
        var where = first.file ? baseName(first.file) + (first.line ? ':' + first.line : '') + ' ' : ''
        head += ' · ' + where + (first.message || '')
      } else if (fatal) {
        head += ' · ' + fatal
      } else if (info.tail) {
        // 没有结构化错误但有输出：抓最后一行有内容的当摘要
        var lastLine = String(info.tail).split(/\r?\n/).filter(function (l) { return l.trim() }).pop() || ''
        head += ' · ' + (lastLine.trim().slice(0, 120) || '编译未完成')
      }
      if (list.length > 1) head += '（共 ' + list.length + ' 个错误）'
      // 磁盘上那份 PDF 是哪次留下的，直接写在提示里，避免误会
      head += when ? ' · 下面是 ' + when + ' 的旧版本' : ' · 下面是旧的 PDF'

      if (panel.staleTextEl) {
        panel.staleTextEl.textContent = head
        panel.staleTextEl.title = head
      }
      if (panel.staleLogEl) {
        if (info.latexmkLog) {
          panel.staleLogEl.textContent = '完整输出：' + info.latexmkLog + '（点开查看）'
          panel.staleLogEl.title = '在标签页里打开 latexmk 的完整输出；同目录的 .log 是 TeX 引擎日志'
          panel.staleLogEl.style.display = ''
          panel.staleLogEl.__dmzLogRel = siblingPath(tex, info.latexmkLog)
        } else {
          panel.staleLogEl.style.display = 'none'
          panel.staleLogEl.__dmzLogRel = null
        }
      }
      if (panel.staleListEl) {
        clearChildren(panel.staleListEl)
        buildErrorRows(list, fatal || '编译未通过，请查看日志', info.tail).forEach(function (row) {
          panel.staleListEl.appendChild(row)
        })
        // 多数错误、或只有 latexmk 原始输出时默认展开：既然失败了，原因就该摆在眼前
        var showList = list.length > 1 || (!list.length && !!info.tail)
        panel.staleListEl.style.display = showList ? 'flex' : 'none'
        if (panel.staleMoreEl) panel.staleMoreEl.textContent = showList ? '收起' : '详情'
      }
      if (panel.el) {
        panel.el.classList.add('dlx-stale')
        panel.el.setAttribute('data-dlx-stale', '1')
      }
      if (panel.staleEl) panel.staleEl.style.display = 'flex'
      panel.stale = true
      report('info', '预览已标记为陈旧（编译失败，保留旧 PDF）')
    }

    /** 解除陈旧标记（下次编译成功时调用）。 */
    function clearPreviewStale() {
      panel.stale = false
      if (panel.el) {
        panel.el.classList.remove('dlx-stale')
        panel.el.removeAttribute('data-dlx-stale')
      }
      if (panel.staleEl) panel.staleEl.style.display = 'none'
      if (panel.staleListEl) {
        clearChildren(panel.staleListEl)
        panel.staleListEl.style.display = 'none'
      }
    }

    /**
     * 还没有 PDF（首次编译就失败）时的错误卡片，直接铺在预览栏里。
     * 否则那片区域只会写着「编译后在这里显示 PDF」，等于什么都没告诉你。
     * @param extra { tail, latexmkLog }
     */
    function showFailureCard(tex, errors, fatal, extra) {
      var host = wb && wb.pdfEl ? wb.pdfEl : null
      if (!host) return
      var info = extra || {}
      clearFailureCard()
      var card = document.createElement('div')
      card.className = 'dsh-dmzlatexworkshop-failcard'
      card.setAttribute('data-dlx-failcard', '1')
      var title = document.createElement('h4')
      var count = (errors && errors.length) || 0
      title.textContent = '✗ ' + (fatal ? '编译失败 · ' + fatal
        : '编译失败 · ' + (count ? count + ' 个错误' : '编译未完成')) + '（还没有生成 PDF）'
      card.appendChild(title)
      if (info.latexmkLog) {
        var logBtn = document.createElement('button')
        logBtn.type = 'button'
        logBtn.className = 'dsh-dmzlatexworkshop-stale-log'
        logBtn.textContent = '完整输出：' + info.latexmkLog + '（点开查看）'
        logBtn.addEventListener('click', function (event) {
          event.preventDefault()
          event.stopPropagation()
          void openWorkbenchFile(siblingPath(tex, info.latexmkLog), { keepPreview: true })
        })
        card.appendChild(logBtn)
      }
      var box = document.createElement('div')
      box.className = 'dsh-dmzlatexworkshop-stale-list'
      box.style.maxHeight = 'none'
      box.style.borderTop = '0'
      var rows = buildErrorRows(errors, fatal || '编译未通过，请查看日志', info.tail)
      rows.forEach(function (row) {
        // 失败卡片是浅底，错误行用深一点的文字保证对比度
        row.style.color = 'var(--dlx-bad-fg)'
        box.appendChild(row)
      })
      card.appendChild(box)
      host.appendChild(card)
    }

    function clearFailureCard() {
      var host = wb && wb.pdfEl ? wb.pdfEl : null
      if (!host) return
      var old = null
      try { old = host.querySelector('[data-dlx-failcard]') } catch (error) { old = null }
      if (old && old.parentNode) old.parentNode.removeChild(old)
    }

    // --endregion

    function buildPages() {
      var doc = panel.doc
      if (!doc) return
      if (panel.fit) panel.scale = fitScale()
      clearPages()
      var scale = panel.scale
      var vw = panel.baseSize ? panel.baseSize.width * scale : 0
      var vh = panel.baseSize ? panel.baseSize.height * scale : 0

      var observer = null
      try {
        observer = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i++) {
            if (entries[i].isIntersecting) renderSlot(entries[i].target)
          }
        }, { root: panel.scrollEl, rootMargin: '320px 0px', threshold: 0.01 })
      } catch (error) { report('error', 'IntersectionObserver 不可用：' + errText(error)) }
      panel.observer = observer

      for (var n = 1; n <= doc.numPages; n++) {
        var slot = document.createElement('div')
        slot.className = 'dsh-dmzlatexworkshop-slot'
        slot.setAttribute('data-page', String(n))
        slot.style.width = Math.round(vw) + 'px'
        slot.style.height = Math.round(vh) + 'px'
        var ph = document.createElement('div')
        ph.className = 'dsh-dmzlatexworkshop-ph'
        ph.textContent = '第 ' + n + ' 页'
        slot.appendChild(ph)
        panel.pagesEl.appendChild(slot)
        panel.slots.push(slot)
        if (observer) observer.observe(slot)
        else void renderSlot(slot)
      }
    }

    function renderSlot(slot) {
      if (!slot || slot.getAttribute('data-state')) return
      var doc = panel.doc
      if (!doc) return
      var n = Number(slot.getAttribute('data-page'))
      slot.setAttribute('data-state', 'rendering')
      var scale = panel.scale
      var dpr = Math.min(window.devicePixelRatio || 1, 2)

      doc.getPage(n).then(function (page) {
        if (slot.getAttribute('data-state') !== 'rendering') return null
        var vp = page.getViewport({ scale: scale })
        var canvas = document.createElement('canvas')
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = Math.round(vp.width) + 'px'
        canvas.style.height = Math.round(vp.height) + 'px'
        var ctx = canvas.getContext('2d', { alpha: false })
        if (!ctx) throw new Error('canvas 2d 上下文不可用')
        slot.style.width = Math.round(vp.width) + 'px'
        slot.style.height = Math.round(vp.height) + 'px'
        var params = { canvasContext: ctx, viewport: vp, canvas: canvas }
        if (dpr !== 1) params.transform = [dpr, 0, 0, dpr, 0, 0]
        return page.render(params).promise.then(function () {
          var ph = slot.querySelector('.dsh-dmzlatexworkshop-ph')
          if (ph) ph.remove()
          slot.appendChild(canvas)
          slot.setAttribute('data-state', 'done')
          slot.__dlxViewport = vp
          slot.__dlxPage = page
          return null
        })
      }).catch(function (error) {
        slot.setAttribute('data-state', 'error')
        var ph = slot.querySelector('.dsh-dmzlatexworkshop-ph')
        if (ph) ph.remove()
        var err = document.createElement('div')
        err.className = 'dsh-dmzlatexworkshop-err'
        err.textContent = '第 ' + n + ' 页渲染失败：' + errText(error)
        slot.appendChild(err)
        report('error', '第 ' + n + ' 页渲染失败：' + errText(error))
      })
    }

    /** Ctrl+点击 PDF → SyncTeX 反查源码行。 */
    function onPdfClick(event) {
      if (!(event.ctrlKey || event.altKey)) return
      var slot = event.target && event.target.closest ? event.target.closest('.dsh-dmzlatexworkshop-slot') : null
      if (!slot || !slot.__dlxViewport) return
      // 以「当前显示的那份 PDF」为准，而不是当前激活的标签。
      // 多标签之后这两者可以是不同的文件：编译 main.tex 后切到 chap1.tex，
      // 若拿 chap1.tex 去反查，synctex 会去找 chap1.pdf 然后报「PDF 尚不存在」。
      var tex = ''
      if (panel.pdfRel) tex = String(panel.pdfRel).replace(/\.pdf$/i, '.tex')
      if (!tex) tex = currentTex()
      if (!tex) return
      var rect = slot.getBoundingClientRect()
      var vp = slot.__dlxViewport
      var pageObj = slot.__dlxPage
      // convertToPdfPoint 给的是 PDF 用户空间：原点在左下、y 向上。
      // synctex 要的是「原点左上、y 向下、单位 bp（与 PDF 点同为 1/72 inch）」。
      // 少了这一步 y 翻转，纵向就会整体偏移——这是之前跳不准的原因。
      var pt = vp.convertToPdfPoint(event.clientX - rect.left, event.clientY - rect.top)
      var view = (pageObj && pageObj.view) || [0, 0, 0, 0]
      var top = view[3] || 0
      var sx = pt[0] - (view[0] || 0)
      var sy = top - pt[1]
      var pageNo = Number(slot.getAttribute('data-page'))
      report('info', '反向搜索：page=' + pageNo + ' pdf=' + sx.toFixed(1) + ',' + sy.toFixed(1)
        + '（view=' + view.join(',') + '）')
      event.preventDefault()
      event.stopPropagation()
      status('LaTeX：正在定位源码…')
      rpc('synctexEdit', { relPath: tex, page: pageNo, x: sx, y: sy })
        .then(function (res) {
          if (!res || res.ok !== true) {
            status('LaTeX 定位失败：' + ((res && res.error) || '宿主无响应'))
            return
          }
          var d = res.data || {}
          if (!d.relPath && !d.file) { status('LaTeX 定位失败：无源码位置'); return }
          var target = d.relPath || d.file
          // 优先在自己的工作台里跳。
          //
          // 原来这里只 dispatch `edrv:open-editor` —— 那是 vscode-mode 的事件。
          // v2.1 起工作台自带 Monaco、v2.4 起改多标签，工作台的代码区早就不归
          // vscode-mode 管了，光发事件等于没人接：点了没反应，状态栏却显示成功。
          // 有了标签，跳转就是「找到/打开对应标签 → setPosition」。
          var jumped = false
          try { jumped = jumpToSource(target, d.line, d.column) } catch (error) {
            report('error', '工作台内跳转失败：' + errText(error))
          }
          if (!jumped) {
            // 兜底：工作台还没建起来（浮层未打开、或右侧栏服务缺失）时，
            // 仍然把事件发出去，让 vscode-mode 的编辑器接。
            window.dispatchEvent(new CustomEvent('edrv:open-editor', {
              detail: { path: target, line: d.line || 1, column: d.column || 1 },
            }))
          }
          status('↩ ' + baseName(target) + ':' + d.line)
        })
        .catch(function (error) { status('LaTeX 定位异常：' + errText(error)) })
    }

    // --endregion

    // --region 正向搜索（源码 → PDF）

    /**
     * 正向搜索：编辑器光标所在行 → PDF 里对应的位置。
     *
     * 与反向搜索共用一份 `.synctex.gz`，但方向相反。两处路径要分清：
     *  - 光标所在文件：`state.wbFile.relPath`，可能是 `\input` 进来的子文件；
     *  - PDF 归属：`panel.pdfRel`（上次编译出来的那份），子文件也要落到它上面。
     * 只传一个路径的话，子文件里的第 12 行会被当成主文件的第 12 行，位置整体偏。
     */
    function forwardSearch() {
      if (!wbEditor) { status('LaTeX：工作台编辑器还没就绪'); return Promise.resolve() }
      var tab = state.wbFile
      if (!tab || !tab.relPath) { status('LaTeX：请先打开要定位的 .tex 文件'); return Promise.resolve() }
      if (!isTexPath(tab.relPath)) {
        status('LaTeX：「' + tab.name + '」不是 .tex，没有 PDF 位置可查')
        return Promise.resolve()
      }
      var pos = null
      try { pos = wbEditor.getPosition() } catch (error) { pos = null }
      var line = pos && pos.lineNumber ? pos.lineNumber : 1
      var column = pos && pos.column ? pos.column : 1
      // 以「显示中的那份 PDF」为准：编译 main 后切到 chap1 再定位，仍然查 main.pdf
      var docRel = panel.pdfRel || tab.relPath
      status('LaTeX：正在 PDF 里定位 ' + baseName(tab.relPath) + ':' + line + ' …')
      report('info', '正向搜索请求：' + tab.relPath + ':' + line + ' → ' + docRel)
      return ensurePdfForForwardSearch(docRel)
        .then(function () {
          return rpc('synctexView', { relPath: tab.relPath, pdfRel: docRel, line: line, column: column })
        })
        .then(function (res) {
          if (!res || res.ok !== true) {
            var msg = 'LaTeX 定位不到：' + ((res && res.error) || '宿主无响应')
            status(msg)
            report('warn', '正向搜索失败（' + tab.relPath + ':' + line + '）：' + msg)
            return
          }
          var d = res.data || {}
          if (!d.page) { status('LaTeX 定位不到：synctex 没给出页码'); return }
          var ok = scrollPdfTo(d.page, d.x || 0, d.y || 0)
          if (!ok) { status('LaTeX 定位到了第 ' + d.page + ' 页，但预览还没准备好'); return }
          status('→ ' + baseName(docRel) + ' 第 ' + d.page + ' 页（源码 ' + line + ' 行）')
          report('info', '正向搜索：page=' + d.page + ' x=' + d.x + ' y=' + d.y)
        })
        .catch(function (error) {
          status('LaTeX 定位异常：' + errText(error))
          report('error', '正向搜索异常：' + errText(error))
        })
    }

    /**
     * 保证要定位的那份 PDF 已经打开并且可见。
     * 没编译过就没有 PDF，交给宿主报「PDF 尚不存在，先编译」。
     */
    function ensurePdfForForwardSearch(docRel) {
      var pdfRel = /\.pdf$/i.test(String(docRel)) ? docRel : String(docRel).replace(/\.tex$/i, '.pdf')
      if (wb && wb.pdfEl && wb.pdfEl.style.display === 'none') togglePdfPane(true)
      if (panel.doc && panel.pdfRel === pdfRel && panel.slots && panel.slots.length) return Promise.resolve()
      try { return Promise.resolve(openPdf(pdfRel)) } catch (error) { return Promise.resolve() }
    }

    /**
     * 把 PDF 滚动到指定页的指定位置，并在落点闪一下。
     *
     * 坐标是 synctex 的「页左上原点、单位 bp」；乘上当前缩放就是 CSS 像素。
     * 不按页面绝对高度算，而是用真实 rect 差值——分页之间有间距、缩放也会变，
     * 用「页序号 × 页高」一旦和实际布局差几像素，长文档里会越滚越偏。
     *
     * @returns 是否滚动成功
     */
    function scrollPdfTo(page, x, y) {
      var scroll = panel.scrollEl
      var slots = panel.slots
      if (!scroll || !slots || !slots.length) return false
      var slot = slots[Number(page) - 1]
      if (!slot) return false
      // 目标页可能还没被 IntersectionObserver 渲染：先催一次，落点高亮要画在它里面
      try { renderSlot(slot) } catch (error) { /* 渲染失败不影响滚动 */ }
      var scale = panel.scale || 1
      var scrollRect = null
      var slotRect = null
      try {
        scrollRect = scroll.getBoundingClientRect()
        slotRect = slot.getBoundingClientRect()
      } catch (error) { scrollRect = null }
      if (!scrollRect || !slotRect) return false
      var inSlot = (Number(y) || 0) * scale
      var absTop = scroll.scrollTop + (slotRect.top - scrollRect.top) + inSlot
      // 落在视口上三分之一处：上面留着上下文，下面留着续读
      var target = absTop - Math.max(40, scroll.clientHeight / 3)
      try { scroll.scrollTop = Math.max(0, Math.round(target)) } catch (error) { return false }
      flashPdfPoint(slot, x, y, scale)
      return true
    }

    /** 在落点画一条很快淡出的高亮带（纯提示，失败也不报错）。 */
    function flashPdfPoint(slot, x, y, scale) {
      try {
        var old = slot.querySelector('.dsh-dmzlatexworkshop-flash')
        if (old && old.parentNode) old.parentNode.removeChild(old)
        var mark = document.createElement('div')
        mark.className = 'dsh-dmzlatexworkshop-flash'
        var h = Math.max(10, Math.round(13 * scale))
        mark.style.left = '0'
        mark.style.width = '100%'
        mark.style.height = h + 'px'
        mark.style.top = Math.max(0, Math.round((Number(y) || 0) * scale - h / 2)) + 'px'
        slot.appendChild(mark)
        setTimeout(function () {
          try {
            mark.style.opacity = '0'
            setTimeout(function () {
              if (mark.parentNode) mark.parentNode.removeChild(mark)
            }, 420)
          } catch (error) { /* 元素早已被清掉 */ }
        }, 1200)
      } catch (error) { /* 高亮只是锦上添花 */ }
    }

    // --endregion

    // --region LaTeX 语言支持（语法高亮 / 诊断 / 公式预览）

    var LATEX_LANG = 'latex'
    var monacoApi = null
    var diagStore = {}
    var lintTimers = {}
    /** 排队等 Monaco 的回调、轮询句柄与起始时间（见 whenMonaco）。 */
    var monacoWaiters = []
    var monacoPollTimer = null
    var monacoPollStart = 0
    /** 语言层装到哪个 monaco 实例上了（换实例才重装，避免重复注册监听器/定时器）。 */
    var langLayerReadyFor = null
    /** 全局钩子（onDidCreateModel / 4 秒巡检）是否已挂过。 */
    var langHooksBound = false

    /** 探一次：只有 languages + editor.getModels 都在，才算「能用的 Monaco」。 */
    function probeMonaco() {
      var m = null
      try { m = window.monaco } catch (error) { m = null }
      if (m && m.languages && m.editor && typeof m.editor.getModels === 'function') return m
      return null
    }

    /** 唤醒所有排队等 Monaco 的回调（每个回调只跑一次，失败不影响其它）。 */
    function flushMonacoWaiters(m) {
      // 判据必须和 probeMonaco 一致：拿到一个只有 editor、没有 languages 的残缺实例时
      // 不能把队列清空，否则语言层就再也没人负责了
      if (!m || !m.languages || !m.editor || typeof m.editor.getModels !== 'function') return false
      monacoApi = m
      var list = monacoWaiters
      monacoWaiters = []
      if (monacoPollTimer) { clearTimeout(monacoPollTimer); monacoPollTimer = null }
      monacoPollStart = 0
      for (var i = 0; i < list.length; i++) {
        try { list[i](m) } catch (error) {
          report('error', 'Monaco 就绪回调失败：' + errText(error))
        }
      }
      return true
    }

    /**
     * 等 Monaco 就绪。
     *
     * 这里**不能有超时放弃**。自带 vendor 的 Monaco 是「打开工作台才注入」的：
     * 启动后一直没点开页签，Monaco 就一小时都不在。早先版本等 600 秒就 return，
     * 于是那一刻之后到的 Monaco 没有任何人接手 —— 现象是「代码完全没有颜色」，
     * 日志里只留一句「Monaco 10 分钟内未就绪，高亮与诊断不可用」，看着像环境问题，
     * 实际是自己把唯一的入口焊死了。
     *
     * 现在的策略：
     *  1. 有人来问就登记，轮到就一起唤醒；
     *  2. 轮询前 2 分钟每秒一次（正常启动路径），之后降到 5 秒一直探；
     *  3. 自家注入成功时也会主动 flush（见 loadMonacoApi），不必等轮询。
     */
    function whenMonaco(cb) {
      var m = probeMonaco()
      if (m) { monacoApi = m; cb(m); return }
      monacoWaiters.push(cb)
      armMonacoPoll()
    }

    function armMonacoPoll() {
      if (monacoPollTimer) return
      if (!monacoPollStart) monacoPollStart = Date.now()
      function tick() {
        var hit = probeMonaco()
        if (hit) {
          var waited = Math.round((Date.now() - monacoPollStart) / 1000)
          monacoPollTimer = null
          report('info', 'Monaco 已就绪（等了 ' + waited + ' 秒）')
          flushMonacoWaiters(hit)
          return
        }
        var waitedMs = Date.now() - (monacoPollStart || Date.now())
        // 早期要快：正常启动时 Monaco 一两秒就到。晚期只是在守着一个可能很久才来的东西
        monacoPollTimer = setTimeout(tick, waitedMs < 120000 ? 1000 : 5000)
      }
      monacoPollTimer = setTimeout(tick, 1000)
    }

    /**
     * LaTeX 语法用的 TextMate scope 名。
     *
     * 这些名字不是随手起的：它们与 VSCode 的 LaTeX Workshop 语法
     * （`text.tex.latex`）完全一致，所以用户 VSCode 主题里的
     * tokenColors 规则能直接命中，做到「VSCode 里什么颜色，这里就什么颜色」。
     * 详见 lib/vscode-theme.js —— 它在宿主侧按 TextMate 的「最具体匹配」
     * 规则把这些 scope 逐个求值，再把结果交给这里去 defineTheme。
     */
    var S = {
      COMMENT: 'comment.line.percentage.latex',
      BE: 'support.function.be.latex',
      FN_PUNCT: 'punctuation.definition.function.latex',
      ARG_BEGIN: 'punctuation.definition.arguments.begin.latex',
      ARG_END: 'punctuation.definition.arguments.end.latex',
      OPT_BEGIN: 'punctuation.definition.arguments.optional.begin.latex',
      OPT_END: 'punctuation.definition.arguments.optional.end.latex',
      ENV: 'variable.parameter.function.latex',
      PREAMBLE: 'keyword.control.preamble.latex',
      STORAGE: 'storage.type.function.latex',
      CITE: 'keyword.control.cite.latex',
      REF: 'keyword.control.ref.latex',
      LABEL: 'keyword.control.label.latex',
      INCLUDE: 'keyword.control.include.latex',
      LAYOUT: 'keyword.control.layout.latex',
      SECTION: 'support.function.section.latex',
      ITEM: 'keyword.other.item.latex',
      EMPH: 'support.function.emph.latex',
      TEXTBF: 'support.function.textbf.latex',
      TEXTIT: 'support.function.textit.latex',
      TEXTTT: 'support.function.texttt.latex',
      FOOTNOTE: 'support.function.footnote.latex',
      MARGIN: 'support.function.marginpar.latex',
      URL: 'support.function.url.latex',
      VERB: 'support.function.verb.latex',
      SYMBOL: 'constant.character.latex',
      GENERAL: 'support.function.general.latex',
      // 数学块整体：VSCode 给 `$…$` 的整个范围加 support.class.math.block.tex，
      // 给 `$$…$$` / `\[…\]` / 数学环境加 ...environment.latex。两者都命中主题的
      // support.class，所以块内文字（含定界符）是同一个颜色，命令才另算。
      MATH: 'support.class.math.block.tex',
      MATH_ENV: 'support.class.math.block.environment.latex',
      ESCAPE: 'constant.character.escape.latex',
      TBL_CELL: 'keyword.control.table.cell.latex',
      TBL_NL: 'keyword.control.table.newline.latex',
      EQ_ALIGN: 'keyword.control.equation.align.latex',
      EQ_NL: 'keyword.control.equation.newline.latex',
      GROUP_BEGIN: 'punctuation.group.begin.latex',
      GROUP_END: 'punctuation.group.end.latex',
    }

    /** 需要向宿主求色的 scope 全集。 */
    var ALL_SCOPES = []
    for (var sk in S) {
      if (Object.prototype.hasOwnProperty.call(S, sk)) ALL_SCOPES.push(S[sk])
    }

    /**
     * 命令分类。
     * 每条正则都照着 LaTeX Workshop 的 tmLanguage 写，保证「哪一类命令」
     * 的判断与 VSCode 一致；顺序即优先级，越具体的越靠前。
     */
    var CMD_RULES = [
      // 文档类与宏包：preamble
      [/[\\](?:usepackage|documentclass)\b/, S.PREAMBLE],
      // 定义新命令/环境：storage.type
      [/[\\](?:newcommand|renewcommand|providecommand|DeclareRobustCommand|newenvironment|renewenvironment|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|DeclareDocumentCommand|NewDocumentEnvironment|RenewDocumentEnvironment|newtheorem|def|edef|gdef|xdef|let)\*?/, S.STORAGE],
      // 链接类要排在 ref 之前，否则 \hyperref 会被当成 \...ref
      [/[\\](?:href|hyperref|hyperimage|url|nolinkurl)\b/, S.URL],
      // 引用：写法和 tmLanguage 的 citation-macro 一致
      [/[\\](?:[aA]uto|foot|full|footfull|no|ref|short|[tT]ext|[pP]aren|[sS]mart|[fFpP]vol|vol)?[cC]ite(?:al)?(?:p|s|t|author|year(?:par)?|title|url|date)?[ANP]*\*?/, S.CITE],
      [/[\\]label\b/, S.LABEL],
      // \ref \eqref \autoref \pageref \nameref \cref \Cref \vref …
      [/[\\][a-zA-Z]*[rR]ef\*?/, S.REF],
      [/[\\](?:input|include|includeonly|subfile|includegraphics|import|subimport|bibliography|addbibresource)\b/, S.INCLUDE],
      [/[\\](?:newline|pagebreak|clearpage|linebreak|pause)\b/, S.LAYOUT],
      [/[\\](?:(?:sub){0,2}section|(?:sub)?paragraph|chapter|part|addpart|addchap|addsec|minisec|frametitle)\*?/, S.SECTION],
      [/[\\]item\b/, S.ITEM],
      [/[\\]emph\b/, S.EMPH],
      [/[\\](?:textbf|textmd|textnormal)\b/, S.TEXTBF],
      [/[\\](?:textit|textsl|textsc|underline)\b/, S.TEXTIT],
      [/[\\]texttt\b/, S.TEXTTT],
      [/[\\](?:footnote|footnotemark|footnotetext)\b/, S.FOOTNOTE],
      [/[\\]marginpar\b/, S.MARGIN],
      [/[\\](?:verb|Verb|lstinline|mintinline|spverb)\*?/, S.VERB],
      [/[\\](?:textcopyright|textregistered|texttrademark|textyen|textnumero|textsection|textparagraph|textdaggerdbl|textdagger|textbullet|textperiodcentered|textordfeminine|textordmasculine|copyright|pounds|dag|ddag|[SP])\b/, S.SYMBOL],
      // 转义字符（\% \{ \& 以及换行 \\）
      [/[\\][^a-zA-Z@]/, S.ESCAPE],
      // 兜底：其它所有命令
      [/[\\][a-zA-Z@]+\*?/, S.GENERAL],
    ]

    /**
     * LaTeX 的 Monarch 语法。
     *
     * token 名直接用 TextMate scope（见上面的 S），因此主题规则能精确命中。
     * 数学区进入独立状态，但**命令规则照样生效** —— VSCode 里公式中的
     * \frac 也是 support.function 色，不该被统一刷成一种颜色。
     */
    var LATEX_MONARCH = {
      defaultToken: '',
      tokenPostfix: '',
      brackets: [
        { open: '{', close: '}', token: S.GROUP_BEGIN },
        { open: '[', close: ']', token: S.OPT_BEGIN },
        { open: '(', close: ')', token: 'punctuation.group.begin.latex' },
      ],
      tokenizer: {
        root: [
          [/%+.*$/, S.COMMENT],
          // 数学环境：整块统一标色。必须排在通用 \begin 之前，否则会被它先吃掉。
          // 注意只能给"整段一个 token"：Monaco 的对象形 action 里 token 必须是字符串，
          // 数组 token 与 next 不能共存（数组分支直接返回 {group}，next 被丢弃）。
          // 环境体内本来就整块同色，所以放弃分段上色没有视觉损失。
          [/\\begin(?:\s*)(?:\{(?:equation|align|aligned|alignat|gather|gathered|multline|eqnarray|split|displaymath|math|cases|array|[pbBvV]?matrix|flalign)(?:\*)?\})/,
            { token: S.MATH_ENV, next: '@mathEnv' }],
          // \begin{env} / \end{env}：命令、花括号、环境名分段着色
          [/(\\)(begin|end)(\s*)(\{)([^}]*)(\})/, [S.FN_PUNCT, S.BE, '', S.ARG_BEGIN, S.ENV, S.ARG_END]],
          // 下面几条必须排在 CMD_RULES 之前，否则会被兜底的 [\\][^a-zA-Z@] 当成转义：
          // 数学定界符 \[ \( 与换行符 \\ 都是双字符记号，优先级高于「反斜杠+任意符号」。
          [/\\\$/, S.ESCAPE],
          [/\\\\/, ''],
          [/\\\[/, { token: S.MATH_ENV, next: '@displayMathBracket' }],
          [/\\\(/, { token: S.MATH_ENV, next: '@inlineMathParen' }],
          [/\$\$/, { token: S.MATH_ENV, next: '@displayMath' }],
          [/\$/, { token: S.MATH, next: '@inlineMath' }],
        ].concat(CMD_RULES, [
          [/[{}]/, '@brackets'],
          [/\[/, S.OPT_BEGIN],
          [/\]/, S.OPT_END],
          // 正文里的数字不染色：VSCode 的 LaTeX 语法本来就没有 constant.numeric，
          // 满屏 11pt / 0.8 都变绿会盖过真正的语义。
          [/&/, S.TBL_CELL],
        ]),
        /**
         * 数学环境体：\begin{equation} … \end{equation}。
         * begin 用 @push、end 用 @pop，靠状态栈的深度处理 equation 里嵌 aligned 的情形；
         * 不用动态匹配环境名（Monarch 做不到回溯），代价是环境没闭合时会一直青到底 ——
         * 那种情况结构检查本来就会报「环境未闭合」。
         */
        mathEnv: [
          // 同样只能整段单 token：\end{env} 退一层、\begin{env} 压一层，
          // 靠栈深度处理 equation 里嵌 aligned；都不需要区分具体环境名。
          [/\\end(?:\s*)(?:\{[^}]*\})/, { token: S.MATH_ENV, next: '@pop' }],
          [/\\begin(?:\s*)(?:\{[^}]*\})/, { token: S.MATH_ENV, next: '@push' }],
          [/%+.*$/, S.COMMENT],
          [/\\\\/, S.EQ_NL],
        ].concat(CMD_RULES, [
          [/&/, S.EQ_ALIGN],
          // 兜底：块内所有普通字符（字母、数字、运算符、括号）统一走数学色
          [/[^\s\\$&]+/, S.MATH_ENV],
        ]),
        inlineMath: [
          [/\$/, { token: S.MATH, next: '@pop' }],
          [/%+.*$/, S.COMMENT],
          [/\\\\/, S.EQ_NL],
        ].concat(CMD_RULES, [
          [/&/, S.EQ_ALIGN],
          [/[^\s\\$&]+/, S.MATH],
        ]),
        displayMath: [
          [/\$\$/, { token: S.MATH_ENV, next: '@pop' }],
          [/%+.*$/, S.COMMENT],
          [/\\\\/, S.EQ_NL],
        ].concat(CMD_RULES, [
          [/&/, S.EQ_ALIGN],
          [/[^\s\\$&]+/, S.MATH_ENV],
        ]),
        inlineMathParen: [
          [/\\\)/, { token: S.MATH_ENV, next: '@pop' }],
          [/%+.*$/, S.COMMENT],
          [/\\\\/, S.EQ_NL],
        ].concat(CMD_RULES, [
          [/&/, S.EQ_ALIGN],
          [/[^\s\\$&]+/, S.MATH_ENV],
        ]),
        displayMathBracket: [
          [/\\\]/, { token: S.MATH_ENV, next: '@pop' }],
          [/%+.*$/, S.COMMENT],
          [/\\\\/, S.EQ_NL],
        ].concat(CMD_RULES, [
          [/&/, S.EQ_ALIGN],
          [/[^\s\\$&]+/, S.MATH_ENV],
        ]),
      },
    }

    /** Monarch 是否注册成功。失败时不能把 .tex 切到 latex，否则会变成无 token 的白板。 */
    var latexSyntaxReady = false

    function registerLatexLanguage(m) {
      try {
        var known = false
        try {
          known = (m.languages.getLanguages() || []).some(function (l) { return l.id === LATEX_LANG })
        } catch (error) { known = false }
        if (!known) {
          m.languages.register({
            id: LATEX_LANG,
            extensions: ['.tex', '.sty', '.cls', '.ltx'],
            aliases: ['LaTeX', 'TeX'],
          })
        }
        m.languages.setLanguageConfiguration(LATEX_LANG, {
          comments: { lineComment: '%' },
          brackets: [['{', '}'], ['[', ']'], ['(', ')']],
          autoClosingPairs: [
            { open: '{', close: '}' }, { open: '[', close: ']' },
            { open: '(', close: ')' }, { open: '$', close: '$' },
          ],
          surroundingPairs: [
            { open: '{', close: '}' }, { open: '[', close: ']' }, { open: '(', close: ')' },
          ],
        })
      } catch (error) {
        report('error', 'LaTeX 语言注册失败：' + errText(error))
        return
      }
      // Monarch 编译错误只有到这一步才会抛（例如 action 形参不合法）。
      // 单独捕获：注册失败就把已切过去的模型退回纯文本，
      // 宁可没有高亮，也不能让整篇变成无 token 的白板。
      try {
        m.languages.setMonarchTokensProvider(LATEX_LANG, LATEX_MONARCH)
        latexSyntaxReady = true
        report('info', 'LaTeX 语法已注册（Monarch，' + ALL_SCOPES.length + ' 个 TextMate scope）')
      } catch (error) {
        latexSyntaxReady = false
        report('error', 'LaTeX 语法注册失败，退回纯文本：' + errText(error))
        try {
          m.editor.getModels().forEach(function (model) {
            if (model.getLanguageId() === LATEX_LANG) m.editor.setModelLanguage(model, 'plaintext')
          })
        } catch (error2) { /* 遍历失败不影响主流程 */ }
      }
    }

    // --region VSCode 配色

    var themeSeq = 0
    var themeData = null
    var themeTimer = null
    var themeApplied = ''
    var themeRetouched = false

    /** 内置兜底色板：读不到 VSCode 时用，接近 VSCode Dark+ / Light+ 的经典配色。 */
    var FALLBACK = {
      light: {
        comment: '008000', keyword: 'AF00DB', storage: '0000FF',
        support: '795E26', class: '267F99', variable: '001080',
        constant: '098658', escape: 'EE0000',
      },
      dark: {
        comment: '6A9955', keyword: 'C586C0', storage: '569CD6',
        support: 'DCDCAA', class: '4EC9B0', variable: '9CDCFE',
        constant: 'B5CEA8', escape: 'D7BA7D',
      },
    }

    /** 按 scope 的主类回落取色。 */
    function fallbackColorOf(scope, dark) {
      var table = dark ? FALLBACK.dark : FALLBACK.light
      if (/^comment/.test(scope)) return table.comment
      if (/^keyword/.test(scope)) return table.keyword
      if (/^storage/.test(scope)) return table.storage
      if (/^support\.class|^support\.type/.test(scope)) return table.class
      if (/^support/.test(scope)) return table.support
      if (/^variable/.test(scope)) return table.variable
      if (/^constant\.character\.escape/.test(scope)) return table.escape
      if (/^constant/.test(scope)) return table.constant
      if (/^punctuation|^meta/.test(scope)) return null
      return null
    }

    /** 探测 DSH 界面明暗（与 vscode-mode 的判定口径一致）。 */
    function dshIsDark() {
      try {
        var official = document.body.getAttribute('data-ds-dark-theme')
        if (official !== null && official !== undefined && official !== 'false') return true
        var attr = document.documentElement.getAttribute('data-theme')
          || document.body.getAttribute('data-theme')
        var v = String(attr || '').toLowerCase()
        if (v.indexOf('light') >= 0 || v.indexOf('latte') >= 0) return false
        if (v.indexOf('dark') >= 0 || v.indexOf('mocha') >= 0 || v.indexOf('frappe') >= 0) return true
        if (typeof window.matchMedia === 'function') {
          return !window.matchMedia('(prefers-color-scheme: light)').matches
        }
      } catch (error) { /* 探测失败按暗色 */ }
      return true
    }

    /**
     * 用 VSCode 主题的 tokenColors 重建 Monaco 主题。
     *
     * 只加规则不换基础色板是不够的：Monaco 的主题是全局的，一旦 setTheme，
     * 其它语言会退回 base 的默认配色。所以这里把整个主题的规则都带上，
     * 让 JS/Python 也保持 VSCode 的观感，只有 latex 那一批 scope 是精确求值过的。
     * @param m Monaco 实例
     */
    function applyVscodeTheme(m) {
      if (!m || !m.editor || typeof m.editor.defineTheme !== 'function') return
      var dark = dshIsDark()
      rpc('vscodeTheme', { scopes: ALL_SCOPES }).then(function (res) {
        var data = res && res.data
        if (!res || res.ok !== true || !data || data.ok !== true) {
          var why = (data && data.error) || (res && res.error) || '未知原因'
          report('warn', '读取 VSCode 配色失败，改用内置色板：' + why)
          applyFallbackTheme(m, dark, res)
          return
        }
        themeData = data
        buildAndApply(m, data)
        // vscode-mode 在「Monaco 加载完成」和「编辑器视图挂载」时各 setTheme 一次，
        // 时序可能压在我们后面。补套一次，确保最终生效（幂等，只是新 id）。
        if (!themeRetouched) {
          themeRetouched = true
          setTimeout(function () {
            if (!themeData) return
            report('info', '补套配色（避免被 vscode-mode 的延迟 setTheme 覆盖）')
            buildAndApply(m, themeData, true)
          }, 2600)
        }
      }).catch(function (error) {
        report('warn', '读取 VSCode 配色异常，改用内置色板：' + errText(error))
        applyFallbackTheme(m, dark, null)
      })
    }

    /** 把宿主返回的主题数据套到 Monaco 上。 */
    function buildAndApply(m, data, quiet) {
      var rules = []
      var all = data.rules || []
      for (var i = 0; i < all.length; i++) {
        var r = all[i]
        var rule = { token: r.token || '' }
        if (r.foreground) rule.foreground = r.foreground
        if (r.fontStyle) rule.fontStyle = r.fontStyle
        rules.push(rule)
      }
      // 精确求值过的 latex 规则放在最后：token 更长更具体，不会被前面的覆盖
      var sc = data.scopes || {}
      var hit = 0
      for (var k in sc) {
        if (!Object.prototype.hasOwnProperty.call(sc, k)) continue
        var v = sc[k]
        var rule2 = { token: k }
        if (v.fg) { rule2.foreground = v.fg; hit++ }
        if (v.fontStyle) rule2.fontStyle = v.fontStyle
        if (rule2.foreground || rule2.fontStyle) rules.push(rule2)
      }
      // 明暗不一致时只取 token 规则，不套背景：
      // 否则浅色主题会把深色界面的编辑器刷成白底，比配色不统一更难用。
      var same = (data.type === 'light') === !dshIsDark()
      var colors = data.colors || {}
      if (!same) {
        var keep = {}
        for (var ck in colors) {
          if (!Object.prototype.hasOwnProperty.call(colors, ck)) continue
          if (ck.indexOf('editorBracket') === 0) keep[ck] = colors[ck]
        }
        colors = keep
      }
      var id = 'dmz-vscode-' + (++themeSeq)
      try {
        m.editor.defineTheme(id, {
          base: data.type === 'light' ? 'vs' : 'vs-dark',
          inherit: true,
          rules: rules,
          colors: colors,
        })
        m.editor.setTheme(id)
        themeApplied = data.name + '（' + data.type + '）'
        if (quiet) return
        report('info', '已套用 VSCode 配色：' + themeApplied
          + ' · 规则 ' + rules.length + ' 条 · latex 命中 ' + hit + '/' + data.scopeCount
          + ' · 背景 ' + (data.background || '?')
          + ' · DSH 界面 ' + (dshIsDark() ? '暗色' : '浅色')
          + (same ? '' : '（与 VSCode 主题明暗不一致，已跳过背景色）'))
      } catch (error) {
        report('error', '套用 VSCode 配色失败：' + errText(error))
        applyFallbackTheme(m, dshIsDark(), null)
      }
    }

    /** 没有 VSCode 时的兜底：按内置色板生成一条最小规则集。 */
    function applyFallbackTheme(m, dark, res) {
      var rules = []
      for (var i = 0; i < ALL_SCOPES.length; i++) {
        var scope = ALL_SCOPES[i]
        var fg = fallbackColorOf(scope, dark)
        if (!fg) continue
        rules.push({ token: scope, foreground: fg })
      }
      var id = 'dmz-vscode-fallback-' + (++themeSeq)
      try {
        m.editor.defineTheme(id, {
          base: dark ? 'vs-dark' : 'vs',
          inherit: true,
          rules: rules,
          colors: {},
        })
        m.editor.setTheme(id)
        themeApplied = '内置色板（' + (dark ? '暗' : '浅') + '）'
        report('info', '已套用内置色板：' + rules.length + ' 条规则'
          + (res && res.roots ? '；探测到 VSCode 根目录 ' + JSON.stringify(res.roots) : ''))
      } catch (error) { report('error', '套用内置色板失败：' + errText(error)) }
    }

    /**
     * 宿主皮肤切换时 vscode-mode 会重新 setTheme，把我们的覆盖掉。
     * 盯住 body 的明暗标记，变了就重新套用一次（节流）。
     */
    function watchSchemeChange(m) {
      function kick() {
        if (themeTimer) clearTimeout(themeTimer)
        themeTimer = setTimeout(function () {
          themeTimer = null
          applyVscodeTheme(m)
        }, 600)
      }
      try {
        if (typeof MutationObserver !== 'function') return
        var ob = new MutationObserver(kick)
        // 只盯明暗标记，不盯 class：class 变动太频繁，会反复重套主题。
        ob.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme'] })
        if (document.documentElement) {
          ob.observe(document.documentElement, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'data-theme'] })
        }
        report('info', '已监听界面明暗变化，切换皮肤后会自动重套配色')
      } catch (error) { report('error', '监听明暗变化失败：' + errText(error)) }
    }

    // --endregion

    /**
     * vscode-mode 的扩展名映射表里没有 tex，.tex 会落到 plaintext。
     * 这里把已有和新建的 tex model 逐一改成 latex，并挂上 lint 触发。
     */
    function syncTexModels(m) {
      try {
        var models = m.editor.getModels()
        for (var i = 0; i < models.length; i++) {
          var model = models[i]
          var uri = model.uri || {}
          var p = String(uri.path || uri.fsPath || '')
          if (!/\.(tex|sty|cls|ltx)$/i.test(p)) continue
          var cur = model.getLanguageId()
          if (cur !== LATEX_LANG && latexSyntaxReady) {
            m.editor.setModelLanguage(model, LATEX_LANG)
            report('info', '切换语法：' + p.split('/').pop() + '（' + cur + ' → ' + LATEX_LANG + '）')
          }
          if (!model.__dmzLintBound) {
            model.__dmzLintBound = true
            // 必须用 IIFE 捕获当前 model：var 在 for 里共享作用域，
            // 直接闭包会让所有回调都指向循环结束时的最后一个 model。
            ;(function (target) {
              target.onDidChangeContent(function () { scheduleLint(target) })
            })(model)
          }
        }
        syncWorkbenchTabLanguages(m)
      } catch (error) { report('error', '同步 tex model 失败：' + errText(error)) }
    }

    /**
     * 工作台标签的 model 是 inmemory URI，没有 `.tex` 后缀，上面那段按路径匹配的
     * 逻辑一律跳过它们。若标签是在语法注册**之前**打开的（`adoptWorkbenchModel`
     * 那一刻 `latexSyntaxReady` 还是 false），它就会永远是纯文本 —— 这里按标签自己的
     * relPath 补一遍。
     *
     * 只在语言真的发生变化时才补一次 lint：这段被 4 秒定时器反复调用，
     * 无条件 re-lint 会让每个后台标签每 4 秒重算一遍结构检查。
     */
    function syncWorkbenchTabLanguages(m) {
      if (!latexSyntaxReady || !state.wbTabs.length) return
      for (var i = 0; i < state.wbTabs.length; i++) {
        var tab = state.wbTabs[i]
        if (!tab.model || !isTexPath(tab.relPath)) continue
        var lang = ''
        try { lang = tab.model.getLanguageId() } catch (error) { continue }
        if (lang === LATEX_LANG) continue
        try {
          m.editor.setModelLanguage(tab.model, LATEX_LANG)
          report('info', '切换语法：' + tab.name + '（' + lang + ' → ' + LATEX_LANG + '）')
        } catch (error) { continue }
        scheduleLint(tab.model)
      }
    }

    /**
     * 编辑器基础选项：括号配对配色 + 行号。
     *
     * 行号其实 Monaco 默认就是 on，vscode-mode 也没关过，这里显式写死是兜底：
     * 编译错误定位、结构检查、`\ref` 预览的「第 N 行」全靠行号，
     * 哪天默认值或别的插件把它关掉会很难排查。
     */
    var EDITOR_OPTS = {
      bracketPairColorization: { enabled: true },
      lineNumbers: 'on',
      lineNumbersMinChars: 3,
    }

    function enableBracketColors(m) {
      var opts = EDITOR_OPTS
      try {
        var eds = m.editor.getEditors()
        for (var i = 0; i < eds.length; i++) {
          try { eds[i].updateOptions(opts) } catch (error) { /* 已销毁 */ }
        }
        m.editor.onDidCreateEditor(function (ed) {
          try { ed.updateOptions(opts) } catch (error) { /* 已销毁 */ }
        })
        report('info', '编辑器选项已应用（行号 on · 括号配对配色）')
      } catch (error) { report('error', '设置编辑器选项失败：' + errText(error)) }
    }

    // --region 结构检查

    /**
     * 逐字符扫描 tex，找出括号/环境/数学符的结构问题。
     * 只报确定的问题，不做命令词典校验（误报率太高，反而干扰写作）。
     * @param text 全文
     * @returns 问题列表 [{ line, col, message, severity }]
     */
    function lintTex(text) {
      var out = []
      var lines = String(text || '').split(/\r?\n/)
      if (lines.length > 20000) return out
      var braceStack = []
      var envStack = []
      var mathOpen = null

      for (var li = 0; li < lines.length; li++) {
        var line = lines[li]
        var n = line.length
        for (var ci = 0; ci < n; ci++) {
          var ch = line[ci]
          if (ch === '%') break
          if (ch === '\\') {
            var next = line[ci + 1] || ''
            if (next === '{' || next === '}' || next === '$' || next === '%' || next === '\\') {
              ci++
              continue
            }
            var rest = line.slice(ci)
            if (next === 'b' || next === 'e') {
              var mEnv = (next === 'b' ? /^\\begin\s*\{([^}]*)\}/ : /^\\end\s*\{([^}]*)\}/).exec(rest)
              if (mEnv) {
                if (next === 'b') {
                  envStack.push({ env: mEnv[1], line: li + 1, col: ci + 1 })
                } else {
                  var top = envStack.pop()
                  if (!top) {
                    out.push({ line: li + 1, col: ci + 1, message: '\\end{' + mEnv[1] + '} 没有对应的 \\begin', severity: 'warning' })
                  } else if (top.env !== mEnv[1]) {
                    out.push({
                      line: li + 1, col: ci + 1, severity: 'warning',
                      message: '环境不匹配：第 ' + top.line + ' 行的 \\begin{' + top.env + '} 与此处 \\end{' + mEnv[1] + '}',
                    })
                  }
                }
                ci += mEnv[0].length - 1
                continue
              }
            }
            if (/[a-zA-Z@]/.test(next)) {
              var j = ci + 1
              while (j < n && /[a-zA-Z@]/.test(line[j])) j++
              ci = j - 1
              continue
            }
            ci++
            continue
          }
          if (ch === '{') { braceStack.push({ line: li + 1, col: ci + 1 }); continue }
          if (ch === '}') {
            if (!braceStack.length) out.push({ line: li + 1, col: ci + 1, message: '多余的 }', severity: 'warning' })
            else braceStack.pop()
            continue
          }
          if (ch === '$') {
            var isDD = line[ci + 1] === '$'
            if (!mathOpen) mathOpen = { line: li + 1, col: ci + 1, display: isDD }
            else if (isDD === mathOpen.display) mathOpen = null
            if (isDD) ci++
          }
        }
      }

      for (var b = 0; b < braceStack.length && b < 20; b++) {
        out.push({ line: braceStack[b].line, col: braceStack[b].col, message: '{ 未闭合', severity: 'warning' })
      }
      for (var e = 0; e < envStack.length && e < 20; e++) {
        out.push({ line: envStack[e].line, col: envStack[e].col, message: '\\begin{' + envStack[e].env + '} 未闭合', severity: 'warning' })
      }
      if (mathOpen) {
        out.push({ line: mathOpen.line, col: mathOpen.col, message: '数学公式未闭合（缺少 ' + (mathOpen.display ? '$$' : '$') + '）', severity: 'warning' })
      }
      return out
    }

    function modelKey(model) {
      // 工作台模型是 inmemory URI，没有文件名，用它所属标签的 basename 代它
      // （诊断桶按 basename 归并，编译错误的 key 也是 basename）
      if (model && model.__dmzTab) return model.__dmzTab.name
      if (wbModel && model === wbModel && state.wbFile) return state.wbFile.name
      try {
        var p = String((model.uri && (model.uri.path || model.uri.fsPath)) || '')
        return p.split('/').pop() || ''
      } catch (error) { return '' }
    }

    function bucketOf(key) {
      if (!diagStore[key]) diagStore[key] = { lint: [], compile: [] }
      return diagStore[key]
    }

    /** 合并「编译错误（红）」与「结构问题（黄）」写入模型标记。 */
    function applyDiagnostics(m, model, key) {
      if (!m || !model) return
      var bucket = bucketOf(key)
      var markers = []
      ;(bucket.compile || []).forEach(function (e) {
        var line = Math.max(1, Number(e.line) || 1)
        var endCol = 1
        try { endCol = Math.max(2, model.getLineMaxColumn(Math.min(line, model.getLineCount()))) } catch (error) { endCol = 1 }
        markers.push({
          severity: m.MarkerSeverity.Error,
          message: e.message || '编译错误',
          source: 'latexmk',
          startLineNumber: line, startColumn: 1,
          endLineNumber: line, endColumn: endCol,
        })
      })
      ;(bucket.lint || []).forEach(function (w) {
        var line = Math.max(1, Number(w.line) || 1)
        var col = Math.max(1, Number(w.col) || 1)
        markers.push({
          severity: m.MarkerSeverity.Warning,
          message: w.message,
          source: 'latex-structure',
          startLineNumber: line, startColumn: col,
          endLineNumber: line, endColumn: col + 1,
        })
      })
      try { m.editor.setModelMarkers(model, 'dmzlatex', markers) } catch (error) { /* 模型已销毁 */ }
      applyGutterMarks(m, model, bucket)
    }

    var gutterStyleInjected = false

    /** 行号右侧色条的样式（只注入一次）。 */
    function injectGutterStyle() {
      if (gutterStyleInjected) return
      gutterStyleInjected = true
      try {
        var s = document.createElement('style')
        s.setAttribute('data-dmz-latex-gutter', '1')
        s.textContent = '.dsh-latex-err-gutter{width:4px !important;margin-left:4px;'
          + 'border-radius:2px;background:#f14c4c}'
          + '.dsh-latex-warn-gutter{width:4px !important;margin-left:4px;'
          + 'border-radius:2px;background:#cca700}'
        ;(document.head || document.documentElement).appendChild(s)
      } catch (error) { /* 注入失败不影响波浪线 */ }
    }

    /**
     * 在行号右侧的装饰区给有问题的行加色条。
     *
     * 波浪线只贴在文字下面，长文档翻页时不容易注意到；行号栏有标记，
     * 一眼就能看出「哪几行有错」。红=编译错误，黄=结构问题。
     * 编译成功时传入的 bucket 为空，色条随之清空。
     * @param m Monaco 实例
     * @param model 目标模型
     * @param bucket { compile, lint }
     */
    function applyGutterMarks(m, model, bucket) {
      if (!m || typeof m.Range !== 'function') return
      injectGutterStyle()
      var errLines = {}
      var warnLines = {}
      var errMsg = {}
      var warnMsg = {}
      ;(bucket.compile || []).forEach(function (e) {
        var ln = Math.max(1, Number(e.line) || 1)
        errLines[ln] = true
        if (!errMsg[ln]) errMsg[ln] = String(e.message || '编译错误')
      })
      ;(bucket.lint || []).forEach(function (w) {
        var ln = Math.max(1, Number(w.line) || 1)
        if (errLines[ln]) return
        warnLines[ln] = true
        if (!warnMsg[ln]) warnMsg[ln] = String(w.message || '')
      })
      var next = []
      for (var a in errLines) {
        if (!Object.prototype.hasOwnProperty.call(errLines, a)) continue
        next.push({
          range: new m.Range(Number(a), 1, Number(a), 1),
          options: {
            isWholeLine: false,
            linesDecorationsClassName: 'dsh-latex-err-gutter',
            hoverMessage: { value: '**编译错误**\n\n' + errMsg[a] },
          },
        })
      }
      for (var b in warnLines) {
        if (!Object.prototype.hasOwnProperty.call(warnLines, b)) continue
        next.push({
          range: new m.Range(Number(b), 1, Number(b), 1),
          options: {
            isWholeLine: false,
            linesDecorationsClassName: 'dsh-latex-warn-gutter',
            hoverMessage: { value: warnMsg[b] },
          },
        })
      }
      var eds = []
      try { eds = m.editor.getEditors() } catch (error) { return }
      for (var i = 0; i < eds.length; i++) {
        var ed = eds[i]
        var cur = null
        try { cur = ed.getModel() } catch (error) { continue }
        if (cur !== model) continue
        try {
          ed.__dmzGutterDecos = ed.deltaDecorations(ed.__dmzGutterDecos || [], next)
        } catch (error) { /* 编辑器已销毁 */ }
      }
    }

    function scheduleLint(model) {
      // 打开的是 md / bib 等非 LaTeX 文档时不做结构检查（否则 `{` `$` 会满屏误报）
      var owner = model && model.__dmzTab
      if (owner && !isTexPath(owner.relPath)) return
      if (!owner && model === wbModel && state.wbFile && !isTexPath(state.wbFile.relPath)) return
      var key = modelKey(model)
      if (!key) return
      if (lintTimers[key]) clearTimeout(lintTimers[key])
      lintTimers[key] = setTimeout(function () {
        lintTimers[key] = null
        try {
          var text = model.getValue()
          if (!text || text.length > 400000) return
          var issues = lintTex(text)
          bucketOf(key).lint = issues
          applyDiagnostics(monacoApi, model, key)
        } catch (error) { report('error', '结构检查失败：' + errText(error)) }
      }, 450)
    }

    /** 编译结果落到标记上：errors 为空即清除红波浪线。 */
    function recordCompileDiagnostics(texRel, errors) {
      if (!monacoApi) return
      var key = baseName(texRel)
      var bucket = bucketOf(key)
      bucket.compile = []
      ;(errors || []).forEach(function (e) {
        var f = String(e.file || '').replace(/\\/g, '/')
        var fb = f.split('/').pop()
        // 只保留当前文件的错误；子文件错误留给该文件自己的诊断
        if (f && fb && fb !== key) return
        bucket.compile.push({ line: e.line, message: e.message })
      })
      var model = null
      try {
        var models = monacoApi.editor.getModels()
        for (var i = 0; i < models.length; i++) {
          if (modelKey(models[i]) === key) { model = models[i]; break }
        }
      } catch (error) { model = null }
      if (model) applyDiagnostics(monacoApi, model, key)
      report('info', '编译诊断：' + bucket.compile.length + ' 条红标（' + key + '）')
    }

    // --endregion

    // --region 公式悬停预览

    var katexLoading = null
    /**
     * 加载 KaTeX：运行时 + 样式一次取回，字体已在宿主侧内联成 data URI。
     * 用完整 HTML 输出（默认 htmlAndMathml），排版与网页/VS Code 一致；
     * 早先用 MathML 是为了免字体，但字距与上下标会走样。
     */
    function loadKatex() {
      if (window.katex) return Promise.resolve(window.katex)
      if (katexLoading) return katexLoading
      katexLoading = rpc('readKatex', {})
        .then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || '宿主未返回 katex')
          var data = res.data || {}
          if (!document.getElementById('dmz-katex-css') && data.css) {
            var style = document.createElement('style')
            style.id = 'dmz-katex-css'
            style.textContent = data.css
            document.head.appendChild(style)
          }
          var s = document.createElement('script')
          s.setAttribute('data-dmz-katex', '1')
          s.textContent = data.js || ''
          document.head.appendChild(s)
          if (!window.katex) throw new Error('katex 未挂载到 window')
          report('info', 'katex 已加载 v' + (window.katex.version || '?')
            + '（内联字体 ' + data.fonts + ' 个，残留引用 ' + data.leftover + '，CSS ' + data.cssBytes + ' 字节）')
          // 等字体解码完成再渲染：否则首帧会用回退字体，字形宽度不同导致排版跳变
          return new Promise(function (resolve) {
            var done = false
            function finish() { if (!done) { done = true; resolve(window.katex) } }
            try {
              document.fonts.ready.then(finish).catch(finish)
            } catch (error) { finish() }
            setTimeout(finish, 1200)
          })
        })
        .catch(function (error) {
          katexLoading = null
          report('error', 'katex 加载失败：' + errText(error))
          throw error
        })
      return katexLoading
    }

    /** KaTeX 认识的数学环境（外层环境名，用于判断「进入公式」）。 */
    var MATH_ENVS = [
      'equation', 'equation*', 'displaymath', 'math',
      'align', 'align*', 'flalign', 'flalign*', 'alignat', 'alignat*',
      'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*',
      'split', 'aligned', 'alignedat', 'gathered',
      'cases', 'matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix',
      'smallmatrix', 'array',
    ]

    /**
     * 全文扫描公式区间。
     *
     * 早先只扫单行，所以只有 `$...$` / `$$...$$` 能命中；`\[...\]` 和
     * `\begin{equation}...\end{equation}` 几乎总是跨行书写，必须扫全文。
     * 定界符本身不跨行，因此逐字符走一遍、用 pending 状态配对即可。
     *
     * @param text 全文
     * @returns 区间列表 [{ startLine, startCol, endLine, endCol, tex, env, display }]
     */
    function scanMathRegions(text) {
      var regions = []
      var n = text.length

      var lineStarts = [0]
      for (var k = 0; k < n; k++) if (text.charCodeAt(k) === 10) lineStarts.push(k + 1)
      function posOf(offset) {
        var lo = 0
        var hi = lineStarts.length - 1
        while (lo < hi) {
          var mid = (lo + hi + 1) >> 1
          if (lineStarts[mid] <= offset) lo = mid
          else hi = mid - 1
        }
        return { line: lo + 1, col: offset - lineStarts[lo] + 1 }
      }

      var open = null
      function closeAt(o, endOffset, delimLen) {
        var raw = text.slice(o.start, endOffset)
        if (!raw.trim()) return
        var sp = posOf(o.mark)
        var ep = posOf(endOffset + delimLen)
        regions.push({
          startLine: sp.line, startCol: sp.col,
          endLine: ep.line, endCol: ep.col,
          tex: raw,
          env: o.env || '',
          display: o.kind !== 'dollar' && o.kind !== 'paren',
        })
      }

      var i = 0
      while (i < n) {
        var ch = text[i]
        if (ch === '\n') { i++; continue }
        if (ch === '%') {
          while (i < n && text[i] !== '\n') i++
          continue
        }
        if (ch === '\\') {
          var nx = text[i + 1] || ''
          if (nx === '$' || nx === '%' || nx === '{' || nx === '}' || nx === '\\'
            || nx === '&' || nx === '_' || nx === '#') {
            i += 2
            continue
          }
          if (nx === '[') {
            if (!open) { open = { kind: 'bracket', start: i + 2, mark: i }; i += 2; continue }
            i += 2
            continue
          }
          if (nx === ']') {
            if (open && open.kind === 'bracket') { closeAt(open, i, 2); open = null }
            i += 2
            continue
          }
          if (nx === '(') {
            if (!open) { open = { kind: 'paren', start: i + 2, mark: i }; i += 2; continue }
            i += 2
            continue
          }
          if (nx === ')') {
            if (open && open.kind === 'paren') { closeAt(open, i, 2); open = null }
            i += 2
            continue
          }
          if (nx === 'b' || nx === 'e') {
            var mEnv = /^\\(begin|end)\s*\{([^}]*)\}/.exec(text.slice(i, i + 120))
            if (mEnv) {
              var envName = mEnv[2].trim()
              if (mEnv[1] === 'begin') {
                if (!open && MATH_ENVS.indexOf(envName) >= 0) {
                  open = { kind: 'env', env: envName, start: i + mEnv[0].length, mark: i }
                }
              } else if (open && open.kind === 'env' && open.env === envName) {
                closeAt(open, i, mEnv[0].length)
                open = null
              }
              i += mEnv[0].length
              continue
            }
          }
          if (/[a-zA-Z@]/.test(nx)) {
            var j = i + 1
            while (j < n && /[a-zA-Z@]/.test(text[j])) j++
            i = j
            continue
          }
          i += 2
          continue
        }
        if (ch === '$') {
          if (text[i + 1] === '$') {
            if (!open) { open = { kind: 'ddollar', start: i + 2, mark: i }; i += 2; continue }
            if (open.kind === 'ddollar') { closeAt(open, i, 2); open = null; i += 2; continue }
            i += 2
            continue
          }
          if (!open) { open = { kind: 'dollar', start: i + 1, mark: i }; i++; continue }
          if (open.kind === 'dollar') { closeAt(open, i, 1); open = null; i++; continue }
          i++
          continue
        }
        i++
      }
      return regions
    }

    var mathCache = { key: '', version: -1, regions: [] }

    function getMathRegions(model) {
      var key = ''
      try { key = String((model.uri && (model.uri.path || model.uri.fsPath)) || '') } catch (error) { key = '' }
      var version = 0
      try { version = model.getVersionId() } catch (error) { version = 0 }
      if (mathCache.key === key && mathCache.version === version) return mathCache.regions
      var regions = []
      try {
        var text = model.getValue()
        if (text && text.length <= 400000) regions = scanMathRegions(text)
      } catch (error) { regions = [] }
      mathCache = { key: key, version: version, regions: regions }
      return regions
    }

    /**
     * 把 AMS 环境转成 KaTeX 认识的写法。
     * KaTeX 没有 align/gather/multline 这些外层环境，要换成内部形式，
     * 否则 throwOnError=false 时会整段渲染成红字。
     */
    function formulaOf(region) {
      var body = String(region.tex || '')
        .replace(/\\label\s*\{[^}]*\}/g, '')
        .replace(/\\(nonumber|notag)\b/g, '')
      var env = String(region.env || '')
      if (!env) return body
      var wrapped = {
        'align': 'aligned', 'align*': 'aligned',
        'flalign': 'aligned', 'flalign*': 'aligned',
        'alignat': 'aligned', 'alignat*': 'aligned',
        'eqnarray': 'aligned', 'eqnarray*': 'aligned',
        'split': 'aligned',
        'gather': 'gathered', 'gather*': 'gathered',
        'multline': 'gathered', 'multline*': 'gathered',
      }[env]
      if (wrapped) return '\\begin{' + wrapped + '}' + body + '\\end{' + wrapped + '}'
      if (env === 'equation' || env === 'equation*' || env === 'displaymath' || env === 'math') return body
      return body
    }

    /** 光标落在哪个公式区间内。 */
    function findMathAt(model, position) {
      var regions = getMathRegions(model)
      var ln = position.lineNumber
      var col = position.column
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i]
        if (ln < r.startLine || ln > r.endLine) continue
        if (ln === r.startLine && col < r.startCol) continue
        if (ln === r.endLine && col > r.endCol) continue
        return r
      }
      return null
    }

    // --region \ref 悬停预览

    var labelCache = { key: '', version: -1, index: null, reported: 0 }

    /**
     * 扫全文建立 \label 索引。
     *
     * 一遍走完，同时维护环境栈与「最近的章节标题」：
     *  - 环境栈回答「这个 label 落在哪个 equation / figure / table 里」
     *  - 最近章节给出上下文标题
     * label 所在环境的结束行要等栈弹出才知道，所以先挂在栈顶，弹出时回填。
     *
     * @param model Monaco 文本模型
     * @returns { byKey, count }
     */
    function buildLabelIndex(model) {
      var text = ''
      try { text = model.getValue() } catch (error) { return { byKey: {}, count: 0 } }
      var byKey = {}
      var count = 0
      var stack = []
      var section = ''
      var sectionLine = 0
      var sections = []
      var re = /\\(begin|end)\s*\{([^}]*)\}|\\label\s*\{([^}]*)\}|\\((?:sub){0,2}section|chapter|part|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
      var m
      while ((m = re.exec(text))) {
        var p = model.getPositionAt(m.index)
        if (m[1]) {
          if (m[1] === 'begin') {
            stack.push({ env: String(m[2] || '').trim(), startLine: p.lineNumber, items: [] })
          } else if (stack.length) {
            var top = stack.pop()
            for (var i = 0; i < top.items.length; i++) {
              var it = top.items[i]
              if (it.env) continue
              it.env = top.env
              it.envStartLine = top.startLine
              it.envEndLine = p.lineNumber
            }
          }
        } else if (m[3] !== undefined) {
          var key = m[3].trim()
          if (!key) continue
          var entry = {
            key: key,
            line: p.lineNumber,
            section: section,
            sectionLine: sectionLine,
            env: '',
            envStartLine: 0,
            envEndLine: 0,
          }
          if (stack.length) stack[stack.length - 1].items.push(entry)
          byKey[key] = entry
          count++
        } else if (m[4] !== undefined) {
          // m[4] 是命令名（section / subsection …），m[5] 才是标题正文
          section = m[5].trim()
          sectionLine = p.lineNumber
          sections.push({ line: sectionLine, level: sectionLevelOf(m[4]) })
        }
      }
      // 环境没写 \end（写作中途的常态）也要能给出所属环境
      for (var s = 0; s < stack.length; s++) {
        for (var j = 0; j < stack[s].items.length; j++) {
          var e2 = stack[s].items[j]
          if (e2.env) continue
          e2.env = stack[s].env
          e2.envStartLine = stack[s].startLine
        }
      }
      // 章节跨度：一直延伸到下一个同级或更高级的标题。
      // 若只看下一个任意标题，`\section` 后面紧跟 `\subsection` 时范围只剩一两行，
      // 悬停 \ref{sec:xxx} 会只看到标题本身，等于没内容。
      var endByStart = {}
      for (var si = 0; si < sections.length; si++) {
        var cur = sections[si]
        var stop = 0
        for (var sj = si + 1; sj < sections.length; sj++) {
          if (sections[sj].level <= cur.level) { stop = sections[sj].line; break }
        }
        endByStart[cur.line] = stop ? stop - 1 : 0
      }
      for (var k2 in byKey) {
        if (!Object.prototype.hasOwnProperty.call(byKey, k2)) continue
        byKey[k2].sectionEndLine = endByStart[byKey[k2].sectionLine] || 0
      }
      return { byKey: byKey, count: count }
    }

    /** 标题层级：chapter 最高，subparagraph 最低，用于划定章节范围。 */
    function sectionLevelOf(cmd) {
      var c = String(cmd || '')
      if (c === 'chapter' || c === 'part') return 0
      if (c === 'subsubsection') return 3
      if (c === 'subsection') return 2
      if (c === 'subparagraph') return 5
      if (c === 'paragraph') return 4
      return 1
    }

    /** 取标签索引（按 model 版本缓存，编辑后才重扫）。 */
    function getLabelIndex(model) {
      var key = ''
      try { key = String((model.uri && (model.uri.path || model.uri.fsPath)) || '') } catch (error) { key = '' }
      var version = 0
      try { version = model.getVersionId() } catch (error) { version = 0 }
      if (labelCache.index && labelCache.key === key && labelCache.version === version) return labelCache.index
      var index = { byKey: {}, count: 0 }
      try { index = buildLabelIndex(model) } catch (error) { index = { byKey: {}, count: 0 } }
      var prev = labelCache.reported
      labelCache = { key: key, version: version, index: index, reported: prev }
      if (index.count !== prev) {
        labelCache.reported = index.count
        report('info', '标签索引：' + index.count + ' 个 \\label')
      }
      return index
    }

    /**
     * 判断光标是否落在某个交叉引用命令的花括号里。
     * 只认 *ref / cref 这一族；\cite 不走这条通道——label 索引里没有文献条目。
     * @param model 模型
     * @param position 光标位置
     * @returns { cmd, key, colStart, colEnd } 或 null
     */
    function findRefAt(model, position) {
      var line = ''
      try { line = model.getLineContent(position.lineNumber) } catch (error) { return null }
      if (line.indexOf('ref') < 0 && line.indexOf('Ref') < 0) return null
      var re = /\\([a-zA-Z]*[rR]ef)\*?(?:\[[^\]]*\])?\{([^}]*)\}/g
      var m
      while ((m = re.exec(line))) {
        var raw = m[2]
        var key = raw.trim()
        if (!key) continue
        var open = m.index + m[0].indexOf('{')
        // column 是 1 起算：'{' 之后第一个字符是 open+2
        var colStart = open + 2
        var colEnd = open + 1 + raw.length
        if (position.column >= colStart && position.column <= colEnd) {
          return { cmd: m[1], key: key, colStart: colStart, colEnd: colEnd }
        }
      }
      return null
    }

    /** 从主题里取某个 scope 的颜色，取不到用兜底值。 */
    function themeFg(scope, fallback) {
      try {
        var v = themeData && themeData.scopes && themeData.scopes[scope]
        if (v && v.fg) return '#' + v.fg
      } catch (error) { /* 主题还没就绪 */ }
      return fallback
    }

    /**
     * 取 label 所在环境的源码片段（限行数与字符数）。
     *
     * 三种取法，按「上下文有多具体」排序：
     *  1. label 在具体环境里（equation / figure / table …）→ 取整个环境
     *  2. label 直接挂在 document 下（常见于 \section 后面）→ 取本章开头
     *  3. 都没有 → 取 label 上下各 4 行
     * 环境跨度太大（超过 40 行）时不取环境，否则等于把半篇文章贴上来。
     */
    function snippetOf(model, entry) {
      var total = 0
      try { total = model.getLineCount() } catch (error) { return '' }
      var MAX_LINES = 18
      var a = 0
      var b = 0
      var envSpan = entry.envEndLine && entry.envStartLine ? entry.envEndLine - entry.envStartLine : 0
      var usableEnv = entry.env && entry.env !== 'document' && envSpan > 0 && envSpan <= 40
      if (usableEnv) {
        a = entry.envStartLine
        b = entry.envEndLine
      } else if (entry.sectionLine > 0 && entry.line - entry.sectionLine <= 60) {
        a = entry.sectionLine
        b = entry.sectionEndLine > a ? entry.sectionEndLine : Math.min(total, a + MAX_LINES - 1)
      } else {
        a = Math.max(1, entry.line - 4)
        b = Math.min(total, entry.line + 4)
      }
      if (b < a) b = a
      var originB = b
      if (b - a + 1 > MAX_LINES) {
        // label 靠后时围绕它截，别把真正想看的那行切掉
        if (entry.line - a > MAX_LINES - 3) a = Math.max(a, entry.line - 4)
        b = Math.min(b, a + MAX_LINES - 1)
      }
      var arr = []
      for (var i = a; i <= b; i++) {
        try { arr.push(model.getLineContent(i)) } catch (error) { /* 越界跳过 */ }
      }
      var text = arr.join('\n')
      if (text.length > 1400) text = text.slice(0, 1400) + '\n…'
      else if (b < originB) text += '\n…'
      return text
    }

    var refTipEl = null

    function ensureRefTip() {
      if (refTipEl) return refTipEl
      var el = document.createElement('div')
      el.className = 'dsh-latex-reftip'
      el.style.cssText = 'position:fixed;z-index:10001;display:none;padding:0;border-radius:8px;'
        + 'background:#fff;color:#1f1f1d;border:1px solid rgba(0,0,0,.14);'
        + 'box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto;'
        + 'font-size:12px;line-height:1.55;max-width:560px;box-sizing:border-box;overflow:hidden'
      el.addEventListener('mouseenter', function () { cancelHide() })
      el.addEventListener('mouseleave', function () { scheduleHide() })
      document.body.appendChild(el)
      refTipEl = el
      return el
    }

    /**
     * 显示 \ref 对应的 label 预览。
     * @param ref findRefAt 的结果
     * @param entry 标签索引里的条目
     * @param model 模型
     * @param clientX 鼠标 x
     * @param clientY 鼠标 y
     */
    function showRefTip(ref, entry, model, clientX, clientY) {
      var el = ensureRefTip()
      el.textContent = ''
      el.style.display = 'block'

      var head = document.createElement('div')
      head.style.cssText = 'padding:7px 11px 6px;border-bottom:1px solid rgba(0,0,0,.07);'
        + 'display:flex;gap:10px;align-items:baseline;white-space:nowrap;overflow:hidden'

      var name = document.createElement('span')
      name.textContent = '\\' + ref.cmd + '{' + ref.key + '}'
      name.style.cssText = 'font-family:ui-monospace,Consolas,monospace;font-size:12px;color:'
        + themeFg(S.REF, '#AF00DB')
      head.appendChild(name)

      var where = document.createElement('span')
      where.textContent = entry.env
        ? entry.env + ' · 第 ' + entry.line + ' 行'
        : '第 ' + entry.line + ' 行'
      where.style.cssText = 'color:#8a8a84;font-size:11px;margin-left:auto'
      head.appendChild(where)
      el.appendChild(head)

      if (entry.section) {
        var sec = document.createElement('div')
        sec.textContent = entry.section
        sec.style.cssText = 'padding:5px 11px 0;font-size:11px;color:#6b6b66;'
          + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
        el.appendChild(sec)
      }

      // 片段用默认前景色而不是命令色：这里展示的是源码原文，
      // 全篇刷成橄榄色反而分不清哪是命令哪是正文。
      var bodyFg = '#333333'
      try {
        if (themeData && themeData.foreground) bodyFg = '#' + themeData.foreground
      } catch (error) { /* 主题未就绪 */ }

      var pre = document.createElement('pre')
      pre.textContent = snippetOf(model, entry)
      pre.style.cssText = 'margin:6px 0 0;padding:6px 11px 10px;font-family:ui-monospace,Consolas,monospace;'
        + 'font-size:11.5px;line-height:1.5;color:' + bodyFg + ';'
        + 'white-space:pre;overflow:auto;max-height:240px;scrollbar-width:thin'
      el.appendChild(pre)

      var rect = el.getBoundingClientRect()
      var left = Math.min(Math.max(8, clientX + 14), Math.max(8, window.innerWidth - rect.width - 8))
      var top = clientY + 22
      if (top + rect.height > window.innerHeight - 8) top = Math.max(8, clientY - rect.height - 14)
      el.style.left = Math.round(left) + 'px'
      el.style.top = Math.round(top) + 'px'
      cancelHide()
    }

    // --endregion

    var tipEl = null
    var tipTimer = null
    var hideTimer = null
    var tipKey = ''

    function ensureTip() {
      if (tipEl) return tipEl
      var el = document.createElement('div')
      el.className = 'dsh-latex-mathtip'
      // pointer-events:auto —— 卡片要能接收滚轮和滚动条拖动
      el.style.cssText = 'position:fixed;z-index:10000;display:none;padding:10px 12px 6px;border-radius:8px;'
        + 'background:#fff;color:#1f1f1d;border:1px solid rgba(0,0,0,.14);'
        + 'box-shadow:0 6px 24px rgba(0,0,0,.18);pointer-events:auto;'
        + 'font-size:17px;line-height:1.3;max-width:none;box-sizing:border-box'
      el.addEventListener('mouseenter', function () { cancelHide() })
      el.addEventListener('mouseleave', function () { scheduleHide() })
      document.body.appendChild(el)
      tipEl = el
      return el
    }

    /** 立刻收起（公式卡片与 \ref 卡片共用一套计时器，同一时刻只显示一个）。 */
    function doHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
      tipKey = ''
      if (tipEl) tipEl.style.display = 'none'
      if (refTipEl) refTipEl.style.display = 'none'
    }

    function anyTipShown() {
      if (tipEl && tipEl.style.display !== 'none') return true
      if (refTipEl && refTipEl.style.display !== 'none') return true
      return false
    }

    /**
     * 延迟收起。鼠标从公式移向卡片的过程中会经过编辑器空白区，
     * 期间必然触到「不在公式上」，立即收起的话卡片永远够不着。
     */
    function scheduleHide() {
      if (!anyTipShown()) return
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(doHide, 420)
    }

    function cancelHide() {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
    }

    function scheduleTip(found, clientX, clientY) {
      if (tipTimer) clearTimeout(tipTimer)
      tipTimer = setTimeout(function () {
        tipTimer = null
        loadKatex().then(function (katex) {
          var el = ensureTip()
          el.style.display = 'block'
          el.textContent = ''

          // 超宽/超高一律靠滚动，不做等比缩小（用户要看原尺寸）
          var scroll = document.createElement('div')
          scroll.className = 'dsh-latex-mathtip-scroll'
          scroll.style.cssText = 'overflow:auto;scrollbar-width:thin;'
            + 'max-width:' + Math.max(240, window.innerWidth - 88) + 'px;'
            + 'max-height:' + Math.max(160, window.innerHeight - 128) + 'px'
          var inner = document.createElement('div')
          inner.style.cssText = 'display:inline-block;padding:2px 0 8px'
          scroll.appendChild(inner)
          el.appendChild(scroll)
          // 竖直滚轮转成横向滚动：公式是横向溢出的，竖着滚没意义
          scroll.addEventListener('wheel', function (e) {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && scroll.scrollWidth > scroll.clientWidth) {
              scroll.scrollLeft += e.deltaY
              e.preventDefault()
            }
          }, { passive: false })

          try {
            katex.render(formulaOf(found), inner, {
              displayMode: found.display,
              throwOnError: false,
              strict: 'ignore',
              trust: false,
            })
          } catch (error) {
            inner.textContent = '公式无法解析：' + errText(error)
          }

          var rect = el.getBoundingClientRect()
          var left = Math.min(Math.max(8, clientX + 14), Math.max(8, window.innerWidth - rect.width - 8))
          var top = clientY + 24
          if (top + rect.height > window.innerHeight - 8) top = Math.max(8, clientY - rect.height - 14)
          el.style.left = Math.round(left) + 'px'
          el.style.top = Math.round(top) + 'px'
          cancelHide()
          if (scroll.scrollWidth > scroll.clientWidth + 2) {
            report('info', '公式超宽，可横向拖动（' + scroll.scrollWidth + 'px / 视口 ' + scroll.clientWidth + 'px）')
          }
        }).catch(function () { doHide() })
      }, 260)
    }

    /** 悬停统一入口：先判 \ref，再判公式，两者互斥。 */
    function attachHover(ed) {
      if (!ed || ed.__dmzHoverBound) return
      ed.__dmzHoverBound = true
      var lastAt = 0
      ed.onMouseMove(function (e) {
        try {
          // 节流：mousemove 频率很高，每次扫整行在长行上会拖慢光标响应
          var now = Date.now()
          if (now - lastAt < 80) return
          lastAt = now
          var model = ed.getModel()
          if (!model || model.getLanguageId() !== LATEX_LANG) { scheduleHide(); return }
          var pos = e && e.target && e.target.position
          if (!pos) { scheduleHide(); return }
          var bx = (e.event && e.event.browserEvent && e.event.browserEvent.clientX) || 0
          var by = (e.event && e.event.browserEvent && e.event.browserEvent.clientY) || 0

          // 交叉引用优先：\ref{eq:1} 的 key 不在任何公式区间里，正常不会两边都命中；
          // 放在前面是为了让 \ref 写在公式内部时也能给出预览。
          var ref = findRefAt(model, pos)
          if (ref) {
            var entry = getLabelIndex(model).byKey[ref.key]
            if (entry) {
              var rkey = 'ref|' + ref.key + '|' + entry.line
              if (rkey === tipKey) return
              tipKey = rkey
              showRefTip(ref, entry, model, bx, by)
              return
            }
          }

          var found = findMathAt(model, pos)
          if (!found) { scheduleHide(); return }
          var key = found.tex + '|' + found.display
          if (key === tipKey) return
          tipKey = key
          scheduleTip(found, bx, by)
        } catch (error) { scheduleHide() }
      })
      ed.onMouseLeave(function () { scheduleHide() })
    }

    function bindFormulaHover(m) {
      try {
        m.editor.getEditors().forEach(attachHover)
        m.editor.onDidCreateEditor(function (ed) { attachHover(ed) })
      } catch (error) { report('error', '悬停绑定失败：' + errText(error)) }
    }

    // --endregion

    function initLanguageSupport() {
      whenMonaco(setupLanguageLayer)
    }

    /**
     * 把语言层装到某个 monaco 实例上（每个实例只装一次）。
     *
     * 拆出来是因为「迟到」是常态：自带 vendor 的 Monaco 要等用户第一次打开工作台
     * 才注入。装的时候可能已经有打开的标签，所以末尾的 `syncTexModels` 会把它们
     * 按标签的 relPath 补成 LaTeX —— 否则那些 model 会一直是纯文本。
     *
     * @returns 本次是否真的装了
     */
    function setupLanguageLayer(m) {
      if (!m || !m.languages || !m.editor) return false
      if (langLayerReadyFor === m) return false
      langLayerReadyFor = m
      registerLatexLanguage(m)
      applyVscodeTheme(m)
      watchSchemeChange(m)
      syncTexModels(m)
      enableBracketColors(m)
      bindFormulaHover(m)
      // 这两个是「全局一次性」的：挂多个会重复跑，重装时不能再加
      if (!langHooksBound) {
        langHooksBound = true
        try {
          m.editor.onDidCreateModel(function () {
            setTimeout(function () { syncTexModels(m) }, 30)
          })
        } catch (error) { /* 旧版本无此事件 */ }
        setInterval(function () { syncTexModels(m) }, 4000)
      }
      report('info', 'LaTeX 语言支持已就绪')
      return true
    }

    /**
     * 手动补救：命令面板「重新加载语法高亮」。
     *
     * 语法层出问题的表现是「整片代码没颜色」，而它依赖的 Monaco 来自三条不同的路
     * （vscode-mode、自家 vendor、别的插件），任一条晚到都可能让人以为坏了。
     * 给一个不用重启就能重来的按钮，比让人翻日志强。
     */
    function reloadLanguageLayer() {
      var m = probeMonaco()
      if (!m) {
        status('LaTeX：Monaco 还没加载，打开工作台后会自动补上')
        langLayerReadyFor = null
        initLanguageSupport()
        return
      }
      if (langLayerReadyFor !== m) {
        langLayerReadyFor = null
        setupLanguageLayer(m)
        status('LaTeX：语言支持已补装')
        return
      }
      // 同一实例：只重装语法与配色，不动全局监听器（重复挂会叠加）
      try { registerLatexLanguage(m) } catch (error) {
        report('error', '重新注册 LaTeX 语法失败：' + errText(error))
      }
      try { applyVscodeTheme(m) } catch (error) { /* 配色失败不影响语法 */ }
      try { syncTexModels(m) } catch (error) { /* 模型同步失败不影响后续 */ }
      status('LaTeX：已重新应用语法高亮')
      report('info', '手动重装语言层完成')
    }

    // --endregion

    // --region 工作台（独立全屏容器，不依赖任何其它插件的 DOM）

    /**
     * 设计取舍：工作台挂在 document.body 上、用 fixed 铺满视口，
     * 而不是注册进 DSH 的 slot。
     *
     * 原因有三：
     *  1. slot 需要 `dsh.client.inject` 声明 react 与 ui-slots，任一条不满足就整插件不加载；
     *  2. `conversation.view` 是中央主区的槽位，vscode-mode 也在用它，抢过来会把它的编辑器挤掉；
     *  3. 工作台本来就要独占一屏，浮层与"嵌在布局里"在观感上没有区别 —— 之前嫌浮层，
     *     是因为那时它盖住的是别人的编辑器；现在整块屏幕都是自己的。
     *
     * 好处是可以和 vscode-mode 并存：它管它的编辑器，这边管 LaTeX 工作台，互不干扰。
     */
    var WB_ID = 'dmz-latex-workbench'
    var wb = {
      el: null,
      titleEl: null,
      statusEl: null,
      editorEl: null,
      editorHostEl: null,
      tabsEl: null,
      pdfEl: null,
      splitterEl: null,
      pdfOpen: true,
    }
    /** 工作台当前模型：modelKey 用它把 inmemory URI 映射回真实文件名。 */
    var wbModel = null

    /** 工作台的样式表，只注入一次。颜色走 CSS 变量，跟随界面明暗切换。 */
    function ensureWorkbenchStyle() {
      if (document.getElementById(WB_ID + '-style')) return
      var css = [
        // 默认按「嵌入右侧栏」定位：绝对铺满 slot 给的容器。
        // 只有服务不可用、降级成浮层时才加 .dmz-wb-float 顶到 fixed。
        '#' + WB_ID + '{position:absolute;inset:0;display:flex;flex-direction:column;',
        'background:var(--dmz-bg,#ffffff);color:var(--dmz-fg,#1f1f1d);',
        'font-family:var(--dmz-font,var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif));',
        'font-size:13px;line-height:1.5}',
        '#' + WB_ID + '.dmz-wb-float{position:fixed;z-index:9000}',
        '#' + WB_ID + '[hidden]{display:none}',
        '#' + WB_ID + ' .dmz-wb-bar{display:flex;align-items:center;gap:8px;padding:8px 12px;',
        'border-bottom:1px solid var(--dmz-border,rgba(0,0,0,.12));flex:0 0 auto;min-height:38px}',
        '#' + WB_ID + ' .dmz-wb-title{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:42vw}',
        '#' + WB_ID + ' .dmz-wb-sub{color:var(--dmz-fg-dim,#8a8a85);font-size:12px}',
        '#' + WB_ID + ' .dmz-wb-spacer{flex:1 1 auto}',
        '#' + WB_ID + ' .dmz-wb-btn{appearance:none;border:1px solid var(--dmz-border,rgba(0,0,0,.14));',
        'background:var(--dmz-btn,#f6f6f4);color:inherit;border-radius:6px;padding:4px 10px;',
        'font-size:12px;cursor:pointer;font-family:inherit}',
        '#' + WB_ID + ' .dmz-wb-btn:hover{background:var(--dmz-btn-hover,#ececea)}',
        '#' + WB_ID + ' .dmz-wb-btn[disabled]{opacity:.5;cursor:default}',
        // 「清理」按钮的下拉：两种粒度摆出来，点哪个清哪个，避免误触直接删
        '#' + WB_ID + ' .dmz-wb-menuwrap{position:relative;display:inline-flex}',
        '#' + WB_ID + ' .dmz-wb-menu{position:absolute;top:calc(100% + 5px);right:0;z-index:60;min-width:200px;',
        'display:flex;flex-direction:column;gap:2px;padding:4px;border-radius:8px;',
        'background:var(--dmz-bg,#ffffff);border:1px solid var(--dmz-border,rgba(0,0,0,.14));',
        'box-shadow:0 8px 24px rgba(0,0,0,.18)}',
        '#' + WB_ID + ' .dmz-wb-menu[hidden]{display:none}',
        '#' + WB_ID + ' .dmz-wb-menu-item{appearance:none;text-align:left;border:0;background:transparent;',
        'color:inherit;font:inherit;font-size:12px;padding:6px 8px;border-radius:5px;cursor:pointer;',
        'white-space:nowrap}',
        '#' + WB_ID + ' .dmz-wb-menu-item:hover{background:var(--dmz-btn-hover,#ececea)}',
        '#' + WB_ID + ' .dmz-wb-menu-note{color:var(--dmz-fg-dim,#8a8a85);font-size:11px;padding:2px 8px 4px;',
        'white-space:normal;line-height:1.35}',
        '#' + WB_ID + ' .dmz-wb-body{flex:1 1 auto;display:flex;min-height:0;min-width:0}',
        '#' + WB_ID + ' .dmz-wb-pane{min-width:0;min-height:0;position:relative;overflow:hidden}',
        '#' + WB_ID + ' .dmz-wb-editor{flex:1 1 auto;display:flex;flex-direction:column}',
        '#' + WB_ID + ' .dmz-wb-pdf{flex:0 0 46%;display:flex;flex-direction:column;',
        'border-left:1px solid var(--dmz-border,rgba(0,0,0,.12))}',
        '#' + WB_ID + ' .dmz-wb-splitter{flex:0 0 5px;cursor:col-resize;',
        'background:transparent;border-left:1px solid var(--dmz-border,rgba(0,0,0,.12));margin-left:-5px;',
        'z-index:2}',
        '#' + WB_ID + ' .dmz-wb-splitter:hover{background:var(--dmz-accent,rgba(55,138,221,.28))}',
        '#' + WB_ID + ' .dmz-wb-placeholder{display:flex;align-items:center;justify-content:center;',
        'height:100%;color:var(--dmz-fg-dim,#8a8a85);font-size:12px;padding:24px;text-align:center}',
        // 文件标签栏：一排可横滚的页签，点谁切谁，× 关闭，未保存的带圆点
        '#' + WB_ID + ' .dmz-wb-tabs{display:flex;align-items:stretch;gap:2px;flex:0 0 auto;',
        'overflow-x:auto;overflow-y:hidden;padding:4px 6px 0;',
        'border-bottom:1px solid var(--dmz-border,rgba(0,0,0,.12))}',
        '#' + WB_ID + ' .dmz-wb-tab{display:inline-flex;align-items:center;gap:6px;flex:0 0 auto;',
        'max-width:200px;padding:4px 6px 4px 10px;border:1px solid transparent;border-bottom:none;',
        'border-radius:6px 6px 0 0;cursor:pointer;font-size:12px;white-space:nowrap;',
        'user-select:none;overflow:hidden}',
        '#' + WB_ID + ' .dmz-wb-tab:hover{background:var(--dmz-btn-hover,#ececea)}',
        '#' + WB_ID + ' .dmz-wb-tab-active{background:var(--dmz-btn,#f6f6f4);',
        'border-color:var(--dmz-border,rgba(0,0,0,.12))}',
        '#' + WB_ID + ' .dmz-wb-tab-name{overflow:hidden;text-overflow:ellipsis}',
        '#' + WB_ID + ' .dmz-wb-tab-dot{width:7px;height:7px;border-radius:50%;flex:0 0 auto;',
        'background:var(--dmz-accent,rgba(55,138,221,.9))}',
        '#' + WB_ID + ' .dmz-wb-tab-close{appearance:none;border:0;background:transparent;',
        'color:inherit;cursor:pointer;border-radius:4px;padding:0 4px;font-size:12px;',
        'line-height:1.4;opacity:.55;flex:0 0 auto}',
        '#' + WB_ID + ' .dmz-wb-tab-close:hover{opacity:1;background:var(--dmz-btn-hover,#ececea)}',
        '#' + WB_ID + ' .dmz-wb-editor-host{flex:1 1 auto;min-height:0;position:relative;overflow:hidden}',
        // 文件清单浮层：贴在工作台顶栏下方，不遮满整个编辑器
        '#' + WB_ID + ' .dmz-wb-files{position:absolute;left:8px;top:46px;width:min(420px,80%);',
        'max-height:min(70%,520px);display:flex;flex-direction:column;z-index:20;',
        'background:var(--dmz-bg,#fff);border:1px solid var(--dmz-border,rgba(0,0,0,.16));',
        'border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.18);overflow:hidden}',
        '#' + WB_ID + ' .dmz-wb-files-head{display:flex;align-items:center;justify-content:space-between;',
        'gap:8px;padding:6px 8px 6px 12px;border-bottom:1px solid var(--dmz-border,rgba(0,0,0,.1));',
        'font-size:12px;color:var(--dmz-fg-dim,#8a8a85)}',
        '#' + WB_ID + ' .dmz-wb-files-list{overflow:auto;padding:4px;min-height:0}',
        '#' + WB_ID + ' .dmz-wb-file{display:flex;flex-direction:column;gap:1px;width:100%;',
        'appearance:none;border:0;background:transparent;color:inherit;text-align:left;',
        'padding:5px 8px;border-radius:5px;cursor:pointer;font-family:inherit;font-size:12.5px}',
        '#' + WB_ID + ' .dmz-wb-file:hover{background:var(--dmz-btn-hover,#ececea)}',
        '#' + WB_ID + ' .dmz-wb-file-path{font-size:11px;color:var(--dmz-fg-dim,#8a8a85);',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        'html[data-dmz-dark="1"] #' + WB_ID + '{--dmz-bg:#1f1f1e;--dmz-fg:#ececeb;--dmz-fg-dim:#9a9a95;',
        '--dmz-border:rgba(255,255,255,.14);--dmz-btn:#2c2c2a;--dmz-btn-hover:#3a3a37}',
      ].join('')
      var style = document.createElement('style')
      style.id = WB_ID + '-style'
      style.textContent = css
      document.head.appendChild(style)
    }

    /** 跟随界面明暗，给工作台切换一套变量。 */
    function syncWorkbenchTheme() {
      try {
        var dark = dshIsDark()
        document.documentElement.setAttribute('data-dmz-dark', dark ? '1' : '0')
      } catch (error) { /* 检测失败保持上一次的值 */ }
    }

    function makeWbButton(label, title, onClick) {
      var b = document.createElement('button')
      b.className = 'dmz-wb-btn'
      b.type = 'button'
      b.textContent = label
      if (title) b.title = title
      b.addEventListener('click', onClick)
      return b
    }

    /**
     * 「清理」按钮 + 下拉菜单。
     *
     * 为什么不直接一点就清：清理有两种粒度（全部产物 / 只清日志），
     * 直接点等于替用户选了其中一种。摆成两项，点哪个清哪个，
     * 也不会因为手滑把 aux 全删掉（虽然可再生产，但下次编译会慢一截）。
     */
    function buildCleanMenu() {
      var wrap = document.createElement('span')
      wrap.className = 'dmz-wb-menuwrap'

      var btn = makeWbButton('清理', '清理编译产物（保留 .tex 与 .pdf）', function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        toggleCleanMenu()
      })
      btn.setAttribute('data-dmz-wb-clean', '1')

      var menu = document.createElement('div')
      menu.className = 'dmz-wb-menu'
      menu.setAttribute('data-dmz-wb-menu', '1')
      menu.hidden = true

      menu.appendChild(makeMenuItem('清理编译产物', function () {
        hideCleanMenu()
        void cleanArtifactsNow('aux')
      }))
      menu.appendChild(makeMenuItem('只清理日志', function () {
        hideCleanMenu()
        void cleanArtifactsNow('log')
      }))
      var note = document.createElement('div')
      note.className = 'dmz-wb-menu-note'
      note.textContent = '只清当前文档的 .aux / .log / .fls 等可再生产物，.tex 与 .pdf 一律保留'
      menu.appendChild(note)

      wrap.appendChild(btn)
      wrap.appendChild(menu)
      return wrap
    }

    function makeMenuItem(label, onClick) {
      var item = document.createElement('button')
      item.type = 'button'
      item.className = 'dmz-wb-menu-item'
      item.textContent = label
      item.addEventListener('click', function (event) {
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
        onClick()
      })
      return item
    }

    function toggleCleanMenu() {
      var menu = wb.el ? wb.el.querySelector('[data-dmz-wb-menu]') : null
      if (!menu) return
      if (menu.hidden) showCleanMenu(menu)
      else hideCleanMenu()
    }

    function showCleanMenu(menu) {
      menu.hidden = false
      // 点空白处 / 按 Esc 收起。用 setTimeout 挂，避免把「打开它的那一次点击」也算进去。
      setTimeout(function () {
        function onDocDown(event) {
          var t = event && event.target
          if (t && t.closest && t.closest('.dmz-wb-menuwrap')) return
          hideCleanMenu()
        }
        function onKey(event) {
          if (event && event.key === 'Escape') hideCleanMenu()
        }
        try {
          document.addEventListener('mousedown', onDocDown)
          document.addEventListener('keydown', onKey)
        } catch (error) { /* 无 document 的环境（测试桩）忽略 */ }
        cleanMenuOff = function () {
          try {
            document.removeEventListener('mousedown', onDocDown)
            document.removeEventListener('keydown', onKey)
          } catch (error) { /* 同上 */ }
        }
      }, 0)
    }

    function hideCleanMenu() {
      var menu = wb.el ? wb.el.querySelector('[data-dmz-wb-menu]') : null
      if (menu) menu.hidden = true
      if (cleanMenuOff) { cleanMenuOff(); cleanMenuOff = null }
    }

    /** 收起下拉时注销的监听器（重复打开不会叠加）。 */
    var cleanMenuOff = null

    /** 创建工作台 DOM（幂等）。 */
    function buildWorkbench() {
      if (wb.el) return wb.el
      ensureWorkbenchStyle()
      syncWorkbenchTheme()

      var el = document.createElement('div')
      el.id = WB_ID
      el.hidden = true

      var bar = document.createElement('div')
      bar.className = 'dmz-wb-bar'

      var title = document.createElement('span')
      title.className = 'dmz-wb-title'
      title.textContent = '未打开文件'

      var sub = document.createElement('span')
      sub.className = 'dmz-wb-sub'
      sub.textContent = 'LaTeX 工作台'

      var spacer = document.createElement('div')
      spacer.className = 'dmz-wb-spacer'

      var statusEl = document.createElement('span')
      statusEl.className = 'dmz-wb-sub'
      statusEl.setAttribute('data-dmz-wb-status', '1')

      bar.appendChild(title)
      bar.appendChild(sub)
      bar.appendChild(spacer)
      bar.appendChild(statusEl)
      bar.appendChild(makeWbButton('文件', '打开工作区里的文件', function () { toggleFileList() }))
      bar.appendChild(makeWbButton('保存', '保存当前文件（Ctrl+S）', function () { saveWorkbenchFile(false) }))
      bar.appendChild(makeWbButton('编译', '编译当前文档（Ctrl+Alt+B）', function () { void compileNow() }))
      bar.appendChild(buildCleanMenu())
      var previewBtn = makeWbButton('收起预览', '收起 PDF 预览，让代码区占满（Ctrl+Alt+P）', function () { togglePdfPane() })
      previewBtn.setAttribute('data-dmz-wb-preview', '1')
      bar.appendChild(previewBtn)
      var closeBtn = makeWbButton('×', '关闭工作台（Esc）', function () { closeWorkbench() })
      closeBtn.setAttribute('data-dmz-wb-close', '1')
      bar.appendChild(closeBtn)

      var body = document.createElement('div')
      body.className = 'dmz-wb-body'

      var editor = document.createElement('div')
      editor.className = 'dmz-wb-pane dmz-wb-editor'

      // 文件标签栏：贴在代码区顶部，多个文件各占一签，互不丢状态
      var tabs = document.createElement('div')
      tabs.className = 'dmz-wb-tabs'
      tabs.setAttribute('data-dmz-wb-tabs', '1')
      tabs.style.display = 'none' // 没有打开的文件时不占高度

      // Monaco 的容器：单独一层，标签栏增删不会波及编辑器尺寸
      var host = document.createElement('div')
      host.className = 'dmz-wb-editor-host'
      var ph1 = document.createElement('div')
      ph1.className = 'dmz-wb-placeholder'
      ph1.textContent = '正在加载编辑器…'
      host.appendChild(ph1)
      editor.appendChild(tabs)
      editor.appendChild(host)

      var splitter = document.createElement('div')
      splitter.className = 'dmz-wb-splitter'

      var pdf = document.createElement('div')
      pdf.className = 'dmz-wb-pane dmz-wb-pdf'
      var ph2 = document.createElement('div')
      ph2.className = 'dmz-wb-placeholder'
      ph2.textContent = '编译后在这里显示 PDF'
      pdf.appendChild(ph2)

      body.appendChild(editor)
      body.appendChild(splitter)
      body.appendChild(pdf)

      el.appendChild(bar)
      el.appendChild(body)

      wb.el = el
      wb.titleEl = title
      wb.statusEl = statusEl
      wb.editorEl = editor
      wb.editorHostEl = host
      wb.tabsEl = tabs
      wb.pdfEl = pdf
      wb.splitterEl = splitter
      restorePdfOpen()
      report('info', '工作台骨架已创建（预览' + (wb.pdfOpen ? '展开' : '收起') + '）')
      return el
    }

    /** 分隔条拖动。左右两侧都在自己的工作台里，所以只是改一个 flexBasis。 */
    function bindWorkbenchSplitter() {
      var grip = wb.splitterEl
      var pdf = wb.pdfEl
      if (!grip || !pdf || grip.__dmzBound) return
      grip.__dmzBound = true

      grip.addEventListener('mousedown', function (event) {
        if (event.button !== 0) return
        event.preventDefault()
        var body = wb.el ? wb.el.querySelector('.dmz-wb-body') : null
        if (!body) return
        var total = body.getBoundingClientRect().width
        var startX = event.clientX
        var startW = pdf.getBoundingClientRect().width
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'

        function onMove(e) {
          // 左侧至少留 320px 给代码，右侧至少 240px 给 PDF
          var w = startW - (e.clientX - startX)
          w = Math.max(240, Math.min(total - 320, w))
          pdf.style.flex = '0 0 ' + Math.round(w) + 'px'
        }

        function onUp() {
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          try {
            localStorage.setItem('dmzlatex.pdfWidth', String(Math.round(pdf.getBoundingClientRect().width)))
          } catch (error) { /* 隐私模式无 localStorage */ }
          relayoutMonaco()
        }

        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      })

      grip.addEventListener('dblclick', function () {
        pdf.style.flex = '0 0 46%'
        relayoutMonaco()
      })
    }

    /** 恢复上次的预览宽度。窗口变窄时按剩余空间重新夹一遍。 */
    function restorePdfWidth() {
      if (!wb.pdfEl || !wb.el) return
      var saved = 0
      try { saved = Number(localStorage.getItem('dmzlatex.pdfWidth')) || 0 } catch (error) { saved = 0 }
      if (!saved) return
      var body = wb.el.querySelector('.dmz-wb-body')
      if (!body) return
      var total = body.getBoundingClientRect().width
      if (total < 320) return
      var w = Math.max(240, Math.min(total - 320, saved))
      wb.pdfEl.style.flex = '0 0 ' + Math.round(w) + 'px'
    }

    /**
     * 折叠/展开 PDF 预览。
     *
     * 只改可见性不销毁内容：Monaco 与 pdf.js 的状态都留着，再展开还是原样
     * （滚动位置、缩放比例都在），也不会为了「展开」去重编译一次。
     * 只改 `display` 而不是 flex-basis=0，是因为后者会让分隔条仍占位、
     * 且 pdf.js 的 ResizeObserver 会反复触发重新排版。
     */
    function togglePdfPane(force) {
      var next = typeof force === 'boolean' ? force : !wb.pdfOpen
      if (next === wb.pdfOpen && wb.el && wb.pdfEl
        && (wb.pdfEl.style.display === (next ? '' : 'none'))) return
      wb.pdfOpen = next
      try { localStorage.setItem('dmzlatex.pdfOpen', next ? '1' : '0') } catch (error) { /* 隐私模式 */ }
      if (wb.pdfEl) wb.pdfEl.style.display = next ? '' : 'none'
      if (wb.splitterEl) wb.splitterEl.style.display = next ? '' : 'none'
      updatePreviewButton()
      relayoutMonaco()
      status('LaTeX：预览已' + (next ? '展开' : '收起'))
      report('info', 'PDF 预览' + (next ? '展开' : '收起'))
    }

    /** 顶栏「预览」按钮跟着折叠状态换文案。 */
    function updatePreviewButton() {
      if (!wb.el) return
      var btn = null
      try { btn = wb.el.querySelector('[data-dmz-wb-preview]') } catch (error) { btn = null }
      if (!btn) return
      btn.textContent = wb.pdfOpen ? '收起预览' : '展开预览'
      btn.title = wb.pdfOpen ? '收起 PDF 预览，让代码区占满（Ctrl+Alt+P）' : '展开 PDF 预览（Ctrl+Alt+P）'
    }

    /** 按上次的偏好决定预览默认开合（首次默认展开）。 */
    function restorePdfOpen() {
      var v = null
      try { v = localStorage.getItem('dmzlatex.pdfOpen') } catch (error) { v = null }
      wb.pdfOpen = v === '0' ? false : true
      if (wb.pdfEl) wb.pdfEl.style.display = wb.pdfOpen ? '' : 'none'
      if (wb.splitterEl) wb.splitterEl.style.display = wb.pdfOpen ? '' : 'none'
      updatePreviewButton()
    }

    /**
     * 工作台有两种落位：
     *  - 嵌入：挂进官方右侧 Sidebar 的「LaTeX」页签，侧边对话与代码/PDF 同屏，收放由 DSH 管；
     *  - 浮层：右侧栏服务不可用（老版本 DSH/精简环境）时的降级，占满窗口。
     * DOM 只有一份实例，跟着宿主换位置，避免两套编辑器抢同一份状态。
     */
    /**
     * 注册前的结构自检。
     *
     * 教训：guide 条目的 title/description 传字符串（而非函数）时，渲染方调用会抛
     * "not a function"，而错误发生在**整个引导页的渲染**里，结果是右侧栏一片空白，
     * 连 vscode-mode / better-sidebar 的卡片也一起消失。一行结构错误炸掉整列，
     * 所以宁可放弃自己的卡片，也不能把别人的界面弄坏。
     *
     * @param spec 待注册的页签类型
     * @returns 问题描述，全部合格返回空字符串
     */
    function tabSpecProblem(spec) {
      if (!spec || typeof spec !== 'object') return '类型描述不是对象'
      if (typeof spec.id !== 'string' || !spec.id) return 'id 缺失'
      if (typeof spec.kind !== 'string' || !spec.kind) return 'kind 缺失'
      if (typeof spec.title !== 'function') return 'title 必须是函数（渲染方会调用它）'
      var guide = spec.guide
      if (guide === undefined) return ''
      if (!Array.isArray(guide)) return 'guide 必须是数组'
      for (var i = 0; i < guide.length; i++) {
        var g = guide[i] || {}
        if (typeof g.id !== 'string' || !g.id) return 'guide[' + i + '].id 缺失'
        if (typeof g.order !== 'number') return 'guide[' + i + '].order 必须是数字'
        if (typeof g.title !== 'function') return 'guide[' + i + '].title 必须是函数'
        if (g.description !== undefined && typeof g.description !== 'function') {
          return 'guide[' + i + '].description 必须是函数'
        }
      }
      return ''
    }

    var embed = {
      installed: false,
      mounted: false,
      hostEl: null,
      right: null,
      tabs: null,
      tabId: 'dsh-dmzlatexworkshop/editor',
      kind: 'dmzLatexEditor',
      float: false,
    }

    /** 把工作台塞进当前宿主容器（嵌入的 slot 节点，或浮层时的 body）。 */
    function attachWorkbench() {
      var el = buildWorkbench()
      var host = embed.hostEl || (embed.float ? document.body : null)
      if (!host) return false
      if (el.parentNode !== host) host.appendChild(el)
      el.hidden = false
      return true
    }

    function openWorkbench() {
      try {
        // 嵌入模式：切到右侧栏的 LaTeX 页签即可，DOM 由 slot 自己渲染挂载
        if (embed.installed) {
          try {
            if (embed.right && typeof embed.right.openTab === 'function') {
              embed.right.openTab(embed.kind, { params: {} })
              report('info', '已切换到右侧栏「LaTeX」页签')
              return
            }
          } catch (error) { report('error', '切换右侧栏页签失败：' + errText(error)) }
        }
        // 降级：整窗浮层
        embed.float = true
        ensureWorkbenchStyle()
        var el = buildWorkbench()
        el.classList.add('dmz-wb-float')
        attachWorkbench()
        syncWorkbenchTheme()
        bindWorkbenchSplitter()
        restorePdfWidth()
        relayoutMonaco()
        void ensureWorkbenchEditor().catch(function () { /* 已在内部上报 */ })
        report('info', '工作台已打开（浮层模式，右侧栏不可用）')
      } catch (error) { report('error', '打开工作台失败：' + errText(error)) }
    }

    function closeWorkbench() {
      if (!wb.el) return
      try { hideCleanMenu() } catch (error) { /* 菜单没建过就算了 */ }
      if (embed.mounted && embed.hostEl && wb.el.parentNode === embed.hostEl) {
        // 嵌入时页签由 DSH 管，插件这边只提示一下，不擅自把容器清空
        status('LaTeX：切换右侧栏页签即可暂时隐藏')
        report('info', '嵌入模式下不主动关闭，请切换页签')
        return
      }
      wb.el.hidden = true
      report('info', '工作台已关闭')
    }

    function workbenchVisible() {
      return !!(wb.el && !wb.el.hidden)
    }

    // --region 嵌入官方右侧栏

    /**
     * 注册官方右侧 Sidebar 页签并挂载工作台（DSH 0.1.5+）。
     *
     * 两段式，缺一不可：
     *  1. `sidebarRightTabs.register({ id, kind, … })` 声明页签类型并让它在 Tab 栏出现；
     *  2. `slots.inject('sidebar.right.pane.tab', () => slots.register({ name, key }, Host))`
     *     注册该 key 的正文。key 必须等于类型 id。
     *
     * slot 的正文是 React 组件，而工作台是纯 DOM，所以只用一层极薄壳：
     * 渲染一个撑满的 div，在 effect 里把工作台塞进去，卸载时只摘不销毁（编辑器实例要复用）。
     *
     * @param ctx DSH 客户端上下文
     * @param require 客户端模块表提供的 require
     * @returns 是否注册成功（false 表示调用方应退回浮层）
     */
    function installRightPane(ctx, require) {
      var tabs = null
      var right = null
      try { tabs = ctx.get('sidebarRightTabs') } catch (error) { tabs = null }
      try { right = ctx.get('sidebarRight') } catch (error) { right = null }
      if (!tabs || typeof tabs.register !== 'function' || !right || typeof right.openTab !== 'function') {
        report('info', '右侧栏服务尚未就绪（sidebarRightTabs/sidebarRight），稍后重试')
        return false
      }
      var slots = null
      try { slots = ctx.slots } catch (error) { slots = null }
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        report('warn', 'slots 服务不可用，工作台退回浮层')
        return false
      }
      var react = null
      try { react = require('react') } catch (error) { react = null }
      if (!react || typeof react.createElement !== 'function') {
        report('warn', '模块表未提供 react，工作台退回浮层')
        return false
      }

      var typeDisposer = null
      var spec = {
        id: embed.tabId,
        kind: embed.kind,
        priority: 'extension',
        title: function () { return 'LaTeX' },
        // guide 的 title / description **必须是函数**：渲染方按 definition.title(...) /
        // entry.title() 调用，传字符串会抛 "not a function"，而这一个错误会让
        // 整个引导页（guide）列表渲染失败 —— 表现是右侧栏一片空白，连别人的卡片也消失。
        // id 也必填（provider 内唯一），作为 React key 与卡片身份。
        guide: [{
          id: 'editor',
          order: 30,
          title: function () { return 'LaTeX 工作台' },
          description: function () { return '本地编译、PDF 预览与 SyncTeX 跳转' },
        }],
      }
      var problem = tabSpecProblem(spec)
      if (problem) {
        report('error', '页签类型结构不合法，已放弃注册（避免弄坏整个右侧栏）：' + problem)
        return false
      }
      try {
        typeDisposer = tabs.register(spec)
      } catch (error) {
        // 热重载时上一个实例的注册还挂在 registry 上，会抛 "already registered"。
        // 这**不算失败**：页签类型确实存在，正文 slot 也还接得住。当成失败去重试
        // 只会每 400ms 抛一次同样的错，把日志刷满（曾经刷了上百条）。
        if (/already registered/i.test(errText(error))) {
          report('info', 'LaTeX 页签类型已由上一个实例注册，直接复用')
        } else {
          report('error', 'LaTeX 页签类型注册失败：' + errText(error))
          return false
        }
      }

      /**
       * 右侧栏「LaTeX」页签的正文。
       *
       * 它会收到 DSH 注入的 slot props —— `sidebar.right.pane.tab` 是 session 作用域的
       * 席位，所以 props 里有当前会话的 `sessionId`（同席位的
       * `dsh-client-ui-sidebar-files` 就是这么拿到 `useSessions` 和 cwd 的）。
       *
       * 这就是「跟随当前项目」的关键：拿到 sessionId 上报给宿主，宿主去
       * `workspaceRegistry` 查出这个会话属于哪个 workspace，那个 path 就是侧边栏
       * 文件树显示的根。不再靠「哪个会话最近活跃」去猜。
       */
      var slotPropsLogged = false
      function Host(props) {
        var ref = react.useRef(null)
        var sid = props && typeof props.sessionId === 'string' ? props.sessionId : null

        // 只同步会话 id，不重挂工作台（下面那个 effect 仍是 [] 依赖）
        react.useEffect(function () {
          if (!slotPropsLogged) {
            slotPropsLogged = true
            var keys = []
            try { keys = Object.keys(props || {}) } catch (error) { keys = [] }
            report('info', '右侧栏 slot props：' + (keys.join(', ') || '(空)') +
              ' | sessionId=' + (sid || '(无)'))
          }
          if (!sid || sid === state.sessionId) return
          state.sessionId = sid
          report('info', 'LaTeX 已绑定会话 ' + sid)
          // 会话换了：已经展开的文件清单属于别的项目，重新拉一份
          if (fileListEl) { hideFileList(); toggleFileList() }
        }, [sid])

        react.useEffect(function () {
          var node = ref.current
          if (!node) return undefined
          embed.hostEl = node
          embed.mounted = true
          // 页签一挂上就能从 DOM 读出所属会话，不必等 props
          var fromDom = sessionIdFromDom()
          if (fromDom && fromDom !== state.sessionId) {
            state.sessionId = fromDom
            report('info', 'LaTeX 页签所属会话（DOM）：' + fromDom)
          }
          try {
            ensureWorkbenchStyle()
            var el = buildWorkbench()
            el.classList.remove('dmz-wb-float')
            if (el.parentNode !== node) node.appendChild(el)
            el.hidden = false
            var closeBtn = el.querySelector('[data-dmz-wb-close]')
            if (closeBtn) closeBtn.style.display = 'none'
            syncWorkbenchTheme()
            bindWorkbenchSplitter()
            restorePdfWidth()
            relayoutMonaco()
            void ensureWorkbenchEditor().catch(function () { /* 已在内部上报 */ })
            report('info', '工作台已嵌入右侧栏页签')
          } catch (error) { report('error', '嵌入工作台失败：' + errText(error)) }
          return function () {
            embed.mounted = false
            if (embed.hostEl === node) embed.hostEl = null
            // 只摘不销毁：Monaco 与 PDF 状态留在内存里，切回页签时原样复原
            if (wb.el && wb.el.parentNode === node) node.removeChild(wb.el)
          }
        }, [])
        return react.createElement('div', {
          ref: ref,
          className: 'dmz-wb-host',
          style: {
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
            height: '100%',
            minHeight: '0',
            minWidth: '0',
            overflow: 'hidden',
          },
        })
      }

      var bodyDisposer = null
      try {
        bodyDisposer = slots.inject('sidebar.right.pane.tab', function () {
          return slots.register({ name: 'sidebar.right.pane.tab', key: embed.tabId }, Host)
        })
      } catch (error) {
        report('error', '页签正文注册失败：' + errText(error))
        try { if (typeof typeDisposer === 'function') typeDisposer() } catch (e2) {}
        return false
      }

      embed.installed = true
      embed.right = right
      embed.tabs = tabs
      report('info', '已注册右侧栏页签「LaTeX」（key=' + embed.tabId + '，kind=' + embed.kind + '）')
      return true
    }

    /** 服务可能晚于插件就绪：短时间内轮询几次，失败就固定走浮层。 */
    function installRightPaneWithRetry(ctx, require, attempt) {
      var n = attempt || 0
      var ok = false
      try { ok = installRightPane(ctx, require) } catch (error) {
        report('error', '嵌入右侧栏异常：' + errText(error))
      }
      if (ok || n >= 8) {
        if (!ok) report('warn', '右侧栏嵌入放弃，按 Ctrl+Alt+O 仍可用浮层工作台')
        return
      }
      setTimeout(function () { installRightPaneWithRetry(ctx, require, n + 1) }, 400)
    }

    // --endregion

    // --region 启动快捷键提示

    /**
     * 入口只剩右侧栏的「LaTeX」页签（外加 `Ctrl+Alt+O`）。
     *
     * 这里曾经有两个额外入口：右侧栏底部（`sidebar.footer.action` 席位）的
     * 「TeX LaTeX 工作台」按钮，和右下角浮动的「LaTeX」按钮。前者与侧栏其它按钮
     * 混在一起、显得多余，后者浮在编辑区上方挡视线 —— 都被要求去掉了。
     *
     * 代价是发现性：不知道快捷键的人找不到工作台。所以首次启动时用状态栏提一句，
     * 只提一次（记在 localStorage），不打扰第二次。
     */
    function announceOnce() {
      var flag = 'dmzlatex.announced'
      try { if (localStorage.getItem(flag)) return } catch (error) { return }
      try { localStorage.setItem(flag, '1') } catch (error) { /* 隐私模式 */ }
      setTimeout(function () {
        status('LaTeX：右侧栏「LaTeX」页签打开工作台 · Ctrl+Alt+O')
      }, 2500)
    }

    // --endregion

    // --region 自带 Monaco

    var MONACO_BASE = '/dmzlatex/vendor/monaco/vs'
    var monacoPromise = null

    /** 轮询等 window.monaco 出现，最多等 timeout 毫秒。 */
    function waitMonaco(timeout) {
      return new Promise(function (resolve) {
        var deadline = Date.now() + timeout
        ;(function tick() {
          var m = null
          try { m = window.monaco } catch (error) { m = null }
          if (m && m.editor && typeof m.editor.create === 'function') { resolve(m); return }
          if (Date.now() >= deadline) { resolve(null); return }
          setTimeout(tick, 120)
        })()
      })
    }

    /**
     * 注入自己的 AMD loader 并加载 editor.main。
     *
     * 有个必须踩准的细节：Monaco 的 loader 会检测 `globalThis.module` / `exports`，
     * 只要存在就判定为 CommonJS 环境，从而不把 require 挂到 window 上。
     * 桌面端的渲染进程里这两个全局经常是存在的，所以要在注入那一瞬间藏起来，
     * 加载完成后再原样恢复 —— 不恢复会影响别的脚本。
     */
    function injectOwnMonaco() {
      var base = appUrl(MONACO_BASE)
      report('info', '注入 Monaco AMD loader：' + base + '/loader.js')
      return new Promise(function (resolve, reject) {
        var settled = false
        var saved = null

        function hideNodeGlobals() {
          var hasModule = Object.prototype.hasOwnProperty.call(globalThis, 'module')
          var hasExports = Object.prototype.hasOwnProperty.call(globalThis, 'exports')
          saved = {
            hasModule: hasModule,
            hasExports: hasExports,
            module: hasModule ? globalThis.module : undefined,
            exports: hasExports ? globalThis.exports : undefined,
          }
          try { if (hasModule) delete globalThis.module } catch (error) { /* 冻结则跳过 */ }
          try { if (hasExports) delete globalThis.exports } catch (error) { /* 同上 */ }
        }

        function restoreNodeGlobals() {
          if (!saved) return
          try {
            if (saved.hasModule) globalThis.module = saved.module
            else delete globalThis.module
          } catch (error) { /* 无法恢复时保持现状 */ }
          try {
            if (saved.hasExports) globalThis.exports = saved.exports
            else delete globalThis.exports
          } catch (error) { /* 同上 */ }
          saved = null
        }

        function fail(error) {
          if (settled) return
          settled = true
          monacoPromise = null
          var tag = document.querySelector('script[data-dmz-monaco-loader]')
          if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
          reject(error instanceof Error ? error : new Error(String(error)))
        }

        function done() {
          if (settled) return
          var m = null
          try { m = window.monaco } catch (error) { m = null }
          if (!m || !m.editor || typeof m.editor.create !== 'function') {
            fail(new Error('vs/editor/editor.main 已执行但 window.monaco 未就绪'))
            return
          }
          settled = true
          report('info', 'Monaco 已从自带 vendor 就绪')
          resolve(m)
        }

        var script = document.createElement('script')
        script.src = base + '/loader.js'
        script.setAttribute('data-dmz-monaco-loader', '1')
        script.onload = function () {
          restoreNodeGlobals()
          try {
            if (typeof window.require !== 'function' || typeof window.require.config !== 'function') {
              fail(new Error('loader.js 未挂载 window.require'))
              return
            }
            window.require.config({ paths: { vs: base } })
            window.require(['vs/editor/editor.main'], done, function (error) {
              fail(error || new Error('editor.main 模块加载失败'))
            })
          } catch (error) { fail(error) }
        }
        script.onerror = function () {
          restoreNodeGlobals()
          fail(new Error('loader.js 加载失败：' + script.src))
        }
        hideNodeGlobals()
        document.head.appendChild(script)
        setTimeout(function () { fail(new Error('Monaco 加载超时（20 秒）')) }, 20000)
      })
    }

    /**
     * 取 Monaco 实例。三条路，按"对别人的影响从小到大"排：
     *  1. 页面上已经就绪 → 直接复用（此时 AMD loader 已归别人管，动它只会打架）；
     *  2. 别人的 loader 正在加载 → 给它 8 秒，等不到再自建；
     *  3. 什么都没有 → 用自带 vendor 注入。
     * 关掉 vscode-mode 后走的就是第 3 条，那才是真正解耦的路径。
     */
    /**
     * 取一个可用的 Monaco：优先复用页面上已有的，其次等别人加载，最后注入自带的。
     * 成功时顺手唤醒语言层 —— 这是「迟到」场景的主要补救点：Monaco 是我们自己
     * 在打开工作台那一刻注入的，注入完成时语言层必须立刻跟上，不能靠轮询碰运气。
     */
    function loadMonacoApi() {
      return loadMonacoApiRaw().then(function (m) {
        try { flushMonacoWaiters(m) } catch (error) { /* 唤醒失败不阻塞编辑器 */ }
        return m
      })
    }

    function loadMonacoApiRaw() {
      // 先看 window.monaco：缓存的 promise 可能正卡在自家注入上（loader 没回），
      // 这时若别处（vscode-mode / 自测桩）已经把 monaco 挂好，直接改用它。
      var ready = null
      try { ready = window.monaco } catch (error) { ready = null }
      if (ready && ready.editor && typeof ready.editor.create === 'function') {
        if (!monacoPromise) report('info', '复用页面上已就绪的 Monaco')
        monacoPromise = Promise.resolve(ready)
        return monacoPromise
      }
      if (monacoPromise) return monacoPromise
      var loading = false
      try { loading = typeof window.require === 'function' && typeof window.require.config === 'function' } catch (error) { loading = false }
      if (loading) {
        report('info', '检测到其它插件正在加载 Monaco，等待其就绪…')
        monacoPromise = waitMonaco(8000).then(function (m) {
          if (m) { report('info', '已复用其它插件加载的 Monaco'); return m }
          report('info', '等待超时，改为自带 vendor 注入')
          monacoPromise = null
          return loadMonacoApi()
        })
        return monacoPromise
      }
      monacoPromise = injectOwnMonaco().catch(function (error) {
        report('error', 'Monaco 加载失败：' + errText(error))
        throw error
      })
      return monacoPromise
    }

    // --endregion

    // --region 工作台编辑器

    var wbEditor = null
    var wbEditorBuilding = null
    /** 全部标签关掉后挂在编辑器上的空白 model（单例，避免反复创建堆积）。 */
    var blankModel = null

    /**
     * 在工作台左栏里创建一个自己的 Monaco 编辑器。
     * 这是与 vscode-mode 最关键的区别：实例由我们创建、容器由我们提供，
     * 所以尺寸、布局、生命周期都不需要跟任何人协商。
     *
     * 多标签：编辑器只有一个，每个标签持有自己的 model（内容/撤销栈/光标），
     * 切标签就是 setModel + 恢复 viewState，比开多个编辑器实例省得多。
     */
    function ensureWorkbenchEditor() {
      if (wbEditor) return Promise.resolve(wbEditor)
      if (wbEditorBuilding) return wbEditorBuilding
      if (!wb.el) buildWorkbench()
      wbEditorBuilding = loadMonacoApi().then(function (m) {
        if (wbEditor) return wbEditor
        var host = wb.editorHostEl || wb.editorEl
        if (!host) throw new Error('工作台编辑器容器缺失')
        // 只清 Monaco 宿主这一层，标签栏不受影响
        host.textContent = ''
        wbEditor = m.editor.create(host, {
          value: '',
          language: 'plaintext',
          automaticLayout: true,
          fontSize: 13,
          lineHeight: 20,
          lineNumbers: 'on',
          lineNumbersMinChars: 3,
          minimap: { enabled: false },
          wordWrap: 'on',
          scrollBeyondLastLine: false,
          renderLineHighlight: 'line',
          tabSize: 2,
          padding: { top: 8, bottom: 8 },
          scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        })
        wbEditorBuilding = null
        report('info', '工作台编辑器已创建')
        // Ctrl+S 存盘。Monaco 会吞键，必须走 addCommand 而不是 window 监听。
        try {
          if (m.KeyMod && m.KeyCode) {
            wbEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, function () { saveWorkbenchFile(false) })
            // Ctrl+W 关闭当前标签（浏览器里常被抢，抢不到就用标签上的 ×）
            wbEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyW, function () {
              if (state.wbFile) closeWorkbenchTab(state.wbFile)
            })
            // Ctrl+Alt+J 正向搜索。放在编辑器上而不是 window 监听：
            // 光标在编辑器里时 Monaco 会先吃掉按键，window 那层收不到。
            wbEditor.addCommand(m.KeyMod.CtrlCmd | m.KeyMod.Alt | m.KeyCode.KeyJ, function () {
              void forwardSearch()
            })
          }
        } catch (error) { /* 命令注册失败不影响编辑 */ }
        // Monaco 可能是我们刚注入的那一份。语言层现在会在 loadMonacoApi 里就装好，
        // 但那时这个编辑器还不存在，所以这里再同步一次模型与编辑器选项
        // （否则括号配对着色会漏掉这个新建的实例）。
        try { setupLanguageLayer(m) } catch (error) { /* 已装过就走空 */ }
        try { syncTexModels(m) } catch (error) { /* 模型尚未就绪 */ }
        try { enableBracketColors(m) } catch (error) { /* 选项应用失败不影响编辑 */ }
        try {
          wbModel = wbEditor.getModel()
          // 建实例时自带的那个空 model 就是「全部标签关掉」后的落脚点，留着复用
          blankModel = wbModel
        } catch (error) { wbModel = null }
        try { relayoutMonaco() } catch (error) { /* 布局失败不影响使用 */ }
        return wbEditor
      }).catch(function (error) {
        wbEditorBuilding = null
        report('error', '工作台编辑器初始化失败：' + errText(error))
        throw error
      })
      return wbEditorBuilding
    }

    /** 工作台里的编辑器实例（供 P4 打开文件、P6 反向搜索使用）。 */
    function workbenchEditor() {
      return wbEditor
    }

    // --region 工作台文件

    /** 文件清单浮层元素（懒建）。 */
    var fileListEl = null

    /** 是否 LaTeX 主文档（结构检查、语法、PDF 预览都只对这类文件有意义）。 */
    function isTexPath(p) {
      return /\.(tex|cls|sty|ltx)$/i.test(String(p || ''))
    }

    /**
     * 让工作台的模型接入语言层。
     * @param m monaco
     * @param model 标签持有的 model
     * @param tab 所属标签（脏标记、诊断归属都靠它）
     */
    function adoptWorkbenchModel(m, model, tab) {
      if (!model) return
      var isTex = isTexPath(tab && tab.relPath)
      if (!isTex) {
        // md / bib 之类：套 latex 语法会整篇乱色，结构检查也会满屏误报
        try {
          if (latexSyntaxReady && model.getLanguageId() === LATEX_LANG) {
            m.editor.setModelLanguage(model, 'plaintext')
          }
        } catch (error) { /* 语法未就绪就先放着 */ }
      } else {
        try {
          if (latexSyntaxReady && model.getLanguageId() !== LATEX_LANG) {
            m.editor.setModelLanguage(model, LATEX_LANG)
          }
        } catch (error) { /* 语法未就绪就先放着 */ }
      }
      // 脏标记对所有文件生效（md 也要显示未保存）；结构检查只对 tex
      if (!model.__dmzLintBound) {
        model.__dmzLintBound = true
        model.onDidChangeContent(function () {
          if (tab) {
            tab.dirty = true
            updateTabDirty(tab)
          }
          if (isTex) scheduleLint(model)
        })
      }
      if (isTex && latexSyntaxReady) scheduleLint(model)
    }

    /** 更新顶栏标题：文件名 + 未保存标记。 */
    function refreshWorkbenchTitle() {
      if (!wb.titleEl) return
      var f = state.wbFile
      if (!f) { wb.titleEl.textContent = '未打开文件'; return }
      wb.titleEl.textContent = f.name + (f.dirty ? ' •' : '')
      wb.titleEl.title = f.relPath
    }

    // --region 多标签

    /**
     * 多标签模型：
     *  - state.wbTabs 是打开的文件列表，每项持一个 Monaco model（内容/撤销栈/光标独立）；
     *  - state.wbFile 始终指向当前激活的标签，旧代码（编译、诊断、保存）一行不用改；
     *  - 切标签 = 保存 viewState → setModel → 恢复 viewState，光标和滚动位置都还在。
     */

    /** 重绘标签栏。只在开/关/切标签时调用，输入时不重绘（避免打断 IME）。 */
    function renderTabBar() {
      if (!wb.tabsEl) return
      var strip = wb.tabsEl
      // 记住横向滚动位置：标签多到要滚动时，重绘不该把整排弹回最左边
      var scrollLeft = strip.scrollLeft || 0
      // 用 children 逐个摘而不是 textContent=''：后者在真 DOM 上会连带清掉事件绑定的节点，
      // 而测试桩（check-embed）没有 firstChild，两边都能跑的只有这条路。
      while (strip.children && strip.children.length) strip.removeChild(strip.children[0])
      if (!state.wbTabs.length) {
        strip.style.display = 'none'
        return
      }
      strip.style.display = ''
      for (var i = 0; i < state.wbTabs.length; i++) {
        var tab = state.wbTabs[i]
        var el = document.createElement('div')
        el.className = 'dmz-wb-tab' + (tab === state.wbFile ? ' dmz-wb-tab-active' : '')
        el.title = tab.relPath
        el.setAttribute('data-dmz-tab', tab.relPath)

        var name = document.createElement('span')
        name.className = 'dmz-wb-tab-name'
        name.textContent = tab.name
        el.appendChild(name)

        if (tab.dirty) {
          var dot = document.createElement('span')
          dot.className = 'dmz-wb-tab-dot'
          dot.title = '未保存'
          el.appendChild(dot)
        }

        var close = document.createElement('button')
        close.className = 'dmz-wb-tab-close'
        close.type = 'button'
        close.textContent = '×'
        close.title = '关闭（Ctrl+W）'
        // 点 × 不该连带触发切标签
        close.addEventListener('click', (function (t) {
          return function (event) {
            event.preventDefault()
            event.stopPropagation()
            closeWorkbenchTab(t)
          }
        })(tab))
        el.appendChild(close)

        el.addEventListener('click', (function (t) {
          return function () { activateTab(t) }
        })(tab))
        // 中键关闭，和浏览器标签一致
        el.addEventListener('mousedown', (function (t) {
          return function (event) {
            if (event.button === 1) {
              event.preventDefault()
              closeWorkbenchTab(t)
            }
          }
        })(tab))

        strip.appendChild(el)
      }
      if (scrollLeft) strip.scrollLeft = scrollLeft
    }

    /** 脏标记就地更新（不重绘整个标签栏，打字时不打断）。 */
    function updateTabDirty(tab) {
      if (!wb.tabsEl || !tab) return
      var nodes = wb.tabsEl.querySelectorAll('[data-dmz-tab]')
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute('data-dmz-tab') !== tab.relPath) continue
        var hasDot = !!nodes[i].querySelector('.dmz-wb-tab-dot')
        if (tab.dirty && !hasDot) {
          var dot = document.createElement('span')
          dot.className = 'dmz-wb-tab-dot'
          dot.title = '未保存'
          nodes[i].insertBefore(dot, nodes[i].querySelector('.dmz-wb-tab-close'))
        } else if (!tab.dirty && hasDot) {
          nodes[i].removeChild(nodes[i].querySelector('.dmz-wb-tab-dot'))
        }
        break
      }
      if (tab === state.wbFile) refreshWorkbenchTitle()
    }

    /** 切到指定标签（保存当前视图状态，恢复目标视图状态）。 */
    function activateTab(tab) {
      if (!tab || tab === state.wbFile) return
      var ed = wbEditor
      if (ed && state.wbFile && state.wbFile.model) {
        try { state.wbFile.viewState = ed.saveViewState() } catch (error) { /* 保存失败就丢一次光标 */ }
      }
      state.wbFile = tab
      state.tex = tab.relPath
      if (ed && tab.model) {
        try {
          ed.setModel(tab.model)
          if (tab.viewState) ed.restoreViewState(tab.viewState)
          ed.focus()
        } catch (error) { report('error', '切换标签失败：' + errText(error)) }
      }
      try { wbModel = tab.model } catch (error) { wbModel = null }
      refreshWorkbenchTitle()
      renderTabBar()
      relayoutMonaco()
      status('LaTeX：切换到 ' + tab.name)
    }

    /**
     * 关闭标签。有未保存修改时先问一句——丢掉用户没保存的东西是最难被原谅的错。
     * 关闭的是当前标签时，自动激活相邻标签；全关光了就回到空状态。
     */
    function closeWorkbenchTab(tab) {
      if (!tab) return
      var idx = state.wbTabs.indexOf(tab)
      if (idx < 0) return
      if (tab.dirty) {
        var yes = false
        try {
          yes = window.confirm(tab.name + ' 有未保存的修改。\n\n确定 = 不保存并关闭\n取消 = 继续编辑')
        } catch (error) { yes = false }
        if (!yes) { status('LaTeX：已取消关闭'); return }
      }
      state.wbTabs.splice(idx, 1)
      try { if (tab.model) tab.model.dispose() } catch (error) { /* 已销毁 */ }
      if (tab === state.wbFile) {
        var next = state.wbTabs[Math.min(idx, state.wbTabs.length - 1)] || null
        state.wbFile = null
        if (next) {
          activateTab(next)
        } else {
          try {
            if (wbEditor) {
              // 空状态。复用同一个空白 model：每次 createModel 都会在 Monaco 里
              // 留一份永不释放的 model，反复「开满再关光」就会慢慢堆积。
              if (!blankModel) {
                var mm = window.monaco
                if (mm && mm.editor && typeof mm.editor.createModel === 'function') {
                  blankModel = mm.editor.createModel('', 'plaintext')
                }
              }
              if (blankModel) wbEditor.setModel(blankModel)
            }
          } catch (error) { /* 置空失败不影响关闭 */ }
          wbModel = blankModel || null
          refreshWorkbenchTitle()
          renderTabBar()
          relayoutMonaco()
        }
      } else {
        renderTabBar()
      }
      report('info', '关闭标签：' + tab.relPath + '（剩余 ' + state.wbTabs.length + ' 个）')
      status('LaTeX：已关闭 ' + tab.name)
    }

    // --endregion

    /**
     * 在工作台里打开文件。
     * 已经开着就直接切过去（不再读盘，避免覆盖未保存的修改）；
     * 没开过就新建一个标签，每个标签一个独立 model。
     * @param relPath 相对工作区路径
     * @param opts { keepPreview?: boolean } —— 打开日志之类时不要顺手把 PDF 收起来
     */
    function openWorkbenchFile(relPath, opts) {
      var keepPreview = !!(opts && opts.keepPreview)
      for (var i = 0; i < state.wbTabs.length; i++) {
        if (state.wbTabs[i].relPath === relPath) {
          activateTab(state.wbTabs[i])
          hideFileList()
          return Promise.resolve({ text: '' })
        }
      }
      return ensureWorkbenchEditor().then(function (ed) {
        return rpc('fsRead', { relPath: relPath }).then(function (res) {
          if (!res || res.ok !== true) throw new Error((res && res.error) || '读取失败')
          var data = res.data
          var m = window.monaco
          var tab = {
            relPath: relPath,
            abs: data.abs,
            name: data.name,
            mtimeMs: data.mtimeMs,
            dirty: false,
            model: null,
            viewState: null,
          }
          if (m && m.editor && typeof m.editor.createModel === 'function') {
            tab.model = m.editor.createModel(data.text, 'plaintext')
            tab.model.__dmzTab = tab
          } else {
            // 没有 createModel（异常环境）：退回旧行为，直接写进当前 model
            var cur = ed.getModel()
            if (cur) {
              cur.pushEditOperations([], [{ range: cur.getFullModelRange(), text: data.text }], function () { return null })
              tab.model = cur
              cur.__dmzTab = tab
            }
          }
          state.wbTabs.push(tab)
          if (m && tab.model) adoptWorkbenchModel(m, tab.model, tab)
          // 先让新标签成为激活态，再 setModel（activateTab 对「切到自己」是空操作，
          // 所以这里手动接上 model，再走一遍状态同步）
          if (state.wbFile && state.wbFile.model && state.wbFile !== tab) {
            try { state.wbFile.viewState = ed.saveViewState() } catch (error) { /* 忽略 */ }
          }
          state.wbFile = tab
          state.tex = relPath
          wbModel = tab.model
          if (tab.model) {
            try {
              ed.setModel(tab.model)
              ed.setPosition({ lineNumber: 1, column: 1 })
              ed.revealLine(1)
            } catch (error) { report('error', '挂载标签模型失败：' + errText(error)) }
          }
          // 看文档（md / bib 之类）时把宽度让给正文；进入 LaTeX 时不自动展开——
          // 收起是你自己选的，切换文件不该替你翻回去。
          // keepPreview 例外：从预览里点开日志时，你要的正是「边看日志边对照 PDF」。
          if (!keepPreview && !isTexPath(relPath) && wb && wb.pdfOpen) togglePdfPane(false)
          refreshWorkbenchTitle()
          renderTabBar()
          relayoutMonaco()
          hideFileList()
          var kb = Math.round(data.text.length / 1024)
          status('LaTeX：已打开 ' + data.name + '（' + kb + 'KB）')
          report('info', '工作台打开文件：' + relPath + '（' + data.text.length + ' 字符，共 ' + state.wbTabs.length + ' 个标签）')
          return data
        })
      }).catch(function (error) {
        status('LaTeX：打开失败 · ' + errText(error))
        report('error', '打开文件失败：' + errText(error))
      })
    }

    /**
     * 保存一个标签（带 mtime 冲突检测）。返回 Promise<boolean>：
     * true = 已落盘（或本来就干净），false = 失败/被用户取消。
     *
     * 返回值是给「编译前自动保存」用的：存不下去就不该继续编译，
     * 否则编译的是磁盘上的旧内容，而你会以为编译的是屏幕上的新内容。
     *
     * @param tab 目标标签
     * @param force 跳过 mtime 检查（用户已确认覆盖）
     */
    function saveTab(tab, force) {
      if (!tab) return Promise.resolve(false)
      if (!tab.dirty && !force) return Promise.resolve(true)
      var text = ''
      try {
        text = tab.model ? tab.model.getValue() : (wbEditor ? wbEditor.getValue() : '')
      } catch (error) { return Promise.resolve(false) }
      var args = { relPath: tab.relPath, text: text }
      if (!force) args.expectedMtimeMs = tab.mtimeMs
      return rpc('fsWrite', args).then(function (res) {
        if (res && res.ok === true) {
          tab.mtimeMs = res.data.mtimeMs
          tab.dirty = false
          refreshWorkbenchTitle()
          updateTabDirty(tab)
          return true
        }
        if (res && res.conflict) {
          var yes = false
          try {
            yes = window.confirm('磁盘上的 ' + tab.name + ' 已被其它程序修改。\n\n覆盖会丢失外部改动，确定覆盖吗？')
          } catch (error) { yes = false }
          if (yes) return saveTab(tab, true)
          status('LaTeX：已取消保存（' + tab.name + ' 已被外部修改）')
          return false
        }
        status('LaTeX：保存失败 · ' + ((res && res.error) || '未知错误'))
        report('error', '保存失败：' + ((res && res.error) || ''))
        return false
      }).catch(function (error) {
        status('LaTeX：保存失败 · ' + errText(error))
        return false
      })
    }

    /** 保存工作台当前标签（Ctrl+S）。 */
    function saveWorkbenchFile(force) {
      if (!state.wbFile || !wbEditor) { status('LaTeX：没有打开的文件'); return Promise.resolve(false) }
      return saveTab(state.wbFile, force).then(function (ok) {
        if (ok) {
          status('LaTeX：已保存 ' + state.wbFile.name)
          report('info', '已保存：' + state.wbFile.relPath)
        }
        return ok
      })
    }

    /**
     * 编译前把所有有改动的标签存盘。
     *
     * 这是最容易踩的一个坑，而且踩了完全不报错：编译读磁盘，编辑器里的内容只在内存。
     * 改完不保存就编译 → 编的是旧文件 → 「编译成功」，但预览里你的修改一点没变，
     * 有错也看不出来（因为那个错压根没进 TeX）。表现为「预览不跟随我的改动」。
     *
     * 所以编译变成「先存盘，再编译」。存不下去就中止，并说清为什么——
     * 宁可什么都不做，也不能拿一个和屏幕不一致的结果冒充成功。
     *
     * 串行保存而不是并发：多个文件同在一个目录，并发写容易让 mtime 检查互相干扰。
     */
    function saveAllDirtyBeforeCompile() {
      var dirty = state.wbTabs.filter(function (t) { return t.dirty })
      if (!dirty.length) return Promise.resolve(true)
      status('LaTeX：先保存 ' + dirty.length + ' 个有改动的文件…')
      report('info', '编译前自动保存 ' + dirty.length + ' 个标签：'
        + dirty.map(function (t) { return t.relPath }).join(', '))
      var chain = Promise.resolve(true)
      dirty.forEach(function (tab) {
        chain = chain.then(function (ok) {
          if (!ok) return false
          return saveTab(tab, false)
        })
      })
      return chain
    }

    /** 文件清单浮层：列出工作区里的 .tex/.md 等，点击即打开。 */
    function showFileList(docs) {
      if (!wb.el) return
      if (fileListEl && fileListEl.parentNode) fileListEl.parentNode.removeChild(fileListEl)
      var box = document.createElement('div')
      box.className = 'dmz-wb-files'

      var head = document.createElement('div')
      head.className = 'dmz-wb-files-head'
      var label = document.createElement('span')
      label.textContent = '打开文件（' + docs.files.length + '）'
      var close = document.createElement('button')
      close.type = 'button'
      close.className = 'dmz-wb-btn'
      close.textContent = '×'
      close.addEventListener('click', hideFileList)
      head.appendChild(label)
      head.appendChild(close)
      box.appendChild(head)

      var list = document.createElement('div')
      list.className = 'dmz-wb-files-list'
      if (!docs.files.length) {
        var empty = document.createElement('div')
        empty.className = 'dmz-wb-placeholder'
        empty.textContent = '工作区里没有 .tex / .md 文件'
        list.appendChild(empty)
      }
      for (var i = 0; i < docs.files.length; i++) {
        ;(function (item) {
          var row = document.createElement('button')
          row.type = 'button'
          row.className = 'dmz-wb-file'
          row.title = item.path
          var nameEl = document.createElement('span')
          nameEl.textContent = item.name
          var pathEl = document.createElement('span')
          pathEl.className = 'dmz-wb-file-path'
          pathEl.textContent = item.path
          row.appendChild(nameEl)
          row.appendChild(pathEl)
          row.addEventListener('click', function () { void openWorkbenchFile(item.path) })
          list.appendChild(row)
        })(docs.files[i])
      }
      box.appendChild(list)
      wb.el.appendChild(box)
      fileListEl = box
    }

    function hideFileList() {
      if (fileListEl && fileListEl.parentNode) fileListEl.parentNode.removeChild(fileListEl)
      fileListEl = null
    }

    function toggleFileList() {
      if (fileListEl) { hideFileList(); return }
      status('LaTeX：正在读取工作区…')
      rpc('fsList', {}).then(function (res) {
        if (!res || res.ok !== true) throw new Error((res && res.error) || '列目录失败')
        showFileList(res.data)
        status('LaTeX：工作区 ' + res.data.root)
        report('info', '文件清单：' + res.data.files.length + ' 个，根目录 ' + res.data.root)
      }).catch(function (error) {
        status('LaTeX：读取工作区失败 · ' + errText(error))
        report('error', '列目录失败：' + errText(error))
      })
    }

    // --region 源码定位（反向搜索的目标端）

    /** 路径比较用的规范化：统一分隔符、去掉开头的 `./` 与 `/`。 */
    function normRel(p) {
      return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
    }

    /**
     * 按相对路径找已打开的标签。
     *
     * 大小写按不敏感比：Windows 上 synctex 回给我们的 Input 是磁盘真实大小写，
     * 而标签里的 relPath 来自用户点选（可能是 `Chapter1.tex`），两者不该因此对不上。
     */
    function findTabByPath(relPath) {
      var want = normRel(relPath).toLowerCase()
      if (!want) return null
      for (var i = 0; i < state.wbTabs.length; i++) {
        if (normRel(state.wbTabs[i].relPath).toLowerCase() === want) return state.wbTabs[i]
      }
      return null
    }

    /**
     * 把光标放到指定行列并滚到视野中间。
     *
     * 行列都要夹一遍：synctex 的 Line 可能指向文件尾之后（PDF 里有生成内容、
     * 源码却没有对应行时），直接 setPosition 会让 Monaco 抛错并保持原位置。
     */
    function placeCursor(line, column) {
      var ed = wbEditor
      if (!ed) return false
      try {
        var model = null
        try { model = ed.getModel() } catch (error) { model = null }
        if (!model) return false
        var ln = Math.max(1, Number(line) || 1)
        var maxLn = 0
        try { maxLn = model.getLineCount() } catch (error) { maxLn = 0 }
        if (maxLn > 0 && ln > maxLn) ln = maxLn
        var col = Math.max(1, Number(column) || 1)
        try {
          var maxCol = model.getLineMaxColumn(ln)
          if (maxCol > 0 && col > maxCol) col = maxCol
        } catch (error) { /* 拿不到就按原值，Monaco 自己会夹 */ }
        ed.setPosition({ lineNumber: ln, column: col })
        if (typeof ed.revealLineInCenter === 'function') ed.revealLineInCenter(ln)
        else if (typeof ed.revealLine === 'function') ed.revealLine(ln)
        ed.focus()
        return true
      } catch (error) {
        report('error', '定位光标失败：' + errText(error))
        return false
      }
    }

    /**
     * 跳到源码位置（反向搜索 / 编译错误定位都走这里）。
     *
     * 已开着的文件切过去，没开的先开成新标签再定位。
     * @returns 是否已受理（false 表示工作台还没就绪，调用方应走兜底）
     */
    function jumpToSource(relPath, line, column) {
      var target = normRel(relPath)
      if (!target) return false
      if (!wbEditor) return false
      var tab = findTabByPath(target)
      if (tab) {
        activateTab(tab)
        placeCursor(line, column)
        return true
      }
      void openWorkbenchFile(target).then(function (data) {
        if (!data) return
        placeCursor(line, column)
      })
      return true
    }

    // --endregion

    // --endregion

    // --region 按钮注入

    function makeBuildButton(compact) {
      var button = document.createElement('button')
      button.className = 'edrv-pill edrv-pill-ghost'
      button.setAttribute('data-dsh-dmzlatexworkshop-build', VERSION)
      button.textContent = compact ? '⚙' : '⚙ 编译'
      button.title = 'LaTeX 编译当前文档（Ctrl+Alt+B）· client v' + VERSION
      button.style.cssText = 'margin-left:8px;height:22px;font-size:11px;padding:0 8px;line-height:20px;flex:none'
      button.addEventListener('click', function (event) {
        event.preventDefault()
        event.stopPropagation()
        void compileNow()
      })
      return button
    }

    function ensureTabButtons() {
      try {
        var rows = document.querySelectorAll('.edrv-tabs-row')
        for (var i = 0; i < rows.length; i++) {
          var row = rows[i]
          // 清掉热重载残留的旧版本按钮（旧实例的闭包会走旧逻辑）
          var marks = row.querySelectorAll('[data-dsh-dmzlatexworkshop-build]')
          var fresh = false
          for (var k = 0; k < marks.length; k++) {
            if (marks[k].getAttribute('data-dsh-dmzlatexworkshop-build') === VERSION) fresh = true
            else marks[k].remove()
          }
          if (fresh) continue
          row.appendChild(makeBuildButton(false))
          state.buttons++
        }
      } catch (error) { report('error', '标签栏按钮注入失败：' + errText(error)) }
    }

    var observer = null
    function watchDom() {
      ensureTabButtons()
      try {
        observer = new MutationObserver(function () { ensureTabButtons() })
        observer.observe(document.body, { childList: true, subtree: true })
      } catch (error) { report('error', 'MutationObserver 失败：' + errText(error)) }
      setInterval(function () { ensureTabButtons() }, 4000)
    }

    // --endregion

    function registerCommand(attempt) {
      if (state.commandReady) return
      var registry = null
      try { registry = window.__edrvCommands__ } catch (error) { registry = null }
      if (registry && typeof registry.register === 'function') {
        try {
          // 两个可见入口都去掉了，命令面板就是第三张牌：忘掉快捷键的人还能从这里找到。
          registry.register({
            id: 'dsh-dmzlatexworkshop.open',
            label: 'LaTeX: 打开工作台',
            order: 39,
            run: function () { openWorkbench() },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.build',
            label: 'LaTeX: 编译当前文档' + '（client v' + VERSION + '）',
            order: 40,
            run: function () { void compileNow() },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.closePreview',
            label: 'LaTeX: 关闭 PDF 预览',
            order: 41,
            run: function () { closePanel() },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.cleanAux',
            label: 'LaTeX: 清理编译产物（保留 .tex 与 .pdf）',
            order: 42,
            run: function () { void cleanArtifactsNow('aux') },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.cleanLog',
            label: 'LaTeX: 只清理日志文件',
            order: 43,
            run: function () { void cleanArtifactsNow('log') },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.forward',
            label: 'LaTeX: 光标位置定位到 PDF（正向搜索）',
            order: 44,
            run: function () { void forwardSearch() },
          })
          registry.register({
            id: 'dsh-dmzlatexworkshop.reloadSyntax',
            label: 'LaTeX: 重新加载语法高亮',
            order: 45,
            run: function () { reloadLanguageLayer() },
          })
          state.commandReady = true
          report('info', '命令已注册')
          return
        } catch (error) { report('error', '命令注册失败：' + errText(error)) }
      }
      if ((attempt || 0) < 60) setTimeout(function () { registerCommand((attempt || 0) + 1) }, 500)
    }

    function bindKeys() {
      window.addEventListener('keydown', function (event) {
        // Esc 只在浮层模式接管；嵌入右侧栏时 Esc 要留给编辑器（关补全/多光标）
        if (event.key === 'Escape' && !event.ctrlKey && !event.altKey) {
          if (!workbenchVisible() || embed.installed) return
          event.preventDefault()
          event.stopPropagation()
          closeWorkbench()
          return
        }
        if (!event.ctrlKey || !event.altKey || event.shiftKey) return
        var key = String(event.key).toLowerCase()
        if (key === 'b') {
          event.preventDefault()
          void compileNow()
          return
        }
        if (key === 'o') {
          event.preventDefault()
          // 嵌入时这个键永远是「切过去」，收起交给 DSH 的页签
          if (!embed.installed && workbenchVisible()) closeWorkbench()
          else openWorkbench()
          return
        }
        if (key === 'p') {
          event.preventDefault()
          togglePdfPane()
          return
        }
        // 焦点不在编辑器里（比如刚点过 PDF）时也能正向搜索
        if (key === 'j') {
          if (!workbenchVisible()) return
          event.preventDefault()
          void forwardSearch()
        }
      }, true)
    }

    function bindGlobalErrors() {
      window.addEventListener('error', function (event) {
        var msg = event && event.message ? event.message : 'unknown'
        var src = event && event.filename ? ' @' + event.filename + ':' + event.lineno : ''
        if (String(msg).indexOf('ResizeObserver') >= 0) return
        report('error', 'window.onerror: ' + msg + src)
      })
      window.addEventListener('unhandledrejection', function (event) {
        var reason = event && event.reason
        report('error', 'unhandledrejection: ' + errText(reason))
      })
    }

    function bindWindowResize() {
      window.addEventListener('resize', function () {
        if (!panel.el) return
        try {
          syncDockWidth(panel.el)
          if (panel.fit) relayout()
        } catch (error) { /* 尺寸调整失败不影响渲染 */ }
      })
    }

    exports.inject = ['slots']

    /**
     * 调试出口：把内部几个纯函数露出来，供 `tools/check-embed.cjs` 直接调用。
     * 反向搜索这类链路要完整的 PDF 渲染才能触达 UI，单测里造不出来；
     * 直接测「跳到某文件某行」这个终点更有效，也不会为了测试把生产路径改弯。
     */
    exports.__debug = function () {
      return {
        jumpToSource: jumpToSource,
        placeCursor: placeCursor,
        findTabByPath: findTabByPath,
        normRel: normRel,
        tabs: function () { return state.wbTabs.slice() },
        active: function () { return state.wbFile },
        compileNow: compileNow,
        buildPanel: buildPanel,
        panel: function () { return panel },
        markPreviewStale: markPreviewStale,
        clearPreviewStale: clearPreviewStale,
        showFailureCard: showFailureCard,
        clearFailureCard: clearFailureCard,
        clockOf: clockOf,
        forwardSearch: forwardSearch,
        scrollPdfTo: scrollPdfTo,
        cleanArtifactsNow: cleanArtifactsNow,
        toggleCleanMenu: toggleCleanMenu,
        hideCleanMenu: hideCleanMenu,
        whenMonaco: whenMonaco,
        probeMonaco: probeMonaco,
        flushMonacoWaiters: flushMonacoWaiters,
        setupLanguageLayer: setupLanguageLayer,
        reloadLanguageLayer: reloadLanguageLayer,
        langState: function () {
          return {
            ready: langLayerReadyFor,
            waiters: monacoWaiters.length,
            polling: !!monacoPollTimer,
            hooksBound: langHooksBound,
          }
        },
      }
    }

    exports.apply = function (ctx) {
      try { bindGlobalErrors() } catch (error) {}
      try { trackNavigation() } catch (error) { report('error', '导航跟踪失败：' + errText(error)) }
      try { watchDom() } catch (error) { report('error', 'DOM 监听失败：' + errText(error)) }
      try { bindKeys() } catch (error) { report('error', '快捷键绑定失败：' + errText(error)) }
      try { bindWindowResize() } catch (error) { report('error', '窗口尺寸监听失败：' + errText(error)) }
      try { initLanguageSupport() } catch (error) { report('error', '语言支持初始化失败：' + errText(error)) }
      try { registerCommand(0) } catch (error) { report('error', '命令注册异常：' + errText(error)) }
      try { installRightPaneWithRetry(ctx, require) } catch (error) {
        report('error', '嵌入右侧栏失败：' + errText(error))
      }
      try { announceOnce() } catch (error) { /* 提示失败不影响功能 */ }
      try {
        fetch(appUrl(PDF_VENDOR + '/build/pdf.mjs'), { method: 'HEAD', credentials: 'same-origin' })
          .then(function (res) { report('info', 'vendor pdf.mjs HEAD -> ' + res.status + ' ' + res.headers.get('content-type')) })
          .catch(function (error) { report('error', 'vendor 探测失败：' + errText(error)) })
      } catch (error) {}
      report('info', 'client v' + VERSION + ' 已就绪（url=' + location.href.slice(0, 60) + '）')
    }

    return exports
  },
})
