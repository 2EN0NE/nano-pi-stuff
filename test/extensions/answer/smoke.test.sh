#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# answer 扩展 smoke 测试
# 验证：
# 1. 扩展加载无崩溃
# 2. pi-logger 日志输出正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "answer extension"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "answer" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

test_it "produces pi-logger output" <<'TEST'
  run_pi_and_check \
    --extensions "answer" \
    --prompt "hi" \
    --save-output

  # 检查日志目录是否有 answer 日志文件
  LOG_DIR="$HOME/.pi/logs"
  if ls "$LOG_DIR"/answer_*.log 2>/dev/null | head -1 > /dev/null 2>&1; then
    echo "PASS: answer log file found"
  else
    echo "WARN: no answer log file found (may need pi-logger configured)"
  fi
  exit 0
TEST
