#!/bin/bash

# Start script for Bielik Matura - REQUIRES Lean Prover
# Starts all required servers with strict error handling
#
# MANDATORY Components:
#   1. MCP Proxy  (port 3001) — SymPy math backend
#   2. Lean Proxy (port 3002) — Formal proof verification (REQUIRED)
#   3. Vite Dev   (port 5173) — Web UI
#
# Optional:
#   - MLX Server (port 8011) — LLM inference (can use Claude instead)

set -e  # Exit on error

echo "🎓 Starting Bielik Matura"
echo "========================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_success() { echo -e "${GREEN}✓${NC} $1"; }
print_error()   { echo -e "${RED}✗${NC} $1"; }
print_warning() { echo -e "${YELLOW}⚠${NC} $1"; }
print_info()    { echo -e "${BLUE}ℹ${NC} $1"; }

# Check if command exists
command_exists() { command -v "$1" >/dev/null 2>&1; }

# Check if port is in use
port_in_use() {
    if command_exists lsof; then
        lsof -i ":$1" >/dev/null 2>&1
    elif command_exists netstat; then
        netstat -an | grep ":$1 " | grep LISTEN >/dev/null 2>&1
    elif command_exists ss; then
        ss -tln | grep ":$1 " >/dev/null 2>&1
    else
        return 1
    fi
}

# Kill process on port
kill_port() {
    local port=$1
    print_info "Killing process on port $port..."
    if command_exists lsof; then
        lsof -ti ":$port" | xargs kill -9 2>/dev/null || true
    elif command_exists fuser; then
        fuser -k "$port/tcp" 2>/dev/null || true
    fi
}

# Read MLX port from prompts.json
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

