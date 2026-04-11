#!/usr/bin/env bash
# MVP Benchmark — 5 tasks to verify agent tool completeness.
# Tests both TS and Rust servers (configurable via BASE_URL).
#
# Usage: ./tests/benchmark/run_mvp.sh [base_url]
#   default: http://localhost:3001

set -euo pipefail

BASE_URL="${1:-http://localhost:3001}"
PASS=0
FAIL=0
RESULTS=()

send_chat() {
    local msg="$1"
    local session="${2:-bench-$(date +%s)}"
    curl -s -X POST "${BASE_URL}/v1/chat" \
        -H "Content-Type: application/json" \
        -d "{\"content\": \"${msg}\", \"session_id\": \"${session}\"}" \
        2>/dev/null
}

check() {
    local name="$1" condition="$2"
    if eval "$condition"; then
        echo "  ✓ ${name}"
        PASS=$((PASS+1))
        RESULTS+=("PASS: ${name}")
    else
        echo "  ✗ ${name}"
        FAIL=$((FAIL+1))
        RESULTS+=("FAIL: ${name}")
    fi
}

echo "═══════════════════════════════════════════════"
echo "  MVP Benchmark — luminclaw"
echo "  Target: ${BASE_URL}"
echo "═══════════════════════════════════════════════"

# Pre-check
echo ""
echo "→ Pre-check: /health"
HEALTH=$(curl -s "${BASE_URL}/health")
check "server is running" 'echo "$HEALTH" | grep -q "ok"'

echo "→ Pre-check: /v1/tools"
TOOLS=$(curl -s "${BASE_URL}/v1/tools")
TOOL_COUNT=$(echo "$TOOLS" | python3 -c "import sys,json; print(json.load(sys.stdin)['count'])" 2>/dev/null || echo "0")
check ">=10 tools registered (got ${TOOL_COUNT})" '[ "$TOOL_COUNT" -ge 10 ]'

echo ""
echo "─── T1: Create Python project ───"
rm -rf /tmp/bench/
SESSION="bench-t1-$(date +%s)"
RESP=$(send_chat "在 /tmp/bench/ 下创建一个 Python 项目，包含 main.py 和 test_main.py，main.py 实现 fibonacci 函数，test 要通过。创建完后用 bash 运行 python -m pytest /tmp/bench/test_main.py -v" "$SESSION")
echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('response','')[:200])" 2>/dev/null || true
check "main.py exists" '[ -f /tmp/bench/main.py ]'
check "test_main.py exists" '[ -f /tmp/bench/test_main.py ]'
check "pytest passes" 'python3 -m pytest /tmp/bench/test_main.py -v 2>/dev/null'

echo ""
echo "─── T2: Read + Edit file ───"
SESSION="bench-t2-$(date +%s)"
RESP=$(send_chat "读取 /tmp/bench/main.py，把 fibonacci 改成迭代实现，保留测试不变。改完之后用 bash 跑 python -m pytest /tmp/bench/test_main.py -v 确认测试通过" "$SESSION")
echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('response','')[:200])" 2>/dev/null || true
check "main.py was modified" 'grep -qE "for|while|iterative|loop" /tmp/bench/main.py 2>/dev/null'
check "pytest still passes" 'python3 -m pytest /tmp/bench/test_main.py -v 2>/dev/null'

echo ""
echo "─── T3: Grep for functions ───"
SESSION="bench-t3-$(date +%s)"
RESP=$(send_chat "在 /tmp/bench/ 中搜索所有包含 'def ' 的文件，列出函数名" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "found function names" 'echo "$RESP_TEXT" | grep -qi "fib\|test"'

echo ""
echo "─── T4: Fetch URL ───"
SESSION="bench-t4-$(date +%s)"
RESP=$(send_chat "获取 https://httpbin.org/json 的内容，提取 slideshow.title 的值" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "extracted slideshow title" 'echo "$RESP_TEXT" | grep -qi "sample\|slideshow"'

echo ""
echo "─── T5: Memory store + recall ───"
SESSION="bench-t5-$(date +%s)"
send_chat "记住我叫张三" "$SESSION" > /dev/null
RESP=$(send_chat "回忆我的名字" "$SESSION")
RESP_TEXT=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response',''))" 2>/dev/null || echo "")
check "recalled name" 'echo "$RESP_TEXT" | grep -q "张三"'

echo ""
echo "═══════════════════════════════════════════════"
echo "  Results: ${PASS} passed, ${FAIL} failed"
echo "═══════════════════════════════════════════════"
for r in "${RESULTS[@]}"; do echo "  $r"; done
exit $FAIL
