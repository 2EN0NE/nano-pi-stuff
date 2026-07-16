# @zenone/pi-ci-watch

监控 GitHub PR **或分支**的 CI 状态并自动修复失败。缩短 CI 与编码 Agent 之间的反馈循环。

## 安装

```bash
pi install npm:@zenone/pi-ci-watch
```

或者在 `.pi/settings.json` 中：

```json
{
	"packages": ["npm:@zenone/pi-ci-watch"]
}
```

## 命令

| 命令                            | 描述                                      |
| ------------------------------- | ----------------------------------------- |
| `/ci-watch <pr编号\|分支名>`    | 监控 CI 并自动修复失败（最多 3 次尝试）   |
| `/ci-notify <pr编号\|分支名>`   | 监控 CI 并在完成时通知（不自动修复）      |
| `/ci-auto on\|off`              | 每次推送后自动监控（默认：gh 可用时开启） |
| `/ci-config <min> <max> <step>` | 配置轮询间隔（秒）                        |
| `/ci-config`                    | 显示当前配置                              |

## 工作原理

**PR 模式：** 使用智能间隔（30 秒 → 45 秒 → 60 秒 → 30 秒……）轮询 `gh pr checks`。
**分支模式：** 使用 `gh run list --branch` 直接查询分支的最新 CI run。

两种模式下：

1. 如果 CI 通过：通知 ✅
2. 如果 CI 失败：通过 `gh run view --log-failed` 获取日志，返回给 LLM 修复
3. LLM 读取错误、修复代码、提交、推送
4. 重复直到 CI 通过（最多 3 次尝试）

**检测规则：** 纯数字输入（如 `12`）自动走 PR 模式；包含字母/斜线的输入（如 `main`、`feature/foo`）自动走分支模式。

## 自动模式

启动时自动检测 `gh` CLI。如果已安装，自动模式默认开启；如果未安装，自动模式关闭并提示安装。

开启后，扩展会检测 `git push` 输出并自动开始监控：

- 有 PR → PR 模式
- 无 PR（如直接推 main）→ 分支模式

使用 `/ci-auto off` 可随时关闭，`/ci-auto on` 重新开启。

## 轮询配置

默认：30 秒最小值、60 秒最大值、15 秒步长。间隔从最小值增长到最大值，然后重置——不会无限增长。

```
/ci-config 20 90 10
```

设置：20 秒 → 30 秒 → 40 秒 → …… → 90 秒 → 20 秒 → ……

## 要求

- 已安装并认证 `gh` CLI
- 启用了 GitHub Actions CI 的仓库