MLX_PORT=8011
if [ -f "prompts.json" ]; then
    # Extract port from base_url in prompts.json
    EXTRACTED_PORT=$(python3 -c "
import json
with open('prompts.json') as f:
    cfg = json.load(f)
url = cfg.get('model', {}).get('base_url', '')
if ':' in url:
    print(url.split(':')[-1])
" 2>/dev/null)
    if [ -n "$EXTRACTED_PORT" ]; then
        MLX_PORT=$EXTRACTED_PORT
    fi
fi

# Cleanup function
cleanup() {
    echo ""
    print_info "Shutting down servers..."

    # Kill all background jobs
    jobs -p | xargs kill 2>/dev/null || true

    # Kill specific ports (only our servers, NOT MLX)
    kill_port 3001 2>/dev/null || true
    kill_port 3002 2>/dev/null || true
    kill_port 3003 2>/dev/null || true
    kill_port 5173 2>/dev/null || true

    print_success "Servers stopped"
    exit 0
}

# Trap Ctrl+C and call cleanup
trap cleanup INT TERM

# ── Step 1: Check prerequisites ──────────────────────────────────────────
echo "📋 Checking prerequisites..."
echo ""

if ! command_exists node; then
    print_error "Node.js is not installed"
    echo ""
    echo "Please install Node.js 18+ and run ./setup.sh"
    exit 1
fi
print_success "Node.js $(node --version)"

if ! command_exists python3; then
    print_error "Python 3 is not installed"
    echo ""
    echo "Please install Python 3.8+ and run ./setup.sh"
    exit 1
fi
print_success "Python 3 found"

if [ ! -d "node_modules" ]; then
    print_error "Dependencies not installed"
    echo ""
    echo "Please run: ./setup.sh"
    exit 1
fi
print_success "Main dependencies installed"

echo ""

# ── Step 2: MANDATORY Lean Prover Check ──────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎯 MANDATORY: Lean Prover Verification"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if ! command_exists lean; then
    print_error "CRITICAL: Lean Prover is NOT installed!"
    echo ""
    echo "Lean Prover is MANDATORY for this application."
    echo "It provides formal mathematical verification."
    echo ""
    echo "Please run the setup script to install Lean:"
    echo "   ${GREEN}./setup.sh${NC}"
    echo ""
    echo "Or install manually:"
    echo "   macOS: ${GREEN}brew install elan-init && elan default leanprover/lean4:stable${NC}"
    echo "   Linux: ${GREEN}curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh${NC}"
    echo "          ${GREEN}elan default leanprover/lean4:stable${NC}"
    echo ""
    exit 1
fi

LEAN_VERSION=$(lean --version 2>&1 | head -n 1 || echo "unknown")
print_success "Lean Prover installed: $LEAN_VERSION"
echo ""

# ── Step 3: Build MCP SymPy server if needed ─────────────────────────────
echo "🔧 Checking MCP SymPy server..."

if [ ! -d "mcp-sympy-server/node_modules" ]; then
    print_error "MCP server dependencies not installed"
    echo ""
    echo "Please run: ./setup.sh"
    exit 1
fi

# Rebuild if source is newer than dist
MCP_SRC="mcp-sympy-server/src/index.ts"
MCP_DIST="mcp-sympy-server/dist/index.js"

if [ ! -f "$MCP_DIST" ] || [ "$MCP_SRC" -nt "$MCP_DIST" ]; then
    print_info "Building MCP SymPy server (source changed)..."
    (cd mcp-sympy-server && npx tsc)
    if [ $? -eq 0 ]; then
        print_success "MCP server built"
    else
        print_error "MCP server build failed"
        exit 1
    fi
else
    print_success "MCP server up to date"
fi

echo ""

# ── Step 4: Check MLX server (optional) ──────────────────────────────────
echo "🤖 Checking MLX/Bielik LLM server (port $MLX_PORT) [OPTIONAL]..."

MLX_READY=false
if port_in_use $MLX_PORT; then
    # Try to actually reach the API
    MLX_RESPONSE=$(curl -s --connect-timeout 3 "http://localhost:$MLX_PORT/v1/models" 2>/dev/null || echo "")
    if echo "$MLX_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null; then
        MLX_READY=true
        MLX_MODEL=$(echo "$MLX_RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['data'][0]['id'])" 2>/dev/null)
        print_success "MLX server running — model: $MLX_MODEL"
    else
        print_warning "Port $MLX_PORT is in use but MLX API not responding"
    fi
else
    print_info "MLX server not running (you can use Claude instead)"
fi

echo ""

# ── Step 5: Check for port conflicts ─────────────────────────────────────
echo "🔍 Checking for port conflicts..."

PORTS_TO_CHECK=(3001 3002 5173)
CONFLICTS=0

for port in "${PORTS_TO_CHECK[@]}"; do
    if port_in_use $port; then
        print_warning "Port $port is already in use"
        CONFLICTS=$((CONFLICTS + 1))
    fi
done

if [ $CONFLICTS -gt 0 ]; then
    echo ""
    echo "Kill conflicting processes and continue? (y/n)"
    read -p "> " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        for port in "${PORTS_TO_CHECK[@]}"; do
            if port_in_use $port; then
                kill_port $port
            fi
        done
        print_success "Ports cleared"
        sleep 1
    else
        print_error "Cannot start with port conflicts. Exiting."
        exit 1
    fi
fi

echo ""

# ── Step 6: Start servers ────────────────────────────────────────────────
echo "🚀 Starting servers..."
echo ""

# Create log directory
mkdir -p logs

# Start MCP Proxy (SymPy) - MANDATORY
print_info "Starting MCP Proxy (SymPy) on port 3001..."
npm run mcp-proxy > logs/mcp-proxy.log 2>&1 &
MCP_PID=$!
sleep 2

if kill -0 $MCP_PID 2>/dev/null && port_in_use 3001; then
    print_success "MCP Proxy started (PID: $MCP_PID)"
else
    print_error "CRITICAL: MCP Proxy failed to start"
    echo ""
    echo "Check logs/mcp-proxy.log for details:"
    cat logs/mcp-proxy.log 2>/dev/null | tail -20
    echo ""
    cleanup
    exit 1
fi

# Start Lean Proxy - MANDATORY
print_info "Starting Lean Proxy on port 3002..."
npm run lean-proxy > logs/lean-proxy.log 2>&1 &
LEAN_PID=$!
sleep 3

if kill -0 $LEAN_PID 2>/dev/null && port_in_use 3002; then
    print_success "Lean Proxy started (PID: $LEAN_PID)"
else
    print_error "CRITICAL: Lean Proxy failed to start"
    echo ""
    echo "Lean Prover backend is MANDATORY for this application."
    echo ""
    echo "Check logs/lean-proxy.log for details:"
    cat logs/lean-proxy.log 2>/dev/null | tail -20
    echo ""
    echo "Troubleshooting:"
    echo "  1. Verify Lean is installed: ${GREEN}lean --version${NC}"
    echo "  2. Check if lean-proxy-server.js exists"
    echo "  3. Try running manually: ${GREEN}npm run lean-proxy${NC}"
    echo ""
    cleanup
    exit 1
fi

# Start RAG Service (mathematical methods knowledge base) - OPTIONAL
print_info "Starting RAG Service on port 3003..."
if [ -f "$SCRIPT_DIR/rag_service/main.py" ]; then
    # Check if venv exists
    if [ -f "$SCRIPT_DIR/rag_service/venv/bin/activate" ]; then
        cd "$SCRIPT_DIR/rag_service"
        source venv/bin/activate
        python3 main.py > "$SCRIPT_DIR/logs/rag-service.log" 2>&1 &
        RAG_PID=$!
        deactivate
        cd "$SCRIPT_DIR"
        sleep 2

        if kill -0 $RAG_PID 2>/dev/null && port_in_use 3003; then
            print_success "RAG Service started (PID: $RAG_PID)"
        else
            print_warning "RAG Service failed to start (agent will work without knowledge base)"
            echo "  Check logs/rag-service.log for details"
        fi
    else
        print_warning "RAG Service venv not found. Run: cd rag_service && python3 -m venv venv && source venv/bin/activate && pip install -r requirements.txt"
    fi
else
    print_warning "RAG Service not found (rag_service/main.py missing)"
fi
echo ""

# Start Vite dev server - MANDATORY
print_info "Starting Vite dev server on port 5173..."
npm run dev > logs/vite.log 2>&1 &
VITE_PID=$!
sleep 3

if kill -0 $VITE_PID 2>/dev/null; then
    print_success "Vite dev server started (PID: $VITE_PID)"
else
    print_error "CRITICAL: Vite dev server failed to start"
    echo ""
    echo "Check logs/vite.log for details:"
    cat logs/vite.log 2>/dev/null | tail -20
    echo ""
    cleanup
    exit 1
fi

echo ""

# ── Summary ──────────────────────────────────────────────────────────────
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$MLX_READY" = true ]; then
    echo -e "  🤖 MLX Server (LLM):   ${GREEN}http://localhost:${MLX_PORT}${NC}  ✓ $MLX_MODEL"
else
    echo -e "  🤖 MLX Server (LLM):   ${YELLOW}Not running (use Claude instead)${NC}"
fi
echo -e "  🔌 MCP Proxy (SymPy):  ${GREEN}http://localhost:3001${NC}  ✓ RUNNING"
echo -e "  🎯 Lean Proxy:         ${GREEN}http://localhost:3002${NC}  ✓ RUNNING"
if port_in_use 3003; then
    echo -e "  📚 RAG Service:        ${GREEN}http://localhost:3003${NC}  ✓ RUNNING"
else
    echo -e "  📚 RAG Service:        ${YELLOW}Not running (optional)${NC}"
fi
echo -e "  🌐 Web Application:    ${GREEN}http://localhost:5173${NC}  ✓ RUNNING"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ "$MLX_READY" = false ]; then
    echo -e "  ${BLUE}ℹ  MLX server not detected (optional)${NC}"
    echo "     You can use Claude API instead, or start MLX:"
    echo -e "     ${GREEN}mlx_lm.server --model LibraxisAI/Bielik-11B-v3.0-mlx-q4 --port $MLX_PORT${NC}"
    echo ""
fi

echo "✅ All mandatory services are running!"
echo ""
echo "📝 Logs:  logs/mcp-proxy.log  |  logs/lean-proxy.log  |  logs/rag-service.log  |  logs/vite.log"
echo ""
echo -e "🌐 Open:  ${BLUE}http://localhost:5173${NC}"
echo ""
echo -e "🛑 Press ${RED}Ctrl+C${NC} to stop all servers"
echo ""

# Wait for all background processes
wait
