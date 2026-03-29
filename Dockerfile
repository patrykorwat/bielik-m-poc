# Stage 1: Build frontend + server
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies first (cacheable layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and build
COPY . .
RUN npm run build && npm run build:server && npm run generate:seo

# Build MCP SymPy server
RUN cd mcp-sympy-server && npm install && npm run build

# Stage 2: Production image with Lean 4
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    git \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Install elan (Lean version manager) and Lean 4 stable
ENV ELAN_HOME=/usr/local/elan
ENV PATH="${ELAN_HOME}/bin:${PATH}"

RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain leanprover/lean4:stable --no-modify-path \
    && mv /root/.elan ${ELAN_HOME} \
    && chmod -R a+rx ${ELAN_HOME}

# Verify lean is available
RUN lean --version

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/mcp-sympy-server ./mcp-sympy-server
COPY --from=builder /app/seo ./seo
COPY --from=builder /app/node_modules ./node_modules

# Copy server files
COPY package.json ./
COPY heroku-start.js solve-pipeline.js mcp-proxy-server.js lean-proxy-server.js prompts.json ./
COPY extraction-templates.js deterministic-solvers.js decomposer.js ./
COPY docs ./docs
COPY discord-bot.js ./

# Setup RAG service Python environment
COPY rag_service ./rag_service
COPY requirements.txt ./
RUN python3 -m venv rag_service/venv \
    && rag_service/venv/bin/pip install --no-cache-dir -r rag_service/requirements.txt \
    && rag_service/venv/bin/pip install --no-cache-dir -r requirements.txt

# Expose port (Heroku sets $PORT dynamically)
EXPOSE 5000

CMD ["node", "--import", "dd-trace/initialize.mjs", "heroku-start.js"]
