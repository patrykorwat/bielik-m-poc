#!/bin/bash

# Setup script for Bielik Matura - requires Lean Prover for formal verification
# Automates installation of all dependencies including MANDATORY Lean Prover

set -e  # Exit on error

echo "🎓 Bielik Matura - Setup Script"
echo "==============================="
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

# Step 4: Setup RAG Service (Knowledge Base)
echo "📚 Setting up RAG Service (Mathematical Knowledge Base)..."
cd rag_service

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
echo "   Installing RAG dependencies (FastAPI, scikit-learn)..."
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    # Windows
    source venv/Scripts/activate
else
    # Unix-like (Linux, macOS)
    source venv/bin/activate
fi

pip install --upgrade pip > /dev/null 2>&1
pip install -r requirements.txt
if [ $? -eq 0 ]; then
    print_success "RAG dependencies installed"
else
    print_error "Failed to install RAG dependencies"
    exit 1
fi

deactivate
cd ..
echo ""

# Step 5: MANDATORY Lean Prover Installation
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🎯 MANDATORY: Lean Prover Installation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
print_info "Lean Prover is REQUIRED for formal mathematical verification."
print_info "It ensures correctness of mathematical proofs and reasoning."
echo ""

if command_exists lean; then
    LEAN_VERSION=$(lean --version 2>&1 | head -n 1 || echo "unknown")
    print_success "Lean Prover is already installed: $LEAN_VERSION"
    echo ""
else
    print_error "Lean Prover is NOT installed"
    echo ""
    echo "   Lean Prover is MANDATORY for this application."
    echo "   It provides formal theorem proving and verification."
    echo ""
    echo "   Installing Lean Prover now..."
    echo ""

    # Check if elan is installed
    if ! command_exists elan; then
        print_info "Installing elan (Lean version manager)..."
        echo ""

        # Detect OS
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS - try Homebrew first
            if command_exists brew; then
                echo "   Using Homebrew to install elan..."
                brew install elan-init
                if [ $? -eq 0 ]; then
                    print_success "elan installed via Homebrew"
                else
                    print_error "Failed to install elan via Homebrew"
                    echo ""
                    print_info "Trying alternative installation method..."
                    curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y
                    if [ $? -ne 0 ]; then
                        print_error "FAILED to install elan. Cannot continue."
                        echo ""
                        echo "Please install manually:"
                        echo "   brew install elan-init"
                        echo "   OR"
                        echo "   curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
                        exit 1
                    fi
                fi
            else
                # No Homebrew, use curl method
                print_info "Homebrew not found, using curl installation..."
                curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y
                if [ $? -ne 0 ]; then
                    print_error "FAILED to install elan. Cannot continue."
                    echo ""
                    echo "Please install Homebrew first, then run:"
                    echo "   brew install elan-init"
                    exit 1
                fi
            fi
            # Add elan to PATH for this session
            export PATH="$HOME/.elan/bin:$PATH"
        else
            # Linux
            print_info "Installing elan via curl..."
            curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh -s -- -y
            if [ $? -ne 0 ]; then
                print_error "FAILED to install elan. Cannot continue."
                echo ""
                echo "Please install manually:"
                echo "   curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
                exit 1
            fi
            # Add elan to PATH for this session
            export PATH="$HOME/.elan/bin:$PATH"
        fi

        print_success "elan installed successfully"
        echo ""
    else
        print_success "elan is already installed"
    fi

    # Install Lean 4 stable
    if command_exists elan; then
        print_info "Setting up Lean 4 stable..."
        elan default leanprover/lean4:stable
        if [ $? -eq 0 ]; then
            print_success "Lean Prover installed successfully"
            echo ""
            lean --version
            echo ""
        else
            print_error "FAILED to set Lean 4 as default"
            echo ""
            echo "Please try manually:"
            echo "   elan default leanprover/lean4:stable"
            exit 1
        fi
    else
        print_error "elan not found after installation. Cannot continue."
        echo ""
        echo "Please restart your terminal and run setup.sh again."
        echo "Or add elan to PATH manually:"
        echo "   export PATH=\"\$HOME/.elan/bin:\$PATH\""
        exit 1
    fi
fi

# Verify Lean installation
if ! command_exists lean; then
    print_error "CRITICAL: Lean Prover installation failed!"
    echo ""
    echo "Lean Prover is MANDATORY for this application."
    echo ""
    echo "Manual installation:"
    echo "   macOS: brew install elan-init && elan default leanprover/lean4:stable"
    echo "   Linux: curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh"
    echo "          elan default leanprover/lean4:stable"
    echo ""
    echo "After installing Lean, please restart your terminal and run ./setup.sh again."
    exit 1
fi

print_success "Lean Prover verification passed"
echo ""

# Step 6: Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "📚 Installed components:"
echo "   ✓ Node.js dependencies"
echo "   ✓ MCP SymPy Server (symbolic mathematics)"
echo "   ✓ RAG Service (mathematical knowledge base)"
echo "   ✓ Lean Prover (formal verification)"
echo ""
echo "📚 Next steps:"
echo ""
echo "   1. Start all servers:"
echo "      ${GREEN}./start.sh${NC}"
echo ""
echo "   Or start them manually:"
echo "      Terminal 1: ${GREEN}npm run mcp-proxy${NC}     # SymPy backend (port 3001)"
echo "      Terminal 2: ${GREEN}npm run lean-proxy${NC}    # Lean backend (port 3002)"
echo "      Terminal 3: ${GREEN}cd rag_service && source venv/bin/activate && python main.py${NC}  # RAG (port 3003)"
echo "      Terminal 4: ${GREEN}npm run dev${NC}           # Web app (port 5173)"
echo ""
echo "   2. Open browser at: ${BLUE}http://localhost:5173${NC}"
echo ""
echo "   3. Configure your LLM provider:"
echo "      - For Claude: Enter your Anthropic API key"
echo "      - For MLX: Start MLX server and enter URL"
echo ""
echo "   4. Backend is automatically set to:"
echo "      ${GREEN}Oba (SymPy + Lean)${NC} - Full verification enabled"
echo ""
echo "🎉 Happy solving!"
