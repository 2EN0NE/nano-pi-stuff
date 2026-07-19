---
name: worktree
description: '使用 git worktree 实现隔离开发，避免不同特性在同一个工作目录下互相干扰。创建独立 worktree 后，Pi agent 自动将文件读写重定向到 worktree 目录。'
---

# pi-worktree 技能

## 概述

pi-worktree 插件让你在同一个仓库中创建多个独立的工作目录（git worktree），
每个 worktree 有自己的分支和文件系统，开发不同特性时互不干扰。

Worktree 名称自动从天文学黄道十二宫+恒星名池中分配（如 `Aries-Hamal`、`Taurus-Aldebaran`、`Leo-Regulus` 等）。

## 快速工作流

### 1. 创建 worktree 开始开发新特性

```bash
/worktree create
```

- 自动从 `origin/main` fork 出独立 worktree + 新分支 `wt/<名称>`
- 自动 symlink `.env*` 文件
- 自动运行 `npm install`（如果主仓库有 package.json）
- 激活 worktree 路径映射（agent 所有文件操作定向到 worktree）

### 2. 在 worktree 中开发

Agent 通过 `get_worktree_paths` 工具自动感知当前 worktree 路径，
创建/读取/编辑文件都会自动使用 worktree 下的对应目录。

提交和推送在 worktree 内执行：

```bash
git add .
git commit -m "feat: ..."
git push origin wt/Aries-Hamal
```

### 3. 切换 worktree（或切回主仓库）

```bash
/worktree stop              # 退出当前 worktree，切回主仓库
/worktree use Aries-Hamal         # 切换到已有 worktree "Orion"
```

### 4. 特性合并后清理

```bash
/worktree delete Aries-Hamal  # 删除 worktree 目录 + 本地/远程分支
/worktree clean             # 批量清理已合并到 main 的 worktree
```

## 全部命令

| 命令                                 | 说明                                |
| ------------------------------------ | ----------------------------------- |
| `/worktree create [--branch <name>]` | 创建并激活新的 worktree             |
| `/worktree use <name>`               | 切换到已有的 worktree               |
| `/worktree stop`                     | 停用当前 worktree，回到主仓库       |
| `/worktree list`                     | 列出所有 worktree                   |
| `/worktree delete <name>`            | 删除 worktree（含分支清理，有确认） |
| `/worktree mode [on\|off]`           | 开关 worktree 模式                  |
| `/worktree widget [on\|off]`         | 显示/隐藏 worktree 状态 widget      |
| `/worktree shell`                    | 在 worktree 目录打开新终端          |
| `/worktree clean [--dry-run]`        | 清理已合并到 base 分支的 worktree   |

## Agent 工具

插件注册了以下工具供 agent 在对话中自动调用：

| 工具名                  | 用途                                               |
| ----------------------- | -------------------------------------------------- |
| `get_worktree_paths`    | **编辑文件前务必调用**。获取当前 worktree 路径映射 |
| `create_worktree`       | 创建并激活 worktree（参数：`repos`, `branch?`）    |
| `stop_worktree`         | 停用当前 worktree                                  |
| `attach_worktree_repos` | 把更多仓库加入当前 worktree                        |
| `detach_worktree_repos` | 从当前 worktree 移除仓库                           |
| `delete_worktree`       | 永久删除 worktree（含分支清理）                    |
| `list_worktrees`        | 列出所有 worktree（含分支和激活状态）              |

## 重要规则（Agent 必须遵守）

1. **编辑文件前**必须先调 `get_worktree_paths`。如果有活跃 worktree，
   所有读/写/编辑操作都必须使用 worktree 路径，而非主仓库路径。

2. Worktree 模式开启但无活跃 worktree 时，先调 `create_worktree` 再编辑。

3. Worktree 模式关闭且无活跃 worktree 时，正常操作主仓库目录。

4. 如果活跃 worktree 中缺少需要编辑的仓库，调 `attach_worktree_repos` 加入，
   不要创建新 worktree。

## 设计要点

- **命名**：自动分配黄道十二宫恒星名（36 组合+编号后备），无需手动指定
- **分支策略**：worktree 分支默认为 `wt/<名称>`，基于 `origin/main` 创建
- **自动设置**：自动 symlink `.env*`，自动安装 npm 依赖，自动运行 setup 脚本
- **状态持久化**：worktree 状态跨 session 保持，`/reload` 后自动恢复
- **Orca 回退**：如果装了 Orca 平台则用 Orca 管理，否则用纯 git
- **删除确认**：TUI 模式下删除 worktree 有二次确认提示
- **远程分支清理**：删除 worktree 时可选清理远程分支（`--remote <name>`）
