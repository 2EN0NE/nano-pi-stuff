# @zenone/pi-cloud-sessions

将你的 pi 会话同步到云端后端，这样你可以在一台机器上开始对话，在另一台机器上继续。完整的会话内容——消息、树结构、标签和会话名称——都会通过镜像 pi 存储在 `~/.pi/agent/sessions/` 下的 JSONL 文件进行同步。

支持两个后端：

- **git** — 你拥有的私有 Git 仓库（带版本历史、免费、随处可用）。
- **icloud** — iCloud Drive 中的文件夹（零基础设施、同一 Apple ID 下的 Mac 可用）。

## 工作原理

pi 将会话存储为 `<agent-dir>/sessions/--<project-path>--/<timestamp>_<uuid>.jsonl` 格式的 JSONL 文件。此扩展将该目录树镜像到选定的后端：

- 启动时它会从后端 **拉取** 更新的会话到本地存储。
- 每 `pollIntervalMs`（默认 60 秒）它会 **后台拉取**，这样即使在 pi 打开时，另一台机器上创建的会话也会出现在 `/resume` 中。
- 在恢复/切换会话前它会 **拉取**，确保加载的是最新版本。
- 每轮交互后它会 **推送** 当前状态（带防抖）。
- 关闭时它会刷新最终同步。

冲突解决策略是按修改时间 **每文件最后写入者获胜**。文件 mtime 跨机器保持一致，因此无论哪台机器最后同步，最新的编辑都会胜出。会话是只追加/分支式的，因此对同一文件的并发编辑很少发生。

## 设置

在 pi 内运行设置命令：

```bash
/cloud-sessions-setup
```

它会询问后端并写入 `~/.config/pi/cloud-sessions.json`。

### Git 后端

创建一个**空的私有仓库**（例如 `git@github.com:you/pi-sessions.git`），并确保你的本地 `git` 可以推送（SSH 密钥或 `gh auth`）。然后：

```jsonc
// ~/.config/pi/cloud-sessions.json
{
	"provider": "git",
	"git": { "repo": "git@github.com:you/pi-sessions.git", "branch": "main" },
}
```

该仓库会被克隆到 `~/.config/pi/cloud-sessions/repo` 并保持同步。

### iCloud 后端

```jsonc
{
	"provider": "icloud",
	"icloud": {
		"dir": "~/Library/Mobile Documents/com~apple~CloudDocs/pi-sessions",
	},
}
```

## 在另一台机器上恢复

一切都是自动的——你无需运行同步命令：

1. 在机器 A 上使用 pi。每轮交互后会推送会话。
2. 在机器 B 上打开 pi（相同的项目路径）。启动时的拉取会带来 A 的会话；后台轮询即使 B 已经打开也会持续同步。
3. 执行 `/resume` — A 的会话会列出。选择它并继续。

**注意——会话必须共享相同的 `cwd`。** 会话按工作目录存储（`--<project-path>--`）。要让会话出现在机器 B 的 `/resume` 中，B 必须与 A 处于相同的绝对项目路径。如果不同机器上的用户名/主目录路径不同，则路径不会匹配。

**跨目录匹配（新）** 如果两台机器的绝对路径无法一致，可以通过 `projectMatch` 配置来自动匹配。配置文件独立存放在：

```
~/.pi/agent/extensions-data/cloud-sessions/project-match.json
```

该功能支持两种匹配策略（可同时启用）：

- **后缀匹配**（`suffixSegments`）：通过对比目录名的最后 N 个路径段来判断是否属于同一项目。例如路径分别为 `/Users/alice/Projects/my-app` 和 `/home/bob/Projects/my-app`，设置 `suffixSegments: 2` 时，最后两段 `Projects/my-app` 匹配，会话会自动合并。
- **Git Remote 匹配**（`gitRemote`）：通过项目的 git remote 地址自动识别同一项目。在云端仓库中自动维护 `.project-map.json` 映射表，将 git 远程 URL 与不同机器上的目录名关联。配置为 `true` 即可启用。

```jsonc
// ~/.pi/agent/extensions-data/cloud-sessions/project-match.json
{
	"suffixSegments": 2, // 最后 2 个路径段一致即视为同一项目
	"gitRemote": true, // 同时启用 git remote 匹配
}
```

**注意：** 后缀匹配因 Pi 的目录编码方式（`/` 替换为 `-`），如果路径中含连字符（如 `my-project`），可能导致超额匹配。建议配合 `gitRemote` 使用或仅设置较小的段数。

**注意——不支持实时双向编辑。** 同步是串行的：在一台机器上完成，在另一台机器上继续。已加载到内存中的会话在拉取到新版本时不会热重载。

## 命令

- `/cloud-sessions` — 打开统一 TUI 面板，在一个界面中完成所有操作：**手动同步**、**配置后端**（git/icloud）、**查看状态**、以及**调整高级设置**（autoPush、轮询间隔、项目路径匹配等）。（需 TUI 模式）

## 配置

所有选项都可以在 `~/.config/pi/cloud-sessions.json` 中设置，或通过环境变量设置：

| 设置项        | JSON 键          | 环境变量                          | 默认值                   |
| ------------- | ---------------- | --------------------------------- | ------------------------ |
| 后端          | `provider`       | `PI_CLOUD_SESSIONS_PROVIDER`      | `git`                    |
| 自动推送      | `autoPush`       | `PI_CLOUD_SESSIONS_AUTO_PUSH`     | `true`                   |
| 启动时拉取    | `pullOnStart`    | `PI_CLOUD_SESSIONS_PULL_ON_START` | `true`                   |
| 推送防抖      | `pushDebounceMs` | `PI_CLOUD_SESSIONS_DEBOUNCE_MS`   | `4000`                   |
| 轮询间隔      | `pollIntervalMs` | `PI_CLOUD_SESSIONS_POLL_MS`       | `60000`（0 表示禁用）    |
| 机器标签      | `machineId`      | `PI_CLOUD_SESSIONS_MACHINE_ID`    | 主机名                   |
| Git 仓库      | `git.repo`       | `PI_CLOUD_SESSIONS_GIT_REPO`      | —                        |
| Git 分支      | `git.branch`     | `PI_CLOUD_SESSIONS_GIT_BRANCH`    | `main`                   |
| iCloud 文件夹 | `icloud.dir`     | `PI_CLOUD_SESSIONS_ICLOUD_DIR`    | iCloud Drive/pi-sessions |

> 📁 `projectMatch` 配置独立存放在 `~/.pi/agent/extensions-data/cloud-sessions/project-match.json` 中，不在主配置文件中。

## 隐私

会话可能包含你输入的任何内容或 Agent 读取的任何文件内容。请使用**私有**仓库，并将后端视为敏感数据。没有加密层——JSONL 按原样存储。

## 安装

将构建后的扩展放置在受信任的 pi 扩展目录中，或直接加载：

```bash
pi -e ./packages/cloud-sessions/dist/index.js
```
