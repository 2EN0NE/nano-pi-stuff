# @zenone/pi-smart-context

适用于 Pi 的智能模型路由与检索增强提示压缩。

## 工作原理（完整讲解）

### 一句话

**在每次 agent 启动前，用廉价模型（deepseek-v4-flash）看一遍历史对话，判断当前任务难度，然后动态切换到合适的模型。**

### 三步流程

```
用户输入（例如 "好的，继续"、"改个 typo"、"重构支付模块"）
       │
       ▼
┌─────────────────────────────────────────────┐
│ Step 1: 大上下文保护                          │
│ 检查上下文 token 是否超过阈值（默认 500K）     │
│ 超过 → 直接走 largeContext 模型（默认 pro）    │
│ 未超过 → 进入 Step 2                         │
└─────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│ Step 2: 分类器（deepseek-v4-flash）           │
│ 把最近 6000 字符历史 + 最新用户消息发给 flash   │
│ flash 判断任务复杂度：trivial/simple/medium/   │
│                      complex                 │
│                                              │
│ 关键：分类器看到的是完整上下文，不是单条消息     │
│ 所以你说 "好的" 时，它会看前一条助手消息         │
│ 来判定你同意的是什么                           │
└─────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────┐
│ Step 3: 路由到目标模型                        │
│ 根据分类结果选择对应配置的模型                  │
│ balanced 默认配置：                            │
│   trivial → flash                             │
│   simple  → pro                               │
│   medium  → pro                               │
│   complex → pro                               │
│ 调用 pi.setModel() 切换模型                    │
└─────────────────────────────────────────────┘
```

### 「好的 → PRO」具体原理

分类器 Prompt 的关键规则：

```
如果用户说了"好的"、"可以"、"继续"、"搞"、"干"、"来"、"行"、
"做吧"、"开工"、"走起"等认同性回复，查看他们在同意什么——
前一条助手消息定义了任务。
```

分类器拿到的不是只有当前消息，而是 **最近 6000 字符的完整对话历史**（`buildRecentContext()`）+ 最新消息。

```
分类器输入示例：
──────────────────────────────────
[user]: 我需要重构整个支付模块，把 PaymentService 拆分...
[assistant]: 好的，方案如下：1. 新建 PaymentProcessor...
[user]: 好的，继续
──────────────────────────────────
```

flash 看到的是：

1. 刚才在讨论复杂架构重构
2. 用户说"好的，继续"（同意按方案执行）
3. **任务 = 前一条 assistant 定义的架构重构** → **complex**
4. 路由到 `routing.complex` → `deepseek-v4-pro`

### 中文触发词表

当前分类器会识别以下认同性回复为"看上下文定义任务"：

| 触发词 | 效果 |
|---|---|
| 好的、可以、行、来 | 查看前一条消息决定复杂度 |
| 继续、搞、干、做吧、开工、走起 | 同上 |

## Profile 配置

### 内置 Profile

| Profile | 分类器 | trivial | simple | medium | complex | largeCtx |
|---|---|---|---|---|---|---|
| **balanced** 🌟（默认） | flash | flash | **pro** | **pro** | **pro** | **pro** |
| **fast** ⚡ | flash | flash | flash | flash | flash | flash |
| **quality** 🎯 | flash | pro | pro | pro | pro | pro |

### 推荐用法

deepseek-v4-flash 和 pro 的能力差距没有 claude haiku/opus 那么大。flash 对大部分编码任务已经够用。因此:

```json
{
  "activeProfile": "balanced"
}
```

- **日常开发** → balanced（大部分任务走 pro，最稳）
- **简单迭代** → fast（全部 flash，响应更快，省去分类器调用）
- **关键任务** → quality（全部 pro，图个安心）

切换命令：`/smart-context-profile fast`

> 💡 **对 deepseek 用户的价值评估**
>
> | 价值 | 功能 | 理由 |
> |---|---|---|
> | ⭐⭐⭐ | **大上下文保护** | 500K+tokens 时自动用 pro，避免 flash 在超长上下文下质量下降 |
> | ⭐⭐ | **trivial 轮次不切换** | 减少无意义的模型切换 |
> | ⭐ | **分类路由** | deepseek flash/pro 差距较小，路由收益有限 |

### 自定义 Profile

```json
{
  "activeProfile": "my-profile",
  "profiles": {
    "my-profile": {
      "classifier": { "provider": "deepseek", "model": "deepseek-v4-flash" },
      "routing": {
        "trivial": { "provider": "deepseek", "model": "deepseek-v4-flash" },
        "simple": { "provider": "litellm", "model": "gpt-4o" },
        "medium": { "provider": "deepseek", "model": "deepseek-v4-pro" },
        "complex": { "provider": "deepseek", "model": "deepseek-v4-pro" }
      },
      "largeContext": {
        "thresholdTokens": 600000,
        "model": { "provider": "deepseek", "model": "deepseek-v4-pro" }
      }
    }
  }
}
```

> **覆盖机制**：自定义 profile 会基于同名内建 profile 进行覆盖。例如 `profiles.balanced` 会覆盖内建 balanced 的对应字段，未指定字段继承自内建。

### Legacy 模式（向后兼容旧版 flat 配置）

```json
{
  "classifier": { "provider": "deepseek", "model": "deepseek-v4-flash" },
  "routing": {
    "trivial": { "provider": "deepseek", "model": "deepseek-v4-flash" }
  },
  "largeContext": {
    "thresholdTokens": 600000,
    "model": { "provider": "deepseek", "model": "deepseek-v4-pro" }
  }
}
```

## 使用

```bash
# 查看当前状态（profile、压缩统计）
/smart-context

# 列出可用 Profile 并查看当前
/smart-context-profile

# 切换到 fast profile
/smart-context-profile fast

# 切换回 balanced
/smart-context-profile balanced

# 启用/禁用路由
/smart-context-toggle
```

## 压缩流水线

除了路由，smart-context 还提供压缩能力，减少上下文体积：

| 阶段 | 技术 | 安全性 |
|---|---|---|
| **工具输出（结构化）** | 日志折叠、n-gram 去重、JSON 表格化、跨轮差量 | 无损 / 近无损 |
| **BM25 相关性** | 对旧消息与当前查询进行评分 | — |
| **摘要** | 用 flash 对旧消息做摘要，按哈希缓存 | 有损但可恢复 |
| **检索丢弃** | 低相关性内容替换为存根 + `recover_context("id")` | 可恢复 |

压缩内容可通过 `recover_context("id")` 工具恢复完整原文。

## 架构

```
src/
├── index.ts                      # 钩子 + recover_context 工具 + profile 命令 + pi-logger 埋点
├── config.ts                     # .pi/smart-context.json 加载器（profile + legacy 双模式）
├── router.ts                     # 基于分类器的复杂度路由 + pi-logger 埋点
├── host-ai.ts                    # 发现宿主的 complete() 函数
└── compression/
    ├── pipeline.ts               # 编排各阶段
    ├── store.ts                  # recover_context 的内容存储
    ├── haiku-summarize.ts        # 带哈希缓存的摘要器 + pi-logger 埋点
    ├── types.ts
    └── stages/
        ├── bm25.ts               # BM25 相关性评分
        ├── dedup.ts              # N-gram 行去重
        ├── log-fold.ts           # 日志错误提取 + 折叠
        ├── json-compact.ts       # JSON 数组表格化
        └── delta.ts              # 跨轮差量压缩
```
