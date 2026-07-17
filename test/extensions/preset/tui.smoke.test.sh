#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# preset 扩展 TUI 端到端测试
# 测试要点：
# 1. /preset 命令在 TUI 模式下正常触发
# 2. preset 选择面板打开无崩溃
# 3. 与 pi-logger 配合正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "preset extension (TUI mode)"

# ── 用例 1：/preset 在 TUI 模式下触发无崩溃 ──
test_it "/preset command triggers without crash" <<'TEST'
  tui_run_pi_test "pi-logger,preset" "/preset" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /preset TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /preset TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "preset" "Preset extension should appear in output"

  tui_cleanup
TEST

# ── 用例 2：TUI 模式下 preset 扩展加载正常 ──
test_it "shows preset in TUI extension list" <<'TEST'
  tui_run_pi_test "pi-logger,preset" "/preset" 15

  # 验证 pi-logger 和 preset 都在扩展列表中
  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "preset" "preset should be in extension list"

  # 检查日志目录
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
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

# ── 用例 3：TUI 模式下 preset 选择面板渲染 [REVIEW] ──
test_it "/preset shows selection panel [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-logger,preset" "/preset" 15

  tui_assert_contains "pi" "TUI should produce output"

  tui_cleanup
  mark_for_review "验证 /preset 在 TUI 模式下触发了预设选择面板："$'\n'"1. 输出中包含"preset"或"Preset"相关文字"$'\n'"2. 面板正常渲染、无排版错乱"$'\n'"3. 可正常退出面板"
TEST
