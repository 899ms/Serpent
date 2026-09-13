# 2026-09-05 前进后退统一纳入标签页切换开发日志

> 用户需求（口语化）：前进后退目前「基于某个标签页」，要把标签页之间的切换也纳入同一条前进后退链路。示例：文件夹 A/B/C/D，标签页 F1/F2；切到 F1（在 A）→ F1:A→B → B→C → 切 F2（在 A）→ F2:A→D → 切回 F1 → 双击查看文件 K；后退要能一路倒着走完这 7 件事（含切页）。
> 状态：实现完成 + 自动化验证；**按用户要求暂不提交推送**。

## 语义定稿（用户确认）

1. **切页算一步**（视图真的变了才算；新建页本身不算、但新页把视图切到它的位置算一步）。
2. **关页**：把属于该标签页的所有步骤从历史里删掉。
3. **后退后产生新动作 → 清掉「前进」分支**（浏览器共识）。
4. **筛选/搜索/排序不进历史**（仍按每页上下文在切页时恢复）。
5. **打开查看器算一步**；后退经过它时自动切回所属页并重开。
6. **重启不保留前后分支**；**换库清空**。

## 模型变更（核心）

把「每个标签页各带一份历史栈」换成**全软件唯一一条历史时间线**，每条记录为 `{ tabId, location }`：

- `workspace-nav-history.ts`：`WorkspaceNavHistory` 增加 `currentTabId`、`setActiveTab(tabId)`、`removeTab(tabId)`、`peekTabId(delta)`；`push` 用当前活跃页打标；`back/forward` 移动游标并更新 `currentTabId`；`removeTab` 删除该页所有步骤并**折叠删除后相邻的重复步骤**（避免后退「点了没反应」）。
- `workspace-tabs.ts`：`WorkspaceTabSession` 去掉 `history`，改为持有 `location` + `viewport`（每页只存「当前在哪、滚动位置」）；新增 `setWorkspaceTabLocation`/`setWorkspaceTabViewport`。
- `use-workspace-tabs.ts`（控制器）：持有唯一一份全局历史；`selectTab`/`addTab` 记一步（回放用的 `location` 参数则不记）；`closeTab`/`closeOtherTabs` 调 `removeTab`；`resetTabs`/`restoreTabs` 重建时间线；新增 `syncActiveTabLocation()` 把活跃页的 location 跟共享游标同步（标签条名字实时刷新）；`saveActiveContext` 离开页时把滚动位置写回该历史条目。
- `App.tsx`：`navHistoryRef` 就是这条全局历史（不再随页切换）；「回放进行中」由对象身份比较改为布尔标识；`goWorkspaceBack/Forward` 若目标条目属于别的页，就**先切到那页并回放其位置**（不记新步骤）；`syncNavHistoryUi` 里同步活跃页 location。
- `workspace-tabs-session.ts`：会话只存每页当前 location，不再为每页建栈。

## 验证

- `npx tsc --noEmit`、`npx eslint <改动文件>` → 通过。
- 单测：`workspace-nav-history`（24，含跨标签页 Back/Forward、removeTab 折叠）、`use-workspace-tabs`、`workspace-tabs`、`workspace-tabs-session`、`workspace-tab-presentation` 全绿；全量 unit 仅 1 个**既有**失败 `import-source-failure`（Windows 路径解析，stash 后在 HEAD 同样失败，与本次无关）。
- E2E：
  - `tests/e2e/workspace-tabs.test.ts` → **2/2 passed**（切页 + 关页后前进后退、重启恢复标签条）。
  - 新增 `tests/e2e/workspace-tab-history.test.ts` → **1 passed**：Tab1 进「文件夹甲」→ 新建 Tab2 进「文件夹乙」→ 后退两次（第一次回 Tab2 的「所有资产」，第二次**跨页**回 Tab1 的「文件夹甲」并激活 Tab1）→ 前进两次对称回到 Tab2 的「文件夹乙」。
