#!/bin/bash

# Start script for Bielik-M with Acorn Prover
# Starts all required servers with proper error handling

set -e  # Exit on error

echo "🚀 Starting Bielik-M"
echo "==================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Function to print colored output
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# Check if command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Check if port is in use
port_in_use() {
    if command_exists lsof; then
        lsof -i ":$1" >/dev/null 2>&1
    elif command_exists netstat; then
        netstat -an | grep ":$1 " | grep LISTEN >/dev/null 2>&1
    else
        # Fallback - assume port is free
        return 1
    fi
}

# Kill process on port
kill_port() {
    local port=$1
    print_info "Killing process on port $port..."
    if command_exists lsof; then
        lsof -ti ":$port" | xargs kill -9 2>/dev/null || true
    fi
}

# Cleanup function
cleanup() {
    echo ""
    print_info "Shutting down servers..."

    # Kill all background jobs
    jobs -p | xargs kill 2>/dev/null || true

    # Kill specific ports
    kill_port 3001 2>/dev/null || true
    kill_port 3002 2>/dev/null || true
    kill_port 5173 2>/dev/null || true

    print_success "Servers stopped"
    exit 0
}

# Trap Ctrl+C and call cleanup
trap cleanup INT TERM

# Step 1: Check prerequisites
echo "📋 Checking prerequisites..."
echo ""

if [ ! -d "node_modules" ]; then
    print_error "Dependencies not installed. Please run: ./setup.sh"
    exit 1
fi
print_success "Main dependencies found"

if [ ! -d "mcp-sympy-server/dist" ]; then
    print_error "MCP server not built. Please run: ./setup.sh"
    exit 1
fi
print_success "MCP server built"

if ! command_exists node; then
    print_error "Node.js is not installed"
    exit 1
fi
print_success "Node.js found"

echo ""

# Step 2: Check for port conflicts
echo "🔍 Checking for port conflicts..."
echo ""

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
    echo "Would you like to kill these processes and continue? (y/n)"
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

# Step 3: Check Lean installation
LEAN_AVAILABLE=false
if command_exists lean; then
    LEAN_AVAILABLE=true
    print_success "Lean Prover is available"
else
    print_warning "Lean Prover is not installed"
    print_info "Install with: brew install elan-init && elan default leanprover/lean4:stable"
    print_info "Continuing without Lean (SymPy only mode)"
fi

echo ""

# Step 4: Start servers
echo "🚀 Starting servers..."
echo ""

# Create log directory
mkdir -p logs

# Start MCP Proxy (SymPy)
print_info "Starting MCP Proxy (SymPy) on port 3001..."
npm run mcp-proxy > logs/mcp-proxy.log 2>&1 &
MCP_PID=$!
sleep 2

# Check if MCP proxy started successfully
if kill -0 $MCP_PID 2>/dev/null; then
    if port_in_use 3001; then
        print_success "MCP Proxy started (PID: $MCP_PID)"
    else
        print_error "MCP Proxy failed to bind to port 3001"
        cat logs/mcp-proxy.log
        kill $MCP_PID 2>/dev/null || true
        exit 1
    fi
else
    print_error "MCP Proxy failed to start"
    cat logs/mcp-proxy.log
    exit 1
fi

# Start Lean Proxy (if Lean is available)
if [ "$LEAN_AVAILABLE" = true ]; then
    print_info "Starting Lean Proxy on port 3002..."
    npm run lean-proxy > logs/lean-proxy.log 2>&1 &
    LEAN_PID=$!
    sleep 2

    # Check if Lean proxy started successfully
    if kill -0 $LEAN_PID 2>/dev/null; then
        if port_in_use 3002; then
            print_success "Lean Proxy started (PID: $LEAN_PID)"
        else
            print_warning "Lean Proxy failed to bind to port 3002 (non-critical)"
        fi
    else
        print_warning "Lean Proxy failed to start (non-critical)"
    fi
fi

# Start Vite dev server
print_info "Starting Vite dev server on port 5173..."
npm run dev > logs/vite.log 2>&1 &
VITE_PID=$!
sleep 3

# Check if Vite started successfully
if kill -0 $VITE_PID 2>/dev/null; then
    print_success "Vite dev server started (PID: $VITE_PID)"
else
    print_error "Vite dev server failed to start"
    cat logs/vite.log
    cleanup
    exit 1
fi

echo ""
echo "✅ All servers started successfully!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  🌐 Web Application:    ${GREEN}http://localhost:5173${NC}"
echo ""
echo "  🔌 MCP Proxy (SymPy):  http://localhost:3001"
if [ "$LEAN_AVAILABLE" = true ]; then
    echo "  🎯 Lean Proxy:         http://localhost:3002"
fi
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📝 Logs are saved in: ${BLUE}./logs/${NC}"
echo ""
echo "   - MCP Proxy:  logs/mcp-proxy.log"
if [ "$LEAN_AVAILABLE" = true ]; then
    echo "   - Lean Proxy: logs/lean-proxy.log"
fi
echo "   - Vite:       logs/vite.log"
echo ""
echo "🛑 Press ${RED}Ctrl+C${NC} to stop all servers"
echo ""

# Wait for all background processes
wait
