#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# permission-gate TUI 测试
#
# TUI 模式下 permission-gate 扩展的行为验证。
# 注意：TUI overlay 内容（控制面板、策略面板等）通过 script 捕获的 PTY 输出
# 无法可靠提取（overlay 使用光标定位绘制），因此我们只验证可捕获的信号：
#   - 扩展加载（在 PTY 输出中存在扩展名）
#   - 日志文件（pi-logger 捕获）
#   - 灰度 REVIEW 需要手动验证 overlay 渲染效果
#
# 以下内容因使用 PTY overlay 渲染，无法通过 script 捕获验证：
#   - 欢迎界面（pi version, [Extensions], [Context]）
#   - 状态栏 widget 文本
#   - 帮助文本
# 这些内容需要手动 REVIEW 或在 Vitest TUI runner（PI_TUI_WRITE_LOG）中测试。
# ──────────────────────────────────────────────────────────────────────────────

test_describe "permission-gate (TUI mode)"

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证扩展名在 PTY 输出中出现（来自输入命令，非 overlay）
  tui_assert_contains "permission-gate" "Extension name in TUI output"
  tui_cleanup
TEST

test_it "TUI mode produces pi-logger output [REVIEW]" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    # 查找所有日志文件
    local log_files
    log_files=$(find "$log_dir" -name "*.log" -type f 2>/dev/null)
    if [[ -n "$log_files" ]]; then
      echo "PASS: Log files found:"
      echo "$log_files" | sed 's/^/  /'

      # 检查权限门控日志
      if echo "$log_files" | xargs grep -l "permission-gate\|Config loaded\|Permission Gate" 2>/dev/null | head -1 >/dev/null; then
        echo "PASS: permission-gate log content found"
      else
        echo "WARN: No permission-gate specific content in logs (may be in combined log)"
        echo "$log_files" | head -3 | xargs head -5 2>/dev/null || true
      fi
    else
      echo "WARN: No log files in $log_dir"
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
  mark_for_review "检查日志文件内容，确认 permission-gate 生命周期事件和 widget 更新被正确记录"
TEST

test_it "TUI mode captures status bar content [REVIEW]" <<'TEST'
  tui_run_pi_test "permission-gate" "/permission-gate" 15

  # 验证基本 PTY 输出存在
  echo "TUI exit code: $TUI_EXIT_CODE"
  echo "TUI output size: $(wc -c <"$TUI_OUTPUT_FILE") bytes"

  # 检查日志中是否有 widget 相关记录
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    if grep -r "gate:on\|gate:off\|permission-gate\|setStatus\|widget" "$log_dir" 2>/dev/null | head -5; then
      echo "PASS: widget/gate references found in logs"
    else
      echo "INFO: No widget references in logs (may use different log level)"
    fi
  fi

  tui_cleanup
  mark_for_review "审查 PTY 输出和日志文件，确认 permission-gate 状态栏 widget 正确显示"
TEST
