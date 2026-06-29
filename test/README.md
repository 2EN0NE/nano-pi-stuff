# End-to-End Test Infrastructure

本目录包含工程中所有扩展（extensions）和技能（skills）的端到端测试案例。

## 目录结构

```
test/
├── extensions/            # 扩展测试（对应 extensions/ 的模块）
│   ├── pi-logger/         # pi-logger 扩展的测试
│   ├── review/            # review 扩展的测试
│   └── ...
├── skills/                # 技能测试（对应 skills/ 的模块）
│   ├── e2e-test/          # e2e-test 技能的自测试
│   └── ...
├── scripts/
│   └── run-e2e.sh         # 主测试运行器
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
# 运行指定扩展的测试
bash test/scripts/run-e2e.sh --ext pi-logger

# 运行指定技能的测试
bash test/scripts/run-e2e.sh --skill e2e-test

# 运行所有模块的测试
bash test/scripts/run-e2e.sh
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
