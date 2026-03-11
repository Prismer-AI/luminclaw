#!/bin/bash
# ============================================================
# Prismer Workspace — Lumin Entrypoint
# ============================================================
#
# Services:
#   1. Lumin Agent Gateway  (:3001, agent HTTP + WebSocket)
#   2. Container Gateway    (:3000, service proxy for LaTeX/Jupyter/etc.)
#
# ============================================================

set -e

# ── Colors ──
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Configuration ──
CONTAINER_GATEWAY_PORT="${CONTAINER_GATEWAY_PORT:-3000}"
LUMIN_PORT="${LUMIN_PORT:-3001}"
WORKSPACE="/workspace"

# ── Detect LAN IP ──
get_lan_ip() {
  local ip=""
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -z "$ip" ] && ip=$(ip -4 addr show scope global 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -1)
  [ -z "$ip" ] && ip="localhost"
  echo "$ip"
}

LAN_IP=$(get_lan_ip)

# ── Banner ──
echo ""
echo -e "${BOLD}╔════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     ${CYAN}Prismer Workspace + Lumin${NC}${BOLD}                      ║${NC}"
echo -e "${BOLD}╠════════════════════════════════════════════════════╣${NC}"
echo -e "${BOLD}║${NC}                                                    ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${GREEN}Services:${NC}  http://${LAN_IP}:${CONTAINER_GATEWAY_PORT}              ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${GREEN}Agent:${NC}     http://${LAN_IP}:${LUMIN_PORT}              ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}  ${GREEN}WebSocket:${NC} ws://${LAN_IP}:${LUMIN_PORT}/v1/stream     ${BOLD}║${NC}"
echo -e "${BOLD}║${NC}                                                    ${BOLD}║${NC}"
echo -e "${BOLD}╚════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Initialize workspace ──
init_workspace() {
  echo -e "${CYAN}[init]${NC} Initializing workspace..."

  mkdir -p "${WORKSPACE}"/{notes,uploads,data,.prismer}

  # Git defaults
  if ! git config --global user.email &>/dev/null; then
    git config --global user.email "user@prismer.local"
    git config --global user.name "Prismer User"
    git config --global init.defaultBranch main
  fi

  # Bootstrap workspace templates
  # OPENCLAW_WORKSPACE tells bootstrap to write to /workspace (not ~/.openclaw/workspace)
  # AGENT_TEMPLATE selects which template set (lite, researcher, etc.)
  if [ -f /opt/prismer/scripts/bootstrap-workspace.sh ]; then
    OPENCLAW_WORKSPACE="${WORKSPACE}" \
    AGENT_TEMPLATE="${AGENT_TEMPLATE:-lite}" \
      bash /opt/prismer/scripts/bootstrap-workspace.sh
  fi

  echo -e "${GREEN}[init]${NC} Workspace ready."
}

init_workspace

# ── Write agent.env (LLM config for Lumin) ──
write_agent_env() {
  local env_file="${WORKSPACE}/.prismer/agent.env"
  cat > "$env_file" << EOF
OPENAI_API_BASE_URL=${OPENAI_API_BASE_URL:-http://34.60.178.0:3000/v1}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
AGENT_DEFAULT_MODEL=${AGENT_DEFAULT_MODEL:-us-kimi-k2.5}
WORKSPACE_DIR=${WORKSPACE}
PRISMER_PLUGIN_PATH=/opt/prismer/plugins/prismer-workspace/dist/src/tools.js
AGENT_TEMPLATE=${AGENT_TEMPLATE:-lite}
EOF
  echo -e "${GREEN}[init]${NC} Agent config written to ${env_file}"
}

write_agent_env

# ── Start services ──
PIDS=()

# Container Gateway (service proxy for LaTeX, Jupyter, etc.)
echo -e "${CYAN}[start]${NC} Container Gateway on :${CONTAINER_GATEWAY_PORT}..."
GATEWAY_PORT="${CONTAINER_GATEWAY_PORT}" \
  node /app/gateway/container-gateway.mjs &
PIDS+=($!)

# Lumin Agent Gateway (HTTP + WebSocket)
echo -e "${CYAN}[start]${NC} Lumin Agent Gateway on :${LUMIN_PORT}..."

# Source agent env before starting Lumin
[ -f "${WORKSPACE}/.prismer/agent.env" ] && . "${WORKSPACE}/.prismer/agent.env"

LUMIN_PORT="${LUMIN_PORT}" \
  node /opt/prismer/lumin/dist/cli.js serve --port "${LUMIN_PORT}" &
LUMIN_PID=$!
PIDS+=($LUMIN_PID)

# ── Ready ──
sleep 1
echo ""
echo -e "${GREEN}[ready]${NC} All services started."
echo -e "${GREEN}[ready]${NC} Health: ${BOLD}http://${LAN_IP}:${CONTAINER_GATEWAY_PORT}/api/v1/health${NC}"
echo -e "${GREEN}[ready]${NC} Agent:  ${BOLD}http://${LAN_IP}:${LUMIN_PORT}/health${NC}"
echo ""

# ── Graceful shutdown ──
cleanup() {
  echo ""
  echo -e "${YELLOW}[shutdown]${NC} Stopping services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
  echo -e "${GREEN}[done]${NC} Bye!"
  exit 0
}

trap cleanup SIGTERM SIGINT

# Keep alive — wait on Lumin (critical service)
wait "$LUMIN_PID" 2>/dev/null
echo -e "${RED}[error]${NC} Lumin exited unexpectedly. Shutting down."
cleanup
