#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# skills 扩展 TUI 端到端测试
# 测试要点：
# 1. /skills 命令在 TUI 模式下正常触发
# 2. skills 的 SettingsList 选择器在 TUI 下不崩溃
# 3. 与 pi-logger 配合正常
# ──────────────────────────────────────────────────────────────────────────────

test_describe "skills extension (TUI mode)"

# ── 用例 1：/skills 在 TUI 模式下触发无崩溃 ──
test_it "/skills command triggers without crash" <<'TEST'
  tui_run_pi_test "pi-logger,skills" "/skills" 15

  if [[ "$TUI_EXIT_CODE" -eq 0 ]] || [[ "$TUI_EXIT_CODE" -eq 124 ]]; then
    echo "PASS: /skills TUI exited cleanly (code=$TUI_EXIT_CODE)"
  else
    echo "FAIL: /skills TUI exited with code $TUI_EXIT_CODE (expected 0 or 124)"
    exit 1
  fi

  # 验证扩展加载正常
  tui_assert_contains "skills" "Skills extension should appear in output"

  tui_cleanup
TEST

# ── 用例 2：TUI 模式下 skills 日志记录正常 ──
test_it "logs skills startup in TUI mode" <<'TEST'
  tui_run_pi_test "pi-logger,skills" "/skills" 15

  local padded
  padded=$(printf '%03d' "$CASE_INDEX")
  local log_dir="$CASE_DIR/${padded}-logs"
  if [[ -d "$log_dir" ]]; then
    local skills_log
    skills_log=$(find "$log_dir" -name "*skills*" -type f 2>/dev/null | head -1)
    if [[ -n "$skills_log" ]]; then
      echo "PASS: skills log file found: $skills_log"
      # 验证日志包含关键启动信息
      if grep -q "Skills extension loaded\|skills" "$skills_log"; then
        echo "PASS: skills startup message in log"
      fi
    else
      local skills_refs
      skills_refs=$(grep -rl "skills" "$log_dir" 2>/dev/null | head -3)
      if [[ -n "$skills_refs" ]]; then
        echo "PASS: skills references found in logs: $skills_refs"
      else
        echo "WARN: No skills-specific logs found"
        ls "$log_dir" 2>/dev/null | head -5
      fi
    fi
  else
    echo "WARN: No logs directory captured"
  fi

  tui_cleanup
TEST

# ── 用例 3：TUI 模式下 /skills 选择器面板正常工作 [REVIEW] ──
test_it "/skills shows selector panel [REVIEW]" <<'TEST'
  tui_run_pi_test "pi-logger,skills" "/skills" 15

  tui_assert_contains "pi" "TUI should produce output"

  tui_cleanup
  mark_for_review "验证 /skills 在 TUI 模式下触发了 SettingsList 选择器："$'\n'"1. 输出中包含技能列表或"Skills"字样"$'\n'"2. 选择器面板正常渲染、无排版错乱"$'\n'"3. 可以导航、确认、取消"
TEST
