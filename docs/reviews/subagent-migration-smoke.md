# 单个旧历史迁移：人工验收

按作者决定，不保留迁移测试文件，不扩展迁移测试矩阵。只转换一个非当前使用的真实旧会话。

## 样本与备份

- 根文件：`$PI_CODING_AGENT_DIR/sessions/--home-skwj111--/2026-10-22T10-55-58-143Z_01a16340-debf-73b6-a9f9-f4ef30eeca7d.jsonl`。
- 旧 Actor：`sub_01`，原角色 `researcher`，原模型 `antigravity/gemini-3.8-flash`。
- 根文件和关联子文件分别保留 `<file>.v1.bak`，未覆盖备份。
- 根备份 SHA-256：`57e80e14fffec35771362203a9fe2c8034409ddcb0a39cfb7c1644b2ed2c44d3`。
- 当前正在使用的会话未转换；其他旧会话也未转换。

## 实际结果

使用 `scripts/convert-subagent-storage-v2.mjs --agent-dir DIR --session FILE`，先 `--dry-run`，后 `--apply --offline`。这里只关闭并转换指定样本，不执行全量迁移。

- 删除 87 条 v1 快照，合成 1 个 Actor、1 个 Job 的 v2 状态。
- 转换时根文件从 1,061,416 字节降到 671,999 字节（随后人工续跑会追加新记录）。
- 146 条保留的原生记录，其非父链接内容与备份一致。
- 原子会话的 134,039 字节前缀完整保留。
- 真实 `SessionManager`、v2 Runtime 可恢复注册表及原 `cancelled` Job。
- 通过真实 SDK 扩展的 `subagent_list` 列出原 Actor，生成并读回原 Job 历史视图。
- 通过真实 `msg_write` 唤醒原 Actor，成功创建 `sub_01#r2`；保持原角色、模型、会话文件和续跑关系，没有重新创建 Actor。

## 续跑阻断及定位

前两次真实续跑（`#r2`、`#r3`）在 OAuth 刷新阶段失败：

```text
OAuth refresh failed for antigravity: fetch failed
```

第二次手工 SDK 调用启用了 Node 的环境代理，结果仍相同。随后确认插件 `src/auth/oauth.ts` 使用 npm `undici.fetch`，不是 Node 内置 fetch：无凭据访问同一 Google OAuth 地址，插件默认 fetch 超时；指定代理后收到 HTTP 404。单独使用 `--use-env-proxy` 没有为该 npm undici 实例配置代理。

仅在第三次临时验收进程中，对插件使用的 undici 调用 `setGlobalDispatcher(new EnvHttpProxyAgent())`，再通过原 `msg_write` 唤醒原 Actor。`sub_01#r4` 成功完成，原模型真实返回 `MIGRATION_V2_RESUMED_2026`；记录为 3 model calls、37 秒 active。未改迁移、模型选择、凭据配置或插件源码。正常 OAuth 刷新由 SDK 自行处理。

样本保留两轮真实失败和一轮成功的验收记录，原数据备份仍在。

手工调用仅关闭了根会话通知自动触发模型回复，避免历史 Main 因验收通知执行原工作。子 Agent 使用原来的真实模型与认证，没有模拟成功回答。

结论：**这个真实样本的加载、列表、历史读取和原模型真实续跑均通过基本验收。** 首次阻断由临时验收进程未正确配置插件 OAuth 的代理导致，不是迁移数据损坏。本结论仅限该样本，不扩展为全部历史或平台验收通过。

## 范围

脚本只依赖 Node 内置模块，生产目录不导入它，也不识别或转换 v1。迁移仅保留当前位置状态；Rewind 到合成事件之前不恢复 v1 注册表。脚本、备份及旧辅助脚本应保留到全部历史转换和验收完成后再处理。Windows 暂缓。
