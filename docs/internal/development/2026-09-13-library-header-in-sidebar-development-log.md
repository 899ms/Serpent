# 2026-09-13 资源库入口移入左侧面板 + macOS 原生资源库菜单对齐

> 用户需求（附参考图）：把「资源库名字 + 菜单入口」从顶栏移到左侧面板顶部，让标签页获得整行宽度；随后补充：头部不要分割线、前面加 Lucide `vault` 图标、样式与下方导航行一致、图标（vault 与同步状态）要紧挨标题；macOS 原生主菜单把「资源库」放第一位、条目与资源库菜单一致并支持打开最近资源库。

## 侧栏头部

- `NavigationSidebar` 新增 `libraryHeader` 插槽，渲染 `.navigation-pane-header`，承载 `LibrarySwitcher`。
- 顶栏左侧不再渲染资源库入口：`[侧栏开合] [‹ ›] [设置/主菜单]` → **标签页（占满剩余宽度）+ 新建**。
- **折叠保底**：左栏折叠时导航面板整体隐藏，此时入口回退到顶栏（`!leftOpen`），避免入口消失。实测折叠后 `inSidebar: 0, inToolbar: 1`。
- 视觉：**无分割线**；`vault` 图标（Lucide，新增到 `Icons.tsx`）与同步状态图标**紧挨标题**，仅尾部 chevron 靠右；字号/颜色/圆角/hover 与 `.nav-row` 一致（12px、`--secondary`、6px、`--hover`）。
- 实测几何：vault `x=16 w=15` → 名称 `x=38`（7px 间距），chevron `x=194`（行尾）。
- 标签页区域 **274px → 424px**（左栏 224 固定，窗口 1440）。

## macOS 原生菜单

- **顺序**：`Serpent | 资源库 | 文件 | 编辑 | 显示 | 窗口 | 帮助`（资源库移到首位）。
- **条目与资源库菜单逐项一致**：新建资源库…／打开资源库…／——／关闭资源库／移除资源库／从硬盘删除资源库／——／导入资源库／导出资源库／——／资源库设置…／——／最近使用的资源库 + 各最近库项（点击直接打开）。
- 最近库列表在**每次安装菜单时**从 `recent-library.json` 读取（`nativeMenuRecentLibraries()`），并按最近顺序渲染；菜单项 label 用真实库名（`labelValue`），无需 i18n 解析。
- 新增 `library.open-recent` 命令，携带 `payload`（库路径）：模板 → `enrichMenuTemplate` 的 click 发送 `{ command, payload }` → preload 白名单校验后转交 → Renderer 调用既有 `openRecentLibrary(path)`（与侧栏菜单同一动作）。
- 「关闭/移除/删除/导入/导出/设置」沿用既有命令通道；`labelKey` 与侧栏菜单键一致（i18n 校验脚本不扫 renderer 专用键，因此在 shared 层新增 `shell.recentLibraries` 键供原生菜单使用）。

## 验证

- `npx tsc --noEmit`、`npx eslint <改动文件>` 通过。
- 单测：`application-menu`、`main-menu`、`main-menu-items`、`i18n-translate` 全绿；全量 unit 3412 passed（唯一失败为既有 `import-source-failure` 环境问题）。
- E2E：`library-recent`、`library-lifecycle`、`workspace-tabs` 回归（见运行结果）。
- 截图：`test-results/ui-shots/sidebar-header.png`（头部样式）。

## 未验证 / 保留
- 原生菜单的**真实 macOS 视觉/点击验收**（本会话只能验证代码路径与单测；菜单项点击打开最近库需人工确认）。
- 亮/暗主题与主题变体下的头部观感、Windows 平台。

## 追加修复（用户第二轮反馈）

- **资源库标题居中**：头部内容在面板内居中（实测内容中心 x=112 = 面板中心 x=112）；vault 图标、库名、同步状态图标、chevron 作为整体居中，chevron 不再顶到行尾。
- **文件夹与固定行未对齐（根因）**：`unified-directory-nav.ts` 的 `relativePathDepth` 用 `relativePath.split("/").length`，根级文件夹得 1（固定行是 0），导致每个托管文件夹**多缩进一级 14px**。改为 `Math.max(0, split.length - 1)`；实测根级文件夹 icon x=34 / 文字 x=58，与「所有资产/资源库根目录/回收站/标签管理」一致，子级每层 +14。
- **断言同步**：`unified-directory-nav.test.ts`（depth 0/1/2）、`navigation-sidebar.test.ts`（folder 0/14；collection 保持 0/14 不变）、`linked-folders.test.ts`（Alpha 0px、linked 14px）。
- **原生菜单最近库过期**：最近库列表原先只在安装菜单时读取，打开/移除库后不更新；已在 `rememberOpenedLibrary`、忘记最近库、从硬盘删除三处调用 `refreshApplicationMenuRecentLibraries()` 重装菜单。
- **原生菜单实测**（从运行中应用导出结构）：顶层 `Serpent | 资源库 | 文件 | 编辑 | 查看 | 窗口 | 帮助`；资源库菜单条目与侧栏资源库菜单逐项一致，含「最近使用的资源库 → 库乙 / 库甲」。
