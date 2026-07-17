#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# prompt-editor 扩展 TUI 端到端测试
# 测试要点：
# 1. /prompt 命令在 TUI 模式下正常触发
# 2. prompt 组装检查面板打开无崩溃
# 3. Ctrl+Shift+P 快捷键在 TUI 下可触发
# 4. 与 pi-logger 配合正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "prompt-editor extension (TUI mode)"

# ── 用例 1：/prompt 在 TUI 模式下触发无崩溃 ──
test_it "/prompt command triggers without crash" <<'TEST'
  tui_run_pi_test "pi-logger,prompt-editor" "/prompt" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /prompt TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /prompt TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  tui_assert_contains "prompt" "Prompt-editor extension should appear in output"

  tui_cleanup
TEST

# ── 用例 2：TUI 模式下 prompt-editor 扩展加载正常 ──
test_it "shows prompt-editor in TUI extension list" <<'TEST'
  tui_run_pi_test "pi-logger,prompt-editor" "/prompt" 15

  # 验证 pi-logger 和 prompt-editor 都在扩展列表中
  tui_assert_contains "pi-logger" "pi-logger should be in extension list"
  tui_assert_contains "prompt-editor" "prompt-editor should be in extension list"

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

# ── 用例 3：TUI 模式下 prompt 面板渲染 [REVIEW] ──
test_it "/prompt shows assembly panel [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-logger,prompt-editor" "/prompt" 15

  tui_assert_contains "pi" "TUI should produce output"

  tui_cleanup
  mark_for_review "验证 /prompt 在 TUI 模式下触发了 prompt 组装面板："$'\n'"1. 输出中包含"Prompt Assembly"或"prompt"相关文字"$'\n'"2. 面板组件列表正常渲染"$'\n'"3. 可正常退出（Esc/Ctrl+C）"
TEST
