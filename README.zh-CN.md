<p align="center">
  <img src="assets/action-outbox-hero.jpg" alt="Action Outbox — 先审查，只提交一次" width="100%">
</p>

# dsh-action-outbox

面向 DeepSeek Harness 外部副作用的持久化 **Batch Review Inbox**：先暂存准确调用，查看或编辑完整 canonical JSON，再一次性批准不可变批次。

暂存不会调用目标工具。Review 会重新解析当前策略、工具身份、schema 与参数，返回 SHA-256 digest 和一次性 approval nonce；Commit 只接受这一对凭据，并按顺序让每个动作重新进入 DSH 原有工具流水线。

如果你希望 DSH Agent 保持高效，同时让外部写入更审慎、更透明，欢迎 Star——这会帮助更多 DSH 用户发现这个插件。

## 为什么需要它

Worktree 和文件 checkpoint 能恢复本地代码，却无法撤回已经发出的 Issue 评论、邮件、部署或付款。DeepSeek Harness 所依据的 Cordis 论文把这个系统边界讲得很明确：外部输出要么延迟到提交点，要么使用领域专属补偿。本插件实现前者——**提交前不发出任何外部动作**——同时不把多个外部系统伪装成原子事务。

## v0.3 新增能力

- DSH Web 侧栏内的 Batch Review Inbox：显示完整参数、参数字节数、工具来源、工具指纹、action hash，并支持复制和下载。
- `action_outbox_replace`：可修改已暂存动作的工具、参数或摘要；编辑会立即作废旧 digest、nonce、review 与 approval。
- 超长审查安全门禁：被截断的审批卡片不能单独授权提交，必须先在 Inbox 中查看并确认完整内容。
- `0600` 权限的持久化待提交状态：重启后只恢复为 `needs_reapproval`，清除旧审批状态，并重新检查当前策略、工具与 schema。
- 提交崩溃恢复：提交中断后进入 `recovery_required`；没有确定成功回执的动作标记为 `ambiguous`，绝不自动重试。
- Inbox 内置 **Copy safe demo prompt** 安全体验入口；过期批次进入历史区，不再占用待办角标，同时保留检查和清理入口。

## 安装

安装带版本标签的 GitHub 发布：

```sh
dsh plugin --profile web add github:JimchengChina/dsh-action-outbox#v0.3.0
```

或从本地 checkout 安装：

```sh
dsh plugin --profile web add ./dsh-action-outbox
```

它是带 `cordis.patch.yml` 的 DSH bundle。浏览器端只使用 DSH 官方 `sidebar.footer.action` 和 `shell.overlay` 槽位。

第一次体验时，打开左下角 **Outbox**，点击 **Copy safe demo prompt**，把生成的文字粘贴到全新 DSH 会话。它只会暂存一个 `/private/tmp` 下的 no-clobber 文件写入，Review 后立即停止，不访问网络。过期批次默认不计入待办数量；点击 **Show expired history** 仍可查看或丢弃。

## Agent 使用流程

1. `action_outbox_begin({ label })`
2. 一次或多次 `action_outbox_stage({ tool, arguments, summary? })`
3. 可调用 `action_outbox_unstage({ action_id })` 删除，或调用 `action_outbox_replace({ action_id, tool?, arguments?, summary? })` 修改
4. `action_outbox_review()`
5. 在 Batch Review Inbox 核对完整批次；若审批预览被截断，须在这里确认完整内容
6. 在 Inbox 编辑后点击 **Run fresh review**；批次变为 reviewed 后，该按钮会被 **Next: copy exact commit prompt** 取代。点击复制并粘贴到对话；仅在 Inbox 发生的 Review 不会自动进入聊天历史
7. `action_outbox_commit({ expected_digest: digest, approval_nonce })`，或调用 `action_outbox_discard()`

不要在 Inbox Review 后只告诉 Agent“使用最近一次 Review”。模型眼中的最近一次 Review 可能仍是聊天历史里旧的 `action_outbox_review` 工具结果。正确做法是粘贴 Inbox 生成的精确提交指令，或要求 Agent 在对话里调用 `action_outbox_review`，并立即提交该工具刚返回的 digest 和 nonce。

Commit 开始之前，Discard 能保证暂存的目标动作一个都没执行。任何批次修改都会生成新的授权状态，即使调用方仍保留旧 digest 或 nonce 也无法提交。

## 重启协议

```text
open -> reviewed -> restart -> needs_reapproval
                              -> 重新解析当前策略/工具/schema
                              -> 新 digest + 新一次性 nonce
                              -> approve -> committing

committing -> crash -> recovery_required
                       -> 未确认结果的调用标记为 ambiguous
                       -> 永不自动恢复或重试
```

