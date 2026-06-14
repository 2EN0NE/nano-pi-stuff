# Agent Notes

## 项目基本原则
### 1. 如涉及基础设施改造，完成后需询问是否同步AGENTS.md和README.md说明
正例：如设置logger为所有模块提供日志支撑，logger体系创建或用法修改后，要问用户是否检查AGENTS.md是否涉及这一块的说明，是否要把extensions创建要求更新；
反例：创建一个展示辅助模块（不影响其他模块），在未询问我的建议的情况下，就擅自把这个功能的说明加入了AGENTS.md或README.md


## 本地同步

这个仓库当前只面向本人本地使用，不做正式发布。

如需把资源同步到本地 Pi 代理目录，请执行：

```bash
./scripts/sync-to-local-pi.sh
```

默认会把资源同步到当前项目的 .pi/agents；如果要改成同步到用户目录 ~/.pi/agents，可使用：

```bash
./scripts/sync-to-local-pi.sh --target user
```

如果要同时同步到两个位置，则用：

```bash
./scripts/sync-to-local-pi.sh --target both
```

如果只想预览要同步的内容，可先运行：

```bash
./scripts/sync-to-local-pi.sh --dry-run
```

## 扩展开发

Pi 扩展放在 [extensions](extensions) 目录中；修改时请在这里更新。若需要参考内部实现，可查看 `pi-mono`，但不要改动其源码。

### 日志接入要求

所有新建或修改的扩展**必须接入 pi-logger 统一日志体系**，禁止使用裸 `console.log/error`。

接入方式：

```typescript
import { createLogger } from "./pi-logger/api.js";

const log = createLogger("your-extension-name");

// 使用：
log.info("信息");
log.debug("详情");
log.warn("警告");
log.error("错误");
```

日志输出由 pi-logger 的配置文件统一管控（`pi-logger.json`），扩展本身无需关心输出目的地和级别过滤。详细说明见./skills/pi-logger/SKILL.md
