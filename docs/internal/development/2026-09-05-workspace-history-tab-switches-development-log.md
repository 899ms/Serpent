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
