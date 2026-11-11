# dsh-dmzlatexworkshop

在 DSH 编辑器里写 LaTeX，按键就编译，右边直接看 PDF，点 PDF 跳回源码。

**全程不经过任何模型。** 它调用的就是你自己装的 TeX Live，和 VS Code 里 LaTeX Workshop 的用法一致：改文件、按一下、看效果。

---

## 它解决什么

在编辑器里改 `.tex` 之后，你需要的是一条最短路径：

```
改代码 → Ctrl+Alt+B → 几百毫秒后右侧 PDF 更新 → 有错就点错误行号
```

不需要向 AI 描述需求，不需要等模型响应，不消耗 token。编译一次 500ms 左右（19 页文档实测 555ms）。

**四个最常用的键**：`Ctrl+Alt+O` 打开工作台 · `Ctrl+Alt+B` 编译 · `Ctrl+Alt+J` 光标跳到 PDF · `Ctrl+点击` PDF 跳回源码。全部快捷键见 [快捷键](#快捷键)。

---

## 包含什么

| 能力 | 对应 VSCode 里的 | 状态 |
|---|---|---|
| 一键编译（`latexmk -xelatex`） | LaTeX Workshop 的 Build | ✅ |
| 右侧 PDF 预览，随编译自动刷新 | PDF viewer 标签页 | ✅ |
| Ctrl+点击 PDF → 跳回源码对应行 | SyncTeX 反向搜索 | ✅ |
| 预览分栏、不盖住代码，宽度可拖 | 编辑器组分栏 | ✅ |
| 语法高亮 + 括号配对配色 | LaTeX 语法扩展 | ✅ |
| 多文件标签页，各自保留光标与撤销历史 | 编辑器标签栏 | ✅ |
| 配色跟随本机 VSCode 主题 | —（VSCode 本来就有） | ✅ |
| 编译错误标红、结构问题标黄 | Problems 面板 + 波浪线 | ✅ |
| 行号栏红/黄竖条定位出错行 | 行号栏装饰 | ✅ |
| 悬停预览 `$…$` / `\[…\]` / 数学环境 | LaTeX Workshop 的 Math Preview | ✅ |
| 悬停预览 `\ref` 指向的公式 / 图 / 章节 | LaTeX Workshop 的 Reference Peek | ✅ |
| 自动换行（预览期间） | `editor.wordWrap` | ✅ |
| 源码 → PDF 正向搜索 | SyncTeX 正向搜索 | ✅ |
| 清理编译产物（顶栏「清理」按钮） | LaTeX Workshop 的 Clean up auxiliary files | ✅ |
| 拼写检查 | Code Spell Checker | ❌ 见「已知限制」 |

**写、编、看、跳、查错这五步都在编辑器内完成**，不需要切窗口，也不需要模型参与。

---

## 功能

### 语法高亮（配色跟随 VSCode）

DSH 的编辑器默认把 `.tex` 当纯文本（扩展名映射表里没有 tex）。插件注册了 `latex` 语言并接管 `.tex`，命令分类直接照搬 **LaTeX Workshop** 的 TextMate 语法：

| 写法 | 归入的 scope | Light Modern 下的颜色 |
|---|---|---|
| `%` 注释 | `comment.line.percentage.latex` | 绿 |
| `\documentclass` `\usepackage` | `keyword.control.preamble.latex` | 紫 |
| `\newcommand` `\def` `\newenvironment` | `storage.type.function.latex` | 蓝 |
| `\cite*` 全家 | `keyword.control.cite.latex` | 紫 |
| `\ref` `\eqref` `\autoref` `\cref` | `keyword.control.ref.latex` | 紫 |
| `\label` / `\input` `\includegraphics` | `keyword.control.label/include.latex` | 紫 |
| `\section` `\chapter` `\paragraph` | `support.function.section.latex` | 橄榄 |
| `\textbf` `\textit` `\emph` `\url` `\verb` | `support.function.*.latex` | 橄榄 |
| 其它所有 `\foo` | `support.function.general.latex` | 橄榄 |
| `\begin{itemize}` 里的环境名 | `variable.parameter.function.latex` | 深蓝 |
| 数学环境体 `equation` / `align` 等 | `support.class.math.block.environment.latex` | 青 |
| `\%` `\{` `\&` 等转义 | `constant.character.escape.latex` | 红 |
| 公式块 `$…$` / `$$…$$` / `\[…\]` / `\(…\)` | `support.class.math.block.*` | 青，**整块同色** |
| 数学环境 `equation` `align` … 的环境体 | `support.class.math.block.environment.latex` | 青，整块同色 |

公式这几行是**整块着色**，不是只给命令上色：VSCode 的 TextMate 语法给 `$…$` 的整个范围挂了 `meta.math.block.tex support.class.math.block.tex`，块内所有文字——包括定界符本身、字母、数字、运算符——都落到同一个色（Light Modern 下是 `#267F99`）。`\begin{equation}…\end{equation}` 同理，连环境体内部一起算。

所以看代码时公式是一个**完整的色块**，边界靠颜色本身就能认出来。块内的命令仍是橄榄色（`\frac`、`\int` 的 scope 栈顶是 `support.function`，比外层的 `support.class` 更具体），这一点也和 VSCode 一致。

实现上用 Monarch 的状态栈：进 `$` 切到 `inlineMath`、遇 `\begin{equation}` 切到 `mathEnv`，块内每条规则兜底到数学色；数学环境嵌套（`equation` 里套 `aligned`）靠 `@push` / `@pop` 维持层级，退出时逐层还原。

**这些颜色不是写死的**：插件启动时读取你本机 VSCode 的 `workbench.colorTheme`，找到对应主题文件（递归展开 `include` 链），再按 TextMate 的「最具体匹配」规则，为上面每个 scope 求出真实颜色。所以你在 VSCode 里换了主题，这里的配色跟着变。

同时 `\begin{env}` / `\end{env}` 会拆成三段：命令、花括号、环境名各自着色；花括号开启配对配色，按嵌套层级显示不同颜色。

### 编译

- 一键编译当前 `.tex`，自动用 `latexmk -xelatex` 处理多趟编译、参考文献、交叉引用
- 参数：`-synctex=1 -interaction=nonstopmode -file-line-error`
- **编译前自动保存**所有有改动的标签。编译器读的是磁盘，编辑器里的内容只在内存——
  不保存就编译，编的是旧文件，却会报「成功」，你的修改一个字都没进去（这是最难查的一类假成功）。
  保存失败就中止编译并说明原因，绝不拿和屏幕不一致的结果冒充成功
- 当前标签是 `.md` 时，编译目标自动退回最近打开的那个 `.tex`，不会把 md 交给 latexmk
- 编译结果写进状态栏：页数、耗时、警告条数
- 错误按 `./main.tex:42: Undefined control sequence` 的格式逐行解析，保留文件与行号

### PDF 预览

- 右侧分栏显示，**编辑器让出空间**而不是被盖住
- 懒渲染：只画进入视口的页面，几十页的论文也不吃内存
- 工具栏：缩小、放大、适应宽度、重新读取、关闭；拖动左边界可调宽度
- 编译后自动刷新，并**保持原来的滚动位置**，不会跳回第一页
- 预览期间自动开启代码自动换行（`wordWrap: on`），关闭预览时还原为你的原设置
- **编译失败时会明说**，不让你把旧 PDF 当成新结果（见下）

#### 日志：出问题时看什么

编译会在**源文件同目录**留下两份日志，分工不同：

| 文件 | 内容是 | 谁需要 |
|---|---|---|
| `<stem>.log` | TeX 引擎自己的日志：每个错误、`l.42` 处的源码上下文、Warning、Overfull | 定位「哪里写错了」 |
| `<stem>.latexmk.log` | latexmk 自己的完整输出：退出码、跑了几趟、缺哪个文件、`did not complete building` 的原因 | 定位「为什么没编完」——这类失败在 `.log` 里完全没有 |

`.latexmk.log` 头部有生成时间、命令、退出码、耗时，正文是原封不动的 stdout+stderr（超 512KB 掐头去尾并注明省略多少字符）。

**给 AI 用**：这两份都是工作区里的普通文件，路径规则固定（源文件同名），直接读即可，不需要知道 `~/.dsh` 在哪。编译失败时预览的红色横幅里也有「完整输出：xxx.latexmk.log（点开查看）」，点一下就在工作台里开成标签——**不会收起 PDF**，方便对照。

另有插件自己的运行日志 `~/.dsh/dsh-dmzlatexworkshop/client.log`，记录每次编译的开始/成败与错误摘要（前 10 条），适合追「某次编译到底发生过什么」。

#### 这些文件会堆积吗

不会。`.latexmk.log` 是**覆盖写**，文件名固定为 `<stem>.latexmk.log`，所以编 100 次还是一个文件（实测：连编 4 次，目录文件数从 11 稳定在 12 不再增长）。文件总量 = **文档数量**，不是编译次数。

唯一的边角：`latexmk -C` 不认识这个文件，会留下孤儿。所以插件提供清理命令（命令面板）：

| 命令 | 作用 |
|---|---|
| `LaTeX: 清理编译产物（保留 .tex 与 .pdf）` | 删 `.aux` `.log` `.latexmk.log` `.fls` `.fdb_latexmk` `.out` `.toc` `.xdv` `.synctex.gz` `.bbl` 等 20 多种可再生产物 |
| `LaTeX: 只清理日志文件` | 只删 `.latexmk.log` / `.log` / `.blg`，不动其它 |

**只按白名单删，绝不碰 `.tex` / `.pdf` / `.bib`**，也不动不认识的扩展名（比如同目录的 `.txt`、图片）。清理是幂等的，没有产物就静静退出。

#### 编译失败时：预览会被标记为「陈旧」

latexmk 编译失败时不覆盖磁盘上的 PDF，所以预览里显示的仍是**上一次成功的版本**。
这种「看起来一切正常，其实你改的一个字都没进去」的状态，比白屏更误导人。所以失败时会：

1. 预览顶部出现红条：`✗ 编译失败 · main.tex:12 Undefined control sequence（共 3 个错误）· 下面是 10:42:07 的旧版本`
2. **页面变暗**（灰度 + 降透明度，鼠标移上去恢复可读）—— 视线落在页面上时也能看出这不是当前结果
3. 有多个错误时直接**展开错误列表**，点任意一行跳到源码对应行，不用回编辑器找波浪线
4. 还没有生成过 PDF（首次编译就失败）时，预览栏里直接铺错误卡片，而不是干巴巴一句「编译后在这里显示 PDF」
5. 红条下方有「完整输出：xxx.latexmk.log（点开查看）」。**没有结构化错误时**（latexmk 中途放弃、引擎没起来），列表里直接铺 latexmk 输出的最后 40 行——这类失败只有它能说明白

旧 PDF 不会被销毁——改坏之后往往想对照上一版。下次编译成功，红条、变暗、列表一起消失。

### 诊断（波浪下划线）

两类标记同时存在，互不覆盖：

| 颜色 | 来源 | 覆盖范围 |
|---|---|---|
| 红色 | `latexmk` 编译日志 | 真实编译错误，按 `文件:行` 精确落点，整行标红 |
| 黄色 | 结构检查 | `{` 未闭合、多余的 `}`、`\begin`/`\end` 不匹配、数学符未闭合 |

结构检查在你打字时防抖 450ms 触发，只报确定的问题，不做命令词典校验（误报太多反而干扰写作）。编译成功后红色标记自动清除。

除了文字下方的波浪线，**行号栏右侧也会出现同色竖条**（红=编译错误，黄=结构问题），悬停竖条能看到具体信息。长文档翻页时不必一处处找波浪线，扫一眼行号栏就知道哪几行有问题。编译成功时竖条同步清空。

### 行号

编辑器左侧行号由插件显式固定为 `lineNumbers: 'on'`（Monaco 默认本来就是开的，写死是防止被其它插件或将来改默认值影响）——编译错误定位、结构检查、`\ref` 预览的「第 N 行」都依赖它。

### 公式悬停预览

鼠标停在公式上约 0.26 秒，弹出排版后的公式：

- 支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`，以及 `equation` / `align` / `gather` / `multline` / `eqnarray` / `cases` 等数学环境
- **跨行公式同样生效**（`\[` 与 `\]` 分行写、环境体多行都没问题）
- AMS 环境会自动转成 KaTeX 认识的形式（`align` → `aligned`，`gather` → `gathered`），并剥掉 `\label` / `\nonumber` / `\notag`
- 用随包的 KaTeX 渲染（完整 HTML 输出，排版与网页一致），20 个 woff2 字体以 data URI 内联进样式，不依赖网络
- **公式过宽或过高时出滚动条，按原尺寸拖动查看**（不做等比缩小）；竖直滚轮自动转成横向滚动
- 卡片可以接收鼠标交互：移入时不消失，移出后约 0.4 秒收起
- 卡片自动避让窗口边缘

### 交叉引用预览（\ref → label）

鼠标停在 `\ref{...}` / `\eqref{...}` / `\autoref{...}` / `\cref{...}` 的 key 上约 0.26 秒，弹出该 label 处的实际内容：

```
\ref{eq:pvalue}                        equation · 第 78 行
Notation
────────────────────────────────────────────────
\begin{equation}\label{eq:pvalue}
P_j=\frac{1+\#\{i:\; C_i\ge S_j\}}{n+1}=(1+A_j)\delta,
\qquad A_j:=\#\{i:\; C_i\ge S_j\},\qquad \delta:=\frac1{n+1}.
\end{equation}
```

预览内容按「具体程度」三选一：

| label 的位置 | 显示什么 |
|---|---|
| 在 `equation` / `figure` / `table` / `theorem` 等环境里 | 整个环境（超过 40 行或 18 行时截断，围绕 label 取） |
| 直接写在 `\section{...}` 后面（落在 `document` 里） | 该节开头，一直到下一个同级标题之前 |
| 其它位置 | label 上下各 4 行 |

标题按层级划定范围（`\section` 的跨度包含它下面的 `\subsection`），所以 `\ref{sec:xxx}` 看到的是这一节的真实开头，而不是只有标题一行。

索引按 model 版本缓存，改完即重扫；全文 38k 字符的一篇论文，建立索引约 1ms。**只处理同一文档内的 label**，跨文件的 `\ref` 不会命中（多文件项目请把 label 和 ref 放在同一文件，或用 `\input` 合并后编译）。

### 反向搜索（PDF → 源码）

- 在 PDF 上 `Ctrl+点击`（或 `Alt+点击`），跳到对应的 `.tex` 行
- 坐标经 SyncTeX 换算，实测往返一致
- 跳转发生在工作台内部：目标文件已打开就切到那个标签并定位光标，没打开就自动开成新标签
- 以当前显示的那份 PDF 为准，所以编译某个文件后切到别的标签再点，也不会找错源文件

### 正向搜索（源码 → PDF）

- 光标停在某行，按 `Ctrl+Alt+J`（或命令面板「LaTeX: 光标位置定位到 PDF」），PDF 滚到对应位置并在落点闪一下
- 落点放在视口上三分之一处：上面留上下文，下面留续读
- 预览收着会自动展开；PDF 还没打开会先加载
- **从子文件发起也准**：`\input{sec/a.tex}` 里的光标会按 `a.tex` 的行号去查，落到主文档那份 PDF 上；不会拿子文件行号去当主文件的行号
- 依赖 `-synctex=1`（默认已带），没编译过则提示先编译

### 清理编译产物

顶栏「编译」与「收起预览」之间的**「清理」**按钮，点开两个粒度：

| 选项 | 删什么 |
|---|---|
| 清理编译产物 | `.aux` `.log` `.latexmk.log` `.fls` `.fdb_latexmk` `.out` `.toc` `.xdv` `.synctex.gz` `.bbl` 等 27 种可再生产物 |
| 只清理日志 | `.log` / `.latexmk.log` / `.blg`，留着 aux 让下次编译快一点 |

只清当前文档，只按白名单扩展名删，`.tex` / `.pdf` / `.bib` 与任何不认识的扩展名一律不碰。命令面板里也有同样两条。

### 跟随布局

- 左侧会话栏收起/展开、窗口缩放时，预览区自动重算位置与宽度，始终贴住代码区右边缘

---

## 环境要求

| 项目 | 要求 |
|---|---|
| TeX 发行版 | TeX Live（需含 `latexmk`、`xelatex`、`synctex`） |
| 验证方式 | `latexmk --version`、`synctex --version` 均可用 |
| DSH | 需启用 `dsh-vscode-mode`（提供编辑器、标签栏与 pdf.js 资源） |

当前环境：TeX Live 2024（`C:\texlive\2024\bin\windows`）。

---

## 安装

插件以 `link:` 方式挂在 profile 里，源码目录即生效目录，改完重启应用即可。

**从 GitHub 安装：**

```bash
git clone https://github.com/LeFantas/dsh-latexworkshop.git \
  ~/.dsh/profiles/desktop/.local-plugins/dsh-dmzlatexworkshop
```

目录名用 `dsh-dmzlatexworkshop`（与 `package.json` 的 `name` 一致），仓库名只是仓库名。

```
~/.dsh/profiles/desktop/
├── package.json                              # dependencies + dsh.profile.bundles
├── node_modules/dsh-dmzlatexworkshop         # junction 指向下方目录
└── .local-plugins/dsh-dmzlatexworkshop/
    ├── package.json
    ├── cordis.patch.yml
    └── lib/{index.js, client.js, compile.js}
```

`package.json` 需要两处登记，缺一不可：

```jsonc
{
  "dependencies": {
    "dsh-dmzlatexworkshop": "link:./.local-plugins/dsh-dmzlatexworkshop"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* ... 必须包含 "dsh-dmzlatexworkshop" ... */ ]
    }
  }
}
```

- 只在 `dependencies` 不在 `bundles` = 装了但不加载
- 改动清单前**必须关闭应用**，否则 pnpm 会因文件被占用而失败，并可能连带清空 `bundles`

### 从压缩包安装（分发给他人）

1. 解压，让目录落到 profile 的插件目录下：

```
<DSH_HOME>/profiles/desktop/.local-plugins/dsh-dmzlatexworkshop/
```

2. 编辑 `<DSH_HOME>/profiles/desktop/package.json`（**先关闭 DSH**），加两处：

```jsonc
{
  "dependencies": {
    "dsh-dmzlatexworkshop": "link:./.local-plugins/dsh-dmzlatexworkshop"
  },
  "dsh": {
    "profile": {
      "bundles": [ /* 原有条目保持不变，追加一项 */ "dsh-dmzlatexworkshop" ]
    }
  }
}
```

3. 在 `<DSH_HOME>/profiles/desktop` 下建目录链接（cmd 执行）：

```
mklink /J node_modules\dsh-dmzlatexworkshop .local-plugins\dsh-dmzlatexworkshop
```

4. 启动 DSH。日志出现 `client v1.0.0 已就绪` 即安装成功（版本号以实际为准）。

> 若第 3 步的 `mklink` 报权限错误，先在 `<DSH_HOME>/profiles/desktop` 下执行
> `pnpm install --offline`，pnpm 会按 `link:` 依赖自动建好链接。

---

## 使用

工作台嵌在**官方右侧栏的「LaTeX」页签**里，左边写代码、右边看 PDF，中央对话照常可见。把右侧栏拖宽一点，两侧都会更舒服。

进入方式：**在右侧栏页签栏里点「LaTeX」**，或按 `Ctrl+Alt+O`。没有额外的浮动按钮或侧栏按钮——工作台就住在那个页签里，收放交给 DSH 自己的页签栏。

1. 点右侧栏的「LaTeX」页签（或 `Ctrl+Alt+O`）
2. 点顶栏「文件」选一个 `.tex`，或让它在打开时自动带出
3. 点「编译」，或按 `Ctrl+Alt+B`
4. 在 PDF 上 `Ctrl+点击`，跳回对应源码行；反向则由 `Ctrl+Alt+J` 从光标跳到 PDF
5. 改完按 `Ctrl+S` 保存（磁盘被外部改过会先问你）
6. 产物攒多了点顶栏「清理」收拾掉（`.tex` 与 `.pdf` 不会被碰）

**多标签**：可以同时打开多个 `.tex` / `.md` 文件，每个文件一个标签，排在代码区顶部。点标签切换（光标、滚动位置、撤销历史都各归各的），点 `×` 或中键关闭；有未保存修改的标签带蓝点，关闭前会先问一句。重复打开同一个文件不会新增标签，只切过去。`Ctrl+W` 关闭当前标签。

工作台的分隔条可以拖，双击回到 46%，宽度记在 `localStorage` 里。

**预览可折叠**：只改代码或看 `.md` 时点顶栏「收起预览」（`Ctrl+Alt+P`），代码区就占满整个页签。再点展开时 PDF 还是原样（滚动位置、缩放都在），不需要重编译。打开 `.md` / `.bib` 等非 LaTeX 文档时会自动收起；切回 `.tex` 不会自动展开，保持你上次的选择。收起时再编译，状态栏会提示「预览已收起」，不会抢着弹开。

### 快捷键

本插件**只注册下面这些键**，不改动 DSH 或 Monaco 的任何默认快捷键（`Ctrl+Z`、`Ctrl+F`、`Ctrl+/` 注释等仍是 Monaco 原样）。全部为固定绑定，暂不支持自定义。

**工作台与编译**

| 操作 | 键 | 备注 |
|---|---|---|
| 打开 / 切到工作台 | `Ctrl+Alt+O` | 嵌入模式下是「切过去」，不关闭 |
| 编译当前文档 | `Ctrl+Alt+B` | 编译前自动保存所有有改动的标签 |
| 收起 / 展开 PDF 预览 | `Ctrl+Alt+P` | 等同顶栏「收起预览 / 展开预览」 |
| 关闭工作台浮层 | `Esc` | **仅降级浮层模式**；嵌入右侧栏时 `Esc` 留给编辑器 |
| 收起「清理」下拉菜单 | `Esc` | 打开菜单后按，等同点空白处 |

**文件与标签**

| 操作 | 键 | 备注 |
|---|---|---|
| 保存当前文件 | `Ctrl+S` | 焦点须在编辑器内；磁盘被外部改过会先问你 |
| 关闭当前标签 | `Ctrl+W` | 焦点须在编辑器内；有未保存修改会先确认 |

**导航**

| 操作 | 键 | 备注 |
|---|---|---|
| 反向搜索（PDF → 源码） | `Ctrl+点击` / `Alt+点击` | 点在 PDF 页面上 |
| 正向搜索（源码 → PDF） | `Ctrl+Alt+J` | 光标停在哪行，PDF 滚到哪 |

**鼠标操作**

| 操作 | 方式 | 备注 |
|---|---|---|
| 关闭标签 | 中键点击标签 / 点标签上的 `×` | 与浏览器标签一致 |
| 调整分栏宽度 | 拖动中间分隔条 | 宽度记在 `localStorage` |
| 分栏复位 | **双击**分隔条 | 回到 46% |
| 跳到错误所在行 | 点预览红条下的错误行 | 编译失败时展开的列表 |

**没有快捷键的两项**：清理编译产物（顶栏「清理」按钮，或命令面板）、关闭 PDF 预览面板（命令面板）。

> 命令面板里搜 `LaTeX:` 可以看到全部七条命令，包括上面「没有快捷键」的两项与「重新加载语法高亮」。忘掉按键时从那里找，比记表格可靠。
>
> 按键都在 `lib/client.js` 集中注册：`Ctrl+S` / `Ctrl+W` / `Ctrl+Alt+J` 走 Monaco 的 `addCommand`（光标在编辑器里时 Monaco 会先吃按键，window 监听收不到），其余走 window 捕获阶段。因此 `Ctrl+Alt+J` 两处都挂了，光标在编辑器内外都能用。

> 若右侧栏服务不可用（老版本 DSH），插件自动退回整屏浮层：`Ctrl+Alt+O` 打开，`Esc` 关闭。此时没有可见按钮——浮层模式本来就是降级路径，只在服务缺失时才会出现。

---

## 配置（可选）

插件默认跟随 VSCode 当前主题，一般不用配。需要改时，在 `~/.dsh/dsh-dmzlatexworkshop/config.json` 写：

```json
{
  "followVscode": true,
  "vscodeTheme": "One Dark Pro"
}
```

| 字段 | 说明 |
|---|---|
| `followVscode` | 设成 `false` 就不读 VSCode，改用内置色板（按界面明暗自动选深浅一套） |
| `vscodeTheme` | 指定读哪个主题的名字，留空则用 VSCode 设置里的 `workbench.colorTheme` |

改完重启应用生效。日志里会打印实际读到的主题名、规则条数与命中数，可直接核对：

```
已套用 VSCode 配色：Light Modern（light）· 规则 180 条 · latex 命中 29/36 · 背景 FFFFFF
```

36 个 scope 里命中 29 个。剩下 7 个是 `punctuation.definition.arguments.*` / `group.*` / `function.*` 这类括号，VSCode 主题普遍不单独定色，落到默认前景 —— 这也正是 VSCode 里它们的样子，而花括号另有彩虹括号负责上色。

**找不到 VSCode 时**（比如把这插件给没装 VSCode 的人），会自动退回内置色板，功能不受影响。

---

## 工作原理

```
┌─ 客户端（编辑器内） ────────────┐      ┌─ 宿主进程 ──────────┐
│ 按钮 / 快捷键 / 命令            │      │                     │
│        │                        │ POST │  /latex/rpc         │
│        └────────────────────────┼─────▶│   compile           │
│                                 │      │   synctexEdit       │
│  pdf.js（canvas 自己画）        │◀─────┤   readPdf (base64)  │
│        ▲                        │      │        │            │
│        │ base64 → Uint8Array    │      │        ▼            │
│  IntersectionObserver 懒渲染    │      │  latexmk → xelatex  │
└─────────────────────────────────┘      └─────────────────────┘
```

- **宿主半**（`lib/index.js`）注册两条 HTTP 路由：`/latex/rpc` 执行业务、`/latex/log` 收客户端诊断日志。子进程只能由宿主启动，浏览器做不到。
- **编译核心**（`lib/compile.js`）纯 Node 内置模块，不依赖 DSH 服务，可以脱离应用直接用 `node` 测试。
- **客户端半**（`lib/client.js`）负责 UI、pdf.js 渲染、SyncTeX 坐标换算，以及通过 `window.monaco` 注册语言/诊断/悬停。

语言支持走 Monaco 的公开 API（AMD 构建，加载后会挂 `window.monaco`）：`languages.register` + `setMonarchTokensProvider` 提供语法，`editor.setModelMarkers` 画波浪线，`editor.onMouseMove` 驱动公式卡片。

配色由 `lib/vscode-theme.js` 在宿主侧解析：定位 VSCode 安装目录（新版把 app 放在哈希子目录里，两种布局都兼容）→ 读 `%APPDATA%/Code/User/settings.json` 的 `workbench.colorTheme` → 在扩展的 `contributes.themes` 里按 `id` / 英文 label / 本地化 label 三路匹配（内置主题的 label 是 `%lightModernThemeLabel%` 这种占位符，得从 `package.nls*.json` 展开）→ 递归合并 `include` 链 → 对每个 scope 取「匹配段数最多」的规则。带空格的后代选择器（如 `source.css variable`）一律丢弃，因为 Monaco 表达不了上下文，误用会把 LaTeX 的环境名染成 CSS 的颜色。

KaTeX 走 `/latex/rpc` 的 `readKatex`：宿主把运行时、样式和 20 个 woff2 字体一次交回（字体在宿主侧就替换成 data URI），客户端注入 `<style>` 与内联 `<script>`。这样做不需要静态文件路由，也不依赖 `font-src` 是否放行外部文件。

PDF 渲染细节：pdf.js 的 `build/pdf.mjs` 通过注入 inline `<script type="module">` 加载（不能用 `import()`——客户端包会被打包器改写，URL 语义会坏），字节由宿主以 base64 送回，`getDocument({ data })` 后逐页 `page.render()` 到 canvas。

---

## 故障排查

两份日志，先看哪份取决于"卡在哪"：

```
<源文件同目录>/xxx.latexmk.log    ← latexmk 为什么没编完（缺引擎/缺 .sty/中途放弃）
<源文件同目录>/xxx.log            ← TeX 引擎报了什么错（含 l.42 源码上下文）
~/.dsh/dsh-dmzlatexworkshop/client.log   ← 插件自己记录的每次编译成败
```

前者在编译失败时也能从预览的红条里点开（「完整输出：…」）。

### 常见症状

| 症状 | 原因与处理 |
|---|---|
| 点了没反应、日志里没有 `compile 开始` | 按钮/命令绑到了旧实例。完全退出应用重启（热重载不卸载旧模块） |
| `✗ 编译失败` + 行号 | 正常的 LaTeX 错误，按行号改源码 |
| `synctex 未找到对应位置` | 未生成 `.synctex.gz`，确认编译参数含 `-synctex=1` 并重新编译 |
| PDF 区域空白 | 看日志有没有 `pdf.js 解析成功`。有 ⇒ 渲染层问题；无 ⇒ 加载层问题 |
| `pdf.js 加载失败` | `/edrv/vendor/pdfjs` 路由不可达，检查 `dsh-vscode-mode` 是否完整 |
| 代码区没变窄、出现横向滚动条 | 日志里看 `edrv-editor-area=` 是否等于 `基数 - 面板宽` |
| 预览飘离右边缘 | 日志里应有 `外壳变化 ... → 重新布局`；没有则 `ResizeObserver` 未生效 |
| **整片代码没有颜色** | 语法层还没装上。命令面板执行「LaTeX: 重新加载语法高亮」即可当场恢复；日志里若见 `Monaco 已就绪（等了 N 秒）` 说明是晚到后自动补装的正常路径 |

### 手动验证编译链路

不启动应用也能测：

```bash
cd /path/to/docs
latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error main.tex
synctex view -i 50:1:main.tex -o main.pdf     # 源码 → PDF
synctex edit -o 1:68:161:main.pdf             # PDF → 源码
```

---

## 已知限制

- **拼写检查未做**。词典其实不缺——LibreOffice 自带的 hunspell（`en_US.dic` 539KB / 49568 词根 + `en_US.aff` 73 条词缀规则）可以直接用。没做的原因是误报控制：得先把 `\section` 的参数（自然语言，该查）和 `\ref`/`\label` 的 key（标识符，不该查）区分开，再配一份统计领域的术语词表，否则 `nonconformity`、`p-value`、`M-estimator` 会满屏标黄。当前只做结构与编译两类诊断。
- **正向搜索要求光标所在文件参与过这次编译**。从 `\input` 的子文件发起是支持的；但若该文件没被主文档引用（或主文档换了），synctex 里没有它的记录，就会提示「未找到对应位置」。
- 公式预览对 `\newcommand` 自定义宏不生效（KaTeX 不认识），会显示成红字；`\intertext` 等少数 AMS 命令同理。
- **`\ref` 预览只在同一文档内生效**。跨文件（`\input` 拆分章节）的 label 不在当前 model 里，悬停不会弹卡片。
- `\ref` 预览不解析 `\newcommand` 定义的引用命令别名（如 `\myref{...}`），只认 `*ref` / `cref` 这一族。
- 反向搜索的 `Column` 由 synctex 给出，多数情况下是 `-1`（无列信息），此时落到行首。
- 预览是独立面板而非编辑器组的原生标签页——`dsh-vscode-mode` 未开放第三方视图注册接口，改为让编辑器让出宽度达到同等效果。
- 每次只编译当前标签对应的文件；多文件项目请切到主文件再按编译（标签之间不会互相连带）。
- 结构检查按 basename 归并诊断，不同目录下的同名 `.tex` 会共用一份标记。
- 数学环境未闭合时（`\begin{equation}` 少了对应的 `\end`），其后的正文会一直按数学色渲染到文件末尾。这是整块着色依靠状态栈的必然代价；同一种情况结构检查本来就会报「环境未闭合」，一并修掉即可恢复。

---
