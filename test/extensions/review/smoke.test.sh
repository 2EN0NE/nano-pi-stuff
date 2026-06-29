#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# review 扩展端到端测试
# ──────────────────────────────────────────────────────────────────────────────

test_describe "review extension"

# ── 用例 1：加载无报错 ──
test_it "loads without errors" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "hi" \
    --expect-no-error
TEST

# ── 用例 2：/review uncommitted 命令可用（需 AI 衡量） ──
test_it "/review uncommitted command is available [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "show /review uncommitted" \
    --save-output
  mark_for_review "验证 pi 的输出中是否包含 review 相关的提示或选项"
TEST

# ── 用例 3：review prompt 被发送（需 AI 衡量） ──
test_it "review prompt is built and sent [REVIEW]" <<'TEST'
  run_pi_and_check \
    --extensions "pi-logger,review" \
    --prompt "start a review of uncommitted changes" \
    --save-output
  mark_for_review "验证 review 扩展是否成功构建 review prompt 并触发 agent 回复"
TEST
