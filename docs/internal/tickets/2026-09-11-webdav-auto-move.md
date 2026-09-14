# 本地移动/改文件夹名不触发 WebDAV 自动同步

设计：`docs/internal/implementation/2026-09-11-webdav-sync-followups.md` §5.1

## 现象

已绑定 WebDAV 且自动同步开启时，把**已经同步过**的资产移入新建文件夹后，远端长期不变。点「立即同步」则 MOVE 立刻成功。导入新文件会触发自动同步。

不要当作 GitHub #31 未修的 MOVE 规划。规划层已有 `move-remote`。

## 根因

`src/main/sync-auto-scheduler.ts` 只听 `onAssetsChanged`。远端轮询只比 manifest，看不见本地搬家。`moveAssets` → `applyManagedMoveOperation` 不发事件。`renameManagedFolder` 也不发。

## 应对

在用户命令边界发 `asset.changed`（`source: 'client'`）：`moveAssets`、`undoMoveAssets`、改写了下属资产路径的 `renameManagedFolder`。不要在 `applyManagedMoveOperation` 无条件广播，避免 `applySyncRelocate` 死循环。

## 验证

调度器单测 + 既有 sync-plan/runner。改 library-service 必须 `npm run test:library-availability`。验收 ID：`SYNC-AUTO-MOVE-001`（实现同一提交写入清单）。