持久化记录绑定 DSH agent/session owner，并在 DSH 提供时记录 workspace。重启不会自动提交，不会复用审批 nonce，也不会把磁盘里保存的旧工具对象当成当前授权。

## 配置

```yaml
- id: action-outbox
  name: dsh-action-outbox
  config:
    include: ['github_*', 'slack_*', 'deploy_*']
    exclude: ['github_get_*', 'github_list_*']
    enforce: ['github_create_*', 'github_update_*', 'slack_send', 'deploy_*']
    requireApproval: true
    rejectDuplicateActions: true
    persistPending: true
    stateFile: ''
    maxPendingMs: 1800000
    maxActions: 20
    maxArgumentBytes: 65536
    resultPreviewChars: 2000
    approvalPreviewChars: 4000
```

- `include`：允许暂存的工具通配模式。
- `exclude`：暂存与强制策略共同使用的例外。
- `enforce`：匹配工具禁止直接调用，必须走 Outbox；为兼容现有部署，默认空数组。
- `requireApproval`：对最终 digest/nonce 请求一次整批审批；没有审批服务时安全拒绝。
- `rejectDuplicateActions`：拒绝工具名和参数完全相同的重复动作；Replace 也会检查。
- `persistPending`：持久化有界草稿和恢复回执；默认开启。
- `stateFile`：可选路径；空值使用 `$DSH_HOME/action-outbox/state.json`，未设置 `DSH_HOME` 时使用 `~/.dsh/action-outbox/state.json`。
- `maxPendingMs`：未提交批次的有效期；默认 30 分钟，设为 `0` 关闭过期。
- `maxActions` / `maxArgumentBytes`：限制持久化状态大小。
- `resultPreviewChars`：限制模型侧结果回执长度。
- `approvalPreviewChars`：紧凑审批卡片上限。超出时必须在 Inbox 确认完整内容；没有 Inbox 的 headless/TUI 部署需要把此值提高到足以完整显示批次，否则系统会按设计拒绝提交。

只有 `*` 是通配符，其余正则字符都按普通字符匹配。

## 安全语义

- **暂存与编辑零派发。** 只修改有界本地状态，不调用目标工具。
- **完整审查可见性。** Inbox 保留完整 canonical JSON；紧凑卡片会明确标记截断，且不能成为唯一审批依据。
- **TOCTOU 防护。** 在相应边界校验 digest、一次性 nonce、实时工具对象身份、结构化工具指纹、schema 和策略。
- **修改即撤销授权。** Stage、Unstage、Replace 都清除旧 review、确认状态与 nonce。
- **重启重新授权。** 待提交草稿只恢复为 `needs_reapproval`，通过实时 preflight 后获得新 nonce。
- **派发前持久化。** 第一个外部调用之前先落盘 `committing`；每个成功动作完成后再持久化回执。
- **不削弱 DSH 控制。** 提交动作仍经过权限、沙箱、hooks、guards、取消和结果观察。
- **浅层授权。** `enforce` 例外只覆盖准确暂存的直接调用，不会传递给后代调用。
- **严格串行、首错停止。** 不自动重试失败或恢复后状态不确定的动作。
- **不承诺虚假回滚。** 前序成功动作不会因为后续失败而消失，也不会臆造通用补偿。

## 局限

- 它不是跨工具、跨服务的分布式原子事务。
- 无法通用撤销已成功动作，也无法仅凭超时判断外部写入是否发生。
- 目标工具自己的审批策略仍然有效，因此 Commit 期间可能再次询问。
- 参数会出现在 DSH 工具/会话历史中；开启持久化后也会写入本地 `0600` 文件。不要暂存原工具本就不应暴露的秘密。
- 工具指纹覆盖声明的名称、描述、schema 与 timeout，用于发现结构漂移；它不是对插件实现代码或来源的密码学签名。
- Inbox 继承 DSH Web 的访问边界，不额外提供独立多用户认证。
- Enforcement 只覆盖 DSH 工具注册表调用，不是针对恶意同进程代码的沙箱。
- 后续规划依赖返回值的读取工具应正常调用，不应暂存。

功能对比、重复项目扫描和论文依据见[研究说明](docs/research.md)；共享主机部署前请阅读[安全策略与威胁模型](SECURITY.md)。

## 开发

```sh
pnpm install
pnpm verify
```

`pnpm build` 会在 `lib/client.js` 生成 DSH 模块加载器产物；根目录的 `client.js` 是浏览器端源码输入，不会被直接提供给 Web 页面。

MIT
