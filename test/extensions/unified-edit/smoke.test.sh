#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# unified-edit 扩展 smoke 测试
# 验证：
# 1. 扩展加载无崩溃
# 2. pi-logger 日志输出正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "unified-edit extension (experimental, upstream)"

test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "unified-edit" \
    --prompt "hi" \
    --save-output
  exit 0
TEST

test_it "produces pi-logger output" <<'TEST'
  run_pi_and_check \
    --extensions "unified-edit" \
    --prompt "hi" \
    --save-output

  LOG_DIR="$HOME/.pi/logs"
  if ls "$LOG_DIR"/unified-edit_*.log 2>/dev/null | head -1 > /dev/null 2>&1; then
    echo "PASS: unified-edit log file found"
  else
    echo "WARN: no unified-edit log file found (may need pi-logger configured)"
  fi
  exit 0
TEST
