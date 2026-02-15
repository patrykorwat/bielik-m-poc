#!/bin/bash

# Setup script for Bielik-M with Lean Prover
# Automates installation of all dependencies

set -e  # Exit on error

echo "🚀 Bielik-M Setup Script"
echo "========================"
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

# Step 1: Check prerequisites
echo "📋 Checking prerequisites..."
echo ""

if ! command_exists node; then
    print_error "Node.js is not installed. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi
print_success "Node.js $(node --version) found"

if ! command_exists npm; then
    print_error "npm is not installed. Please install npm first."
    exit 1
fi
print_success "npm $(npm --version) found"

if ! command_exists python3; then
    print_error "Python 3 is not installed. Please install Python 3.8+ first."
    echo "   Visit: https://www.python.org/"
    exit 1
fi
print_success "Python $(python3 --version) found"

echo ""

# Step 2: Install main application dependencies
echo "📦 Installing main application dependencies..."
npm install
if [ $? -eq 0 ]; then
    print_success "Main dependencies installed"
else
    print_error "Failed to install main dependencies"
    exit 1
fi
echo ""

# Step 3: Setup MCP SymPy Server
echo "🔧 Setting up MCP SymPy Server..."
cd mcp-sympy-server

# Install Node dependencies for MCP server
echo "   Installing MCP server Node dependencies..."
npm install
if [ $? -eq 0 ]; then
    print_success "MCP server Node dependencies installed"
else
    print_error "Failed to install MCP server Node dependencies"
    exit 1
fi

# Create Python virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    echo "   Creating Python virtual environment..."
    python3 -m venv venv
    if [ $? -eq 0 ]; then
        print_success "Python virtual environment created"
    else
        print_error "Failed to create Python virtual environment"
        exit 1
    fi
else
    print_info "Python virtual environment already exists"
fi

# Activate virtual environment and install Python dependencies
echo "   Installing Python dependencies (SymPy)..."
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    # Windows
    source venv/Scripts/activate
else
    # Unix-like (Linux, macOS)
    source venv/bin/activate
fi

pip install --upgrade pip > /dev/null 2>&1
pip install sympy
if [ $? -eq 0 ]; then
    print_success "SymPy installed"
else
    print_error "Failed to install SymPy"
    exit 1
fi

# Build MCP server
echo "   Building MCP server..."
npm run build
if [ $? -eq 0 ]; then
    print_success "MCP server built successfully"
else
    print_error "Failed to build MCP server"
    exit 1
fi

deactivate
cd ..
echo ""

# Step 4: Check/Install Lean Prover (optional)
echo "🎯 Checking Lean Prover installation..."
if command_exists lean; then
    LEAN_VERSION=$(lean --version 2>&1 | head -n 1 || echo "unknown")
    print_success "Lean Prover is already installed: $LEAN_VERSION"
else
    print_warning "Lean Prover is not installed"
    echo ""
    echo "   Lean Prover enables formal mathematical theorem proving."
    echo "   It's used in academic research for rigorous proof verification."
    echo ""
    echo "   Would you like to install it now? (y/n)"
    read -p "   > " -n 1 -r
    echo ""

    if [[ $REPLY =~ ^[Yy]$ ]]; then
        echo "   Installing Lean Prover via elan..."

        # Check if elan is installed
        if ! command_exists elan; then
            echo "   Installing elan (Lean version manager)..."

            # Detect OS
            if [[ "$OSTYPE" == "darwin"* ]]; then
                # macOS - try Homebrew first
                if command_exists brew; then
                    brew install elan-init
                    if [ $? -eq 0 ]; then
                        print_success "elan installed via Homebrew"
                    else
                        print_error "Failed to install elan via Homebrew"
                        print_info "You can install manually with:"
                        echo "      curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
                    fi
                else
                    # Use curl method
                    curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y
                    if [ $? -eq 0 ]; then
                        print_success "elan installed"
                        # Add elan to PATH for this session
                        export PATH="$HOME/.elan/bin:$PATH"
                    else
                        print_error "Failed to install elan"
                    fi
                fi
            else
                # Linux
                curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y
                if [ $? -eq 0 ]; then
                    print_success "elan installed"
                    # Add elan to PATH for this session
                    export PATH="$HOME/.elan/bin:$PATH"
                else
                    print_error "Failed to install elan"
                fi
            fi
        fi

        # Install Lean 4 stable
        if command_exists elan; then
            echo "   Setting up Lean 4 stable..."
            elan default leanprover/lean4:stable
            if [ $? -eq 0 ]; then
                print_success "Lean Prover installed successfully"
                lean --version
            else
                print_error "Failed to set Lean 4 as default"
                print_info "You can try manually: elan default leanprover/lean4:stable"
            fi
        else
            print_error "elan not found. Please install manually:"
            echo "      macOS: brew install elan-init"
            echo "      Linux: curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
        fi
    else
        print_info "Skipping Lean installation. You can install it later with:"
        echo "      macOS: brew install elan-init && elan default leanprover/lean4:stable"
        echo "      Linux: curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
        echo "             elan default leanprover/lean4:stable"
    fi
fi
echo ""

# Step 5: Summary
echo "✅ Setup complete!"
echo ""
echo "📚 Next steps:"
echo ""
echo "   1. Start all servers:"
echo "      ${GREEN}./start.sh${NC}"
echo ""
echo "   Or start them manually:"
echo "      Terminal 1: ${GREEN}npm run mcp-proxy${NC}     # SymPy backend (port 3001)"
echo "      Terminal 2: ${GREEN}npm run lean-proxy${NC}    # Lean backend (port 3002)"
echo "      Terminal 3: ${GREEN}npm run dev${NC}           # Web app (port 5173)"
echo ""
echo "   2. Open browser at: ${BLUE}http://localhost:5173${NC}"
echo ""
echo "   3. Configure your LLM provider:"
echo "      - For Claude: Enter your Anthropic API key"
echo "      - For MLX: Start MLX server and enter URL"
echo ""
echo "   4. Choose proving backend:"
echo "      - ${GREEN}Both (SymPy + Lean)${NC} - Recommended"
echo "      - SymPy only - For calculations"
echo "      - Lean only - For formal proofs"
echo ""

if ! command_exists lean; then
    print_warning "Note: Lean Prover is not installed. Formal proof verification will be limited."
    echo "      Install with:"
    echo "         macOS: ${GREEN}brew install elan-init && elan default leanprover/lean4:stable${NC}"
    echo "         Linux: ${GREEN}curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh${NC}"
    echo ""
fi

echo "🎉 Happy proving!"
