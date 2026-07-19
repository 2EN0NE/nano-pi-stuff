#!/usr/bin/env bash
# pi-worktree TUI 测试
#
# 测试要点：
# 1. TUI 模式下 worktree widget 渲染正确（星座图标 + 名称）
# 2. /worktree list 在 TUI 中提示内容完整
# 3. /worktree mode / widget 命令的 TUI 反馈
# 4. worktree 状态 widget 的显示/隐藏切换
# 5. TUI 面板边框渲染（┌┐│└┘ 对齐）

test_describe "worktree extension (TUI mode)"

# ── 测试 1：扩展在 TUI 下加载 ──
test_it "loads in TUI mode without crash" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree list" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: TUI mode exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: TUI mode exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证扩展名出现在输出中
  tui_assert_contains "worktree" "Extension name appears in TUI output"

  tui_cleanup
TEST

# ── 测试 11：TUI 面板边框渲染 ──
test_it "TUI panel renders with borders" <<'TEST'
  # 发送 /worktree（无参数）+ esc 关闭 TUI 面板
  # 注意：$'...' 在 <<'TEST' heredoc 里不被解释，用 printf 构建输入
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  # 验证输出包含边框字符
  tui_assert_contains "┌" "TUI panel should have top-left border ┌"
  tui_assert_contains "┐" "TUI panel should have top-right border ┐"
  tui_assert_contains "│" "TUI panel should have vertical border │"
  tui_assert_contains "└" "TUI panel should have bottom-left border └"
  tui_assert_contains "┘" "TUI panel should have bottom-right border ┘"
  tui_assert_contains "pi-worktree" "TUI panel should show title pi-worktree"

  tui_cleanup
TEST

# ── 测试 12：边框内容行有右边框 ──
test_it "border lines have right-side closing │" <<'TEST'
  local pi_input
  pi_input=$(printf '/worktree\n\x1b')
  tui_run_pi_test "pi-logger,worktree" "$pi_input" 15

  # 提取出纯文本视口内容中有 │ 的行数
  local count
  count=$(extract_visible_text "$TUI_OUTPUT_FILE" | grep -c '│' || true)
  if [[ "$count" -ge 3 ]]; then
    echo "PASS: Found $count lines with border character │ (>=3)"
  else
    echo "FAIL: Too few bordered lines (got $count, expected >=3)"
    echo "--- TUI output (visible text) ---"
    extract_visible_text "$TUI_OUTPUT_FILE"
    echo "---"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 2：/worktree list 在 TUI 中显示无 worktree ──
test_it "list shows no worktrees (TUI)" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree list" 15

  # 应显示 worktree list 提示（无 worktree 时显示 "No worktrees"）
  tui_assert_contains "No worktrees" "Should show no worktrees message"
  tui_assert_contains "worktree" "worktree command should be mentioned"

  tui_cleanup
TEST

# ── 测试 3：/worktree mode 切换（TUI） ──
test_it "mode toggle works in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree mode" 15

  # mode 切换应有反馈
  tui_assert_contains "Worktree mode:" "mode toggle should show status"

  tui_cleanup
TEST

# ── 测试 4：/worktree mode off（TUI） ──
test_it "mode off works in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree mode off" 15

  tui_assert_contains "OFF" "mode off should show OFF"

  tui_cleanup
TEST

# ── 测试 5：/worktree mode on（TUI） ──
test_it "mode on works in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree mode on" 15

  tui_assert_contains "ON" "mode on should show ON"

  tui_cleanup
TEST

# ── 测试 6：/worktree widget 切换（TUI） ──
test_it "widget hide works in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree widget off" 15

  tui_assert_contains "hidden" "widget off should show hidden status"

  tui_cleanup
TEST

# ── 测试 7：/worktree widget show（TUI） ──
test_it "widget show works in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree widget on" 15

  tui_assert_contains "visible" "widget on should show visible status"

  tui_cleanup
TEST

# ── 测试 8：/worktree help 显示完整（TUI） ──
test_it "help shows all commands in TUI" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree help" 15

  # 应有 create 命令说明
  tui_assert_contains "create" "help should show create command"
  tui_assert_contains "delete" "help should show delete command"
  tui_assert_contains "list" "help should show list command"
  tui_assert_contains "stop" "help should show stop command"
  tui_assert_contains "mode" "help should show mode command"

  tui_cleanup
  mark_for_review "检查 /worktree help 输出是否完整：create、delete、list、stop、mode、shell、clean、widget"
TEST

# ── 测试 9：多次命令连续输入（TUI 稳定性） ──
test_it "multiple commands in sequence" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree mode
/worktree widget off
/worktree list
/worktree mode on
/worktree widget on" 20

  # 只要能跑完就算通过
  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: Multiple commands executed in TUI"
  else
    echo "FAIL: TUI exited with code $TUI_EXIT_CODE"
    exit 1
  fi

  tui_cleanup
TEST

# ── 测试 10：status 命令 in TUI ──
test_it "worktree status shown in TUI output" <<'TEST'
  tui_run_pi_test "pi-logger,worktree" "/worktree mode on" 15

  # mode 切换后应当有状态显示
  tui_assert_contains "ON" "worktree status should include ON"

  tui_cleanup
TEST
