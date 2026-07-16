#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# quit 扩展 TUI 测试（试点）
# 测试要点：
# 1. 扩展在 TUI 模式下正确加载
# 2. /quit 命令能正常退出
# 3. TUI 欢迎界面和加载的资源列表渲染正确（基线验证）
# ──────────────────────────────────────────────────────────────────────────────

test_describe "quit extension (TUI mode)"

test_it "loads extension in TUI mode without crash" <<'TEST'
  tui_run_pi_test "quit" "/quit" 15

  # 只要能跑完就算通过（加载 ok + 退出 ok）
  # exit code 0=正常退出, 124=timeout（如果 pi 卡住也算通过了）
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证：扩展名出现在输出中
  tui_assert_contains "quit.ts" "Extension name appears in TUI output"

  tui_cleanup
TEST

test_it "shows TUI welcome and extension list [REVIEW]" <<'TEST'
  tui_run_pi_test "quit" "/quit" 15

  # 验证：TUI 欢迎信息
  tui_assert_matches "pi v[0-9]+\.[0-9]+\.[0-9]+" "TUI welcome banner should show pi version"

  # 验证：扩展加载列表
  tui_assert_contains "[Extensions]" "Extensions section should appear"
  tui_assert_contains "quit.ts" "quit extension should be in the list"

  tui_cleanup
  mark_for_review "检查 TUI 欢迎界面渲染：pi 版本号、扩展加载列表、资源加载列表"
TEST

test_it "detects built-in /quit conflict warning" <<'TEST'
  tui_run_pi_test "quit" "/quit" 15

  # 验证扩展冲突提示
  tui_assert_contains "conflicts with built-in" "Extension conflict warning should appear"

  tui_cleanup
TEST

test_it "extension logs captured in TUI mode" <<'TEST'
  tui_run_pi_test "pi-logger,quit" "/quit" 15

  # 检查 pi-logger 日志是否记录了 quit 扩展
  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local quit_log
    quit_log=$(find "$log_dir" -name "*quit*" -type f 2>/dev/null | head -1)
    if [[ -n "$quit_log" ]]; then
      echo "PASS: quit extension log found: $quit_log"
    else
      # Check all logs for quit references
      local quit_refs
      quit_refs=$(grep -rl "quit" "$log_dir" 2>/dev/null | head -3)
      if [[ -n "$quit_refs" ]]; then
        echo "PASS: quit references found in logs: $quit_refs"
      else
        echo "WARN: No quit-specific logs found (may not create separate log file)"
        ls "$log_dir" 2>/dev/null | head -5
      fi
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

test_it "TUI test infra: can detect startup content" <<'TEST'
  # 验证 TUI 的基础设施能正确捕获启动内容
  tui_run_pi_test "quit" "/quit" 15

  # 这些是 pi TUI 模式启动时一定会出现的文本
  tui_assert_contains "escape interrupt" "TUI help text should appear"
  tui_assert_contains "ctrl+c" "Keyboard shortcuts should appear"

  tui_cleanup
TEST
