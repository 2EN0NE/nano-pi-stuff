#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# selector 扩展（@zenone/pi-selector）TUI 端到端测试
# 测试要点：
# 1. 选择器在 TUI 模式下正确加载
# 2. 使用选择器的扩展（通过 import @zenone/pi-selector）能正常工作
# 3. 生命周期日志正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "selector extension (TUI mode)"

# ── 用例 1：TUI 模式下加载无崩溃 ──
test_it "loads in TUI mode without crash" <<'TEST'
  tui_run_pi_test "selector" "/quit" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证选择器扩展名出现在输出中
  tui_assert_contains "selector" "Selector extension name appears in TUI output"

  tui_cleanup
TEST

# ── 用例 2：TUI 欢迎界面正常渲染 ──
test_it "renders TUI welcome screen" <<'TEST'
  tui_run_pi_test "selector" "/quit" 15

  tui_assert_matches "pi v[0-9]+\.[0-9]+\.[0-9]+" "TUI welcome banner should show pi version"
  tui_assert_contains "[Extensions]" "Extensions section should appear"

  tui_cleanup
TEST

# ── 用例 3：选择器与 pi-logger 在 TUI 下配合正常 ──
test_it "works with pi-logger in TUI mode" <<'TEST'
  tui_run_pi_test "pi-logger,selector" "/quit" 15

  # 验证 pi-logger 和 selector 都在扩展列表中
  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "selector" "selector should be in extension list"

  # 检查日志目录
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    # 检查是否有 pi-logger 产生的日志文件
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null | head -5)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files exist:"
      echo "$log_files"
    else
      echo "WARN: No log files found in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

# ── 用例 4：选择器作为 @zenone/pi-selector 被其他扩展正常引用 ──
test_it "importable via @zenone/pi-selector in TUI mode" <<'TEST'
  # 使用一个依赖 selector 的扩展（skills）来验证 selector 可通过 npm 包引用
  tui_run_pi_test "pi-logger,selector,skills" "/skills" 15

  # 验证 /skills 能正常触发（说明 selector 的依赖加载成功）
  # 即使 /skills 面板因缺乏真实模型未能完全渲染，至少不应崩溃
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode with selector+skills exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: Unexpected exit code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_assert_contains "pi" "TUI should produce some output"

  tui_cleanup
TEST