- 既有 `tests/e2e/shell-navigation.test.ts` 在当前机器失败于 318 行布局断言（后退按钮相对 workspace 偏移 14px 得到 0）；**stash 后在 HEAD 同样失败**，判定为既有环境问题，与本改动无关。

## 未验证 / 保留
- 真实桌面人类视觉验收（切页前进后退手感、亮暗主题）。
- packaged / Windows / Computer Use 未执行。

## 用户反馈二（提交后）：切文件夹闪烁 + 开库进度条计时

**1. 切换文件夹闪烁/整体亮度变化**
- 排查：写一次性探针 E2E 统计切一次文件夹时的 DOM 行为，并在父提交（改动前 242a77f8）与当前 HEAD 各跑一次，结果**完全一致**（导航遮罩挂载/卸载各 1 次、`aria-busy` 只 true→false 一次、网格 1 次变更）→ 本次导航重构未改变切文件夹的渲染/繁忙行为。
- 处置：可见的「亮度变化」来自导航遮罩 `.workspace-navigation-hold` 的半透明 `--canvas` 18% 覆盖层。**最终改为完全透明**（只保留拦截点击 + progress 光标）——先试过「延迟 200ms 淡入」，但加载超过 200ms 时仍会亮一下（用户实测仍有亮暗闪烁），故彻底去掉视觉淡色：切换过程不得改变屏幕亮度。探针（逐帧统计 DOM/繁忙 + sharp 逐帧量画布平均亮度）显示画布亮度恒定，闪烁源自该遮罩。

**2. 打开资源库时进度条在「选择位置」对话框阶段就开始**
- 根因：`library.open.request` 把「原生选路径对话框」与「打开」放在一次调用里，渲染层在调用前就 `setLibraryLoading` → 对话框期间进度条/计时已在跑。
- 处置：**拆分**——新增 `library.choose-path.request`（只弹对话框，返回路径或 null，main 直接响应不走 Worker）；`library.open.request` 增加可选 `libraryPath`（提供时跳过对话框）；渲染层改为**先选路径、选完再进入 loading 流程**（App `runLibraryOperation("open")`），进度条/计时从实际加载开始。创建/最近库/eagle/billfish 流程未改。
- 验证：`tsc`/`eslint` 通过；全量 unit 仅既有 `import-source-failure` 失败；`tests/e2e/library-lifecycle.test.ts` **3/3 通过**。

## 用户反馈三：切换标签页/文件夹时首帧在顶部、次帧才跳到位（闪烁）

- 排查：写一次性探针 E2E，跨一次「后退恢复」按动画帧采样 `scrollTop/scrollHeight`，判定「已有内容（extent>0）但 scrollTop=0」的帧即为闪烁帧。修复前实测：**1 个顶部帧**（`[0,7208] → [4325,7208]`）。
- 根因：视口恢复 `restoreWorkspaceNavViewport` 在 `requestAnimationFrame` 里逐帧设置，而**内容提交的那一帧已经以 `scrollTop=0` 画出来了**；此前该帧被导航遮罩盖住，前一轮把遮罩改为延迟 200ms（快速切换不显示）后暴露出来。
- 修复：
  1. `finishWorkspaceNavigation` 里 `flushSync` 掉待提交的更新并**立即**按目标视口设置 `scrollTop`（同一任务内、绘制前）；
  2. 新增 **`useLayoutEffect` + `pendingViewportRestoreRef`**：任何一次 React 提交（含稍后才落地的异步内容提交）都会在**浏览器绘制之前**把 `scrollTop` 放到目标位置（extent>0 时）；导航完成后清除 pending。rAF 循环仅用于后续布局变化的精修。
- 验证：探针实测**两条路径 topFrames 均为 0**——后退首帧 `[4325,7208]`、切页首帧 `[2163,7208]`，都不再先画顶部。已把探针沉淀为常驻回归 E2E `tests/e2e/workspace-scroll-restore.test.ts`（并加入 `test:e2e` 清单）：断言后退恢复与切页恢复的采样中 `topFrames === 0` 且首帧 `scrollTop > 0`。探针文件已删除。
