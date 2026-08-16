# dsh-action-outbox

把多次有外部副作用的 DeepSeek Harness 工具调用暂存为一个不可变批次，统一审阅后再提交或丢弃。

它实现的是工具的**输出提交边界**：暂存时只记录工具名和完整 JSON 参数，不执行目标工具；审阅会返回 SHA-256 摘要；提交只接受这份准确摘要，默认对整批动作请求一次人工批准，再按顺序让每个目标调用重新进入 DSH 原有工具流水线。

## 为什么需要它

Worktree 和文件 checkpoint 能恢复本地代码，却无法撤回已经发出的 Issue 评论、邮件、部署或付款。DeepSeek Harness 所依据的 Cordis 论文把这个系统边界讲得很明确：外部输出要么延迟到提交点，要么使用领域专属的补偿动作。本插件实现前者——**提交前不发出任何外部动作**——同时不把多个外部系统伪装成原子事务。

## 安装

安装 GitHub 上带版本标签的发布：

```sh
dsh plugin --profile web add github:JimchengChina/dsh-action-outbox#v0.2.0
```

或者从本地 checkout 安装：

```sh
dsh plugin --profile web add ./dsh-action-outbox
```

它是带 `cordis.patch.yml` 的 DSH bundle，安装后会自动加入 profile。
工具同时提供 DSH 原生调用/结果展示元数据，因此支持该接口的 Web、TUI 和编辑器客户端可以显示简洁的审阅与提交卡片，而无需硬编码插件工具名。

## Agent 使用流程

1. `action_outbox_begin({ label })`
2. 一次或多次 `action_outbox_stage({ tool, arguments, summary? })`
3. 如有错误，可调用 `action_outbox_unstage({ action_id })` 删除单个动作
4. `action_outbox_review()`
5. 核对动作，并复制完整 `digest`
6. `action_outbox_commit({ expected_digest: digest })`，或调用 `action_outbox_discard()`

提交前丢弃可以保证目标动作一个都没执行。暂存内容有任何变化，摘要都会变化，旧审阅结果不能被提交。

## 配置

默认允许暂存任意当前可见的非内部工具、提交时要求审批，但不会强迫普通工具走暂存流程。

```yaml
- id: action-outbox
  name: dsh-action-outbox
  config:
    include: ['github_*', 'slack_*', 'deploy_*']
    exclude: ['github_get_*', 'github_list_*']
    enforce: ['github_create_*', 'github_update_*', 'slack_send', 'deploy_*']
    requireApproval: true
    rejectDuplicateActions: true
    maxPendingMs: 1800000
    maxActions: 20
    maxArgumentBytes: 65536
    resultPreviewChars: 2000
    approvalPreviewChars: 4000
```

- `include`：允许暂存的工具通配模式。
- `exclude`：暂存与强制策略共同使用的例外。
- `enforce`：匹配的工具禁止直接调用，必须走暂存与提交；为兼容现有部署，默认空数组。
- `requireApproval`：对准确审阅过的批次只审批一次；没有审批服务时会安全拒绝。
- `rejectDuplicateActions`：拒绝工具名和参数完全相同的重复动作，避免意外重复写入；确实需要重复时才关闭。
- `maxPendingMs`：超过指定毫秒数后使未提交批次过期，避免旧意图获得新审批；默认 30 分钟，设为 `0` 可关闭。
- `maxActions` / `maxArgumentBytes`：限制内存中的待提交状态。
- `resultPreviewChars` / `approvalPreviewChars`：限制回执和审批说明长度。

只有 `*` 是通配符，其他正则符号都按普通字符匹配。

## 安全语义

- 暂存阶段绝不调用目标工具。
- 提交必须携带最新完整 SHA-256 摘要，避免“审阅后被换包”。
- 暂存时校验目标参数；如果目标工具在审阅后被移除、热更新或更换身份，整批提交会在第一个副作用之前被拒绝。
- 真正提交时，每个动作仍会经过 DSH 的权限、沙箱、hooks、guards、取消和结果观察链。
- 提交授权只覆盖准确暂存的那次目标调用，不会传递给目标工具内部发起的其他调用；后代调用仍须独立通过强制策略。
- 严格串行执行，首个失败立即停止，后续动作不会运行。
- 每个已派发动作都会记录确定性的嵌套 call id、开始/结束时间、耗时，以及可用的 DSH 结构化错误标识，便于关联审计。
- 不自动重试。外部超时可能是“执行成功但回执丢失”，自动重试会造成重复写入。
- 不承诺虚假的跨系统回滚。前面已经成功的动作不会因为后续失败而消失。
- 待提交队列只在内存中；插件卸载、重启或崩溃会丢弃意图，但不会意外发出动作。
- 打开的批次默认 30 分钟后过期；过期会清除审阅状态，但绝不会执行目标动作。

## 局限

- 它不是跨工具、跨服务的分布式原子事务。
- 目标工具报告成功后，插件不能通用地撤销该动作。
- 目标工具自己的审批策略在提交期间仍可能再次询问；整批审批不会削弱工具所有者的原有策略。
- 暂存参数会进入工具调用和会话历史；不要通过参数传递原工具本就不应暴露的秘密。
- 强制策略只约束 DSH 工具注册表中的调用，不能隔离恶意的同进程插件。
- 后续规划依赖返回值的读取类工具，应正常调用，不应暂存。

功能对比、重复项目扫描和论文依据见[研究说明](docs/research.md)。
部署假设和滥用场景见[安全策略与威胁模型](SECURITY.md)，更严格的起步配置见 [`examples/enforced-external-actions.yml`](examples/enforced-external-actions.yml)。

## 开发

```sh
pnpm install
pnpm verify
```

MIT
