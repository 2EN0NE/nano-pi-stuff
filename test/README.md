# End-to-End Test Infrastructure

本目录包含工程中所有扩展（extensions）和技能（skills）的端到端测试案例。

> **TUI 测试**（`*.tui.smoke.test.sh`）是 2026-07 新增的扩展测试类型，用于验证 Pi 在**交互式 TUI 模式**下的行为。
> 详见下方 [TUI 模式测试](#tui-模式测试) 一节。

## 目录结构

```
test/
├── extensions/            # 扩展测试（对应 extensions/ 的模块）
│   ├── pi-logger/         # pi-logger 扩展的测试
│   │   └── smoke.test.sh  # 普通模式测试（pi -a --no-session）
│   ├── quit/              # quit 扩展的测试
│   │   ├── smoke.test.sh  # 普通模式测试
│   │   └── tui.smoke.test.sh  # TUI 交互模式测试（新增）
│   └── ...
├── skills/                # 技能测试（对应 skills/ 的模块）
│   ├── e2e-test/          # e2e-test 技能的自测试
│   └── ...
├── helpers/               # 测试辅助工具
│   └── tui-functions.sh   # TUI 测试辅助函数库（新增）
├── scripts/
│   └── run-e2e.sh         # 主测试运行器（支持 TUI 模式）
├── results/               # 测试结果输出（gitignored）
│   └── <timestamp>/
│       ├── summary.md                 # 全局汇总
│       ├── summary.json               # 全局汇总 JSON
│       ├── extensions/<name>/         # 每个扩展的测试结果
│       │   ├── summary.md             # 模块级汇总
│       │   ├── summary.json           # 模块级汇总 JSON
│       │   └── cases/                 # 单条用例日志
│       └── skills/<name>/             # 每个技能的测试结果
│           ├── summary.md
│           ├── summary.json
│           └── cases/
├── smoke.test.sh          # 根级别：不指定模块时跑全部
└── README.md              # 本文件
```

## 使用方法

### 运行测试

```bash
# 运行指定扩展的普通测试（如存在 tui.smoke.test.sh 也会自动运行）
bash test/scripts/run-e2e.sh --ext pi-logger

# 仅运行 TUI 测试（不跑普通 smoke.test.sh）
bash test/scripts/run-e2e.sh --ext quit --tui

# 运行指定技能的测试
bash test/scripts/run-e2e.sh --skill e2e-test

# 运行所有模块的测试（含 TUI 测试）
bash test/scripts/run-e2e.sh

# 运行所有模块的 TUI 测试
bash test/scripts/run-e2e.sh --tui
```

### 查看结果

```bash
# 查看最新全局汇总
LATEST=$(ls -1t test/results/ | head -1)
cat test/results/$LATEST/summary.md

# 查看指定模块汇总
cat test/results/$LATEST/extensions/pi-logger/summary.md
cat test/results/$LATEST/skills/e2e-test/summary.md

# 查看单条用例日志
cat test/results/$LATEST/extensions/pi-logger/cases/*.log
```

### 编写测试案例

每个模块一个 `smoke.test.sh` 文件，格式如下：

```bash
# 导入测试框架提供的函数

test_describe "模块名称"

test_it "用例描述" <<'TEST'
  run_pi_and_check \
    --extensions "依赖列表,逗号分隔" \
    --prompt "模拟用户输入的 prompt" \
    --expect-no-error
TEST

test_it "需要 AI 衡量 的用例" <<'TEST'
  run_pi_and_check \
    --extensions "依赖列表" \
    --prompt "test prompt" \
    --save-output
  mark_for_review "请检查输出是否符合预期：XXX"
TEST
```

支持的基础设施函数（由 `run-e2e.sh` 提供）：

- `run_pi_and_check` — 执行 pi 并收集日志
- `mark_for_review` — 标记需要 AI 逐条评判
- 更多见 `test/scripts/run-e2e.sh` 中的函数文档

## 结果解读

每个测试运行会产生：

- **全局汇总** — `test/results/<timestamp>/summary.md`（含模块列表 + 聚合数字）
- **模块级汇总** — `test/results/<timestamp>/extensions/<name>/summary.md`（含该模块的用例明细）
- **模块级 JSON** — 同目录下的 `summary.json`（机器可读）
- **cases/\*.log** — 每条用例的 pi 输出 + 日志（在模块目录下的 `cases/` 中）

### REVIEW 状态

当测试案例无法用自动化判断（exit code / 日志匹配）时，标记为 `[REVIEW]`。
Agent 需要逐条查看 case log 并衡量是否符合预期。

如果 `[REVIEW]` 数量超过 20 条，说明场景过于复杂，不适宜由 AI 全量判断，
应提醒用户手动比对。

---

## TUI 模式测试

从 2026-07 开始，工程支持 **TUI 交互模式测试**，通过伪终端（PTY）启动 Pi 的交互式界面，模拟用户键盘输入并验证屏幕输出。

### 适用场景

| 场景 | 说明 | 示例 |
|------|------|------|
| 扩展在 TUI 模式下加载 | 验证扩展在 TUI 中无报错加载 | quit, btw, answer |
| 命令面板交互 | 通过 `/command` 在 TUI 中发命令 | `/quit` 退出 |
| 覆盖层渲染 | 验证 `ctx.ui.custom()` 生成的内容 | 选择器、输入框 |
| 键盘输入响应 | Tab 导航、方向键、快捷键 | `ctrl+.` 快捷键 |
| 日志输出验证 | 验证 pi-logger 在 TUI 模式下的工作 | |

### 测试文件命名

TUI 测试文件使用 `tui.smoke.test.sh` 后缀，与普通 `smoke.test.sh` 并列：

```
test/extensions/<name>/
├── smoke.test.sh          # 普通 print 模式测试
└── tui.smoke.test.sh      # TUI 交互模式测试（可选）
```

### TUI 测试 API

所有 TUI 测试函数定义在 `test/helpers/tui-functions.sh` 中，由 `run-e2e.sh` 自动加载。

#### 核心函数

| 函数 | 用途 |
|------|------|
| `tui_run_pi_test <exts> <input> <timeout>` | 在 PTY 中启动 TUI 模式 pi，发送输入并捕获输出 |
| `tui_assert_contains <text>` | 断言 TUI 输出（ANSI 已剥离）包含指定文本 |
| `tui_assert_matches <regex>` | 断言 TUI 输出匹配正则表达式 |
| `extract_visible_text <file>` | 从原始 ANSI 日志提取纯文本 |
| `tui_cleanup` | 清理本次 TUI 测试的临时文件 |

#### 参数说明

- **exts** — 逗号分隔的扩展依赖列表（`"pi-logger,quit"`），会被自动复制到沙箱
- **input** — 发送给 Pi 的键盘输入（多行用 `\n` 分割）
- **timeout** — 超时秒数（默认 15），TUI 测试通常需要较长时间等待 Pi 启动和渲染

#### 环境变量输出

调用 `tui_run_pi_test` 后设置以下变量供断言使用：

| 变量 | 类型 | 说明 |
|------|------|------|
| `TUI_OUTPUT_FILE` | path | script 命令捕获的原始 ANSI 输出文件 |
| `TUI_EXIT_CODE` | int | Pi 进程的退出码（124 = timeout） |
| `TUI_TEST_HOME` | path | 沙箱根目录（`tui_cleanup` 会删除） |

### 编写 TUI 测试

```bash
#!/usr/bin/env bash

test_describe "my-extension (TUI mode)"

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "pi-logger,my-ext" "/command" 15

  # 验证退出码
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  # 验证输出包含扩展名
  tui_assert_contains "my-ext" "Extension name in TUI output"

  tui_cleanup
TEST

test_it "TUI output contains expected text [REVIEW]" <<'TEST'
  tui_run_pi_test "my-ext" "/cmd" 15

  tui_assert_contains "expected content"

  tui_cleanup
  mark_for_review "请检查 TUI 渲染效果是否符合预期"
TEST
```

### 技术原理

TUI 测试使用 Linux `script` 命令创建伪终端（PTY），让 Pi 认为自己在真实终端中运行：

```
script -q -e -c "timeout 15 pi -a" output.log <<< "/command"
```

关键机制：

1. **`script` 创建 PTY** — Pi 检测到 PTY 后进入交互式 TUI 模式（而非 print 模式）
2. **heredoc 输入** — 通过 stdin 向 PTY 发送按键序列
3. **ANSI 日志捕获** — 所有终端输出（含 ANSI 转义序列）被写入文件
4. **文本提取** — `strip_ansi` 函数剥离 ANSI 码，保留纯文本用于断言

### 已知限制

1. **输入时序不可控** — heredoc 一次性发送所有输入，Pi 可能还没启动完就收到按键
2. **关闭阶段输出丢失** — `session_shutdown` 事件中的 `process.stdout.write()` 可能在 PTY 关闭后丢失
3. **ANSI 解析未自动化** — 当前只做基本的 ANSI 剥离，未定位特定渲染区域
4. **无 node-pty** — 用 `script` 而非 `node-pty`，无法精确控制单次按键间隔

### 后续优化方向

1. **node-pty 方案** — 用 Node.js `node-pty` 替代 `script`，支持精确的输入时序和按键模拟
2. **视口快照** — 实现按 TUI 渲染帧（`\x1b[2J` 等）分割输出为多个视口快照
3. **屏幕截图对比** — 用 `@xterm/headless` 精确解析 ANSI，支持像素级对比
4. **组件级测试** — 复用 pi-mono 的 `VirtualTerminal` 对 TUI 组件做隔离测试
