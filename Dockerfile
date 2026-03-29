# ── Stage 1: Lean 4 (no Mathlib, saves ~2GB RAM) ─────────────────────
FROM node:20-slim AS lean-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV ELAN_HOME=/opt/elan
ENV PATH="/opt/elan/bin:${PATH}"

RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain leanprover/lean4:stable --no-modify-path \
    && elan show \
    && lean --version \
    && chmod -R 777 /opt/elan

# ── Stage 2: Build frontend + TypeScript ─────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server && npm run generate:seo \
    && cd mcp-sympy-server && npm install && npm run build \
    ## NEW: Remove all devDependencies before we copy node_modules to prod
    && cd /app && npm prune --omit=dev

# ── Stage 3: Production ──────────────────────────────────────────────
FROM lean-base

WORKDIR /app

# node_modules from builder (now strictly production modules)
COPY --from=builder /app/node_modules ./node_modules

# Built artifacts (changes on code changes)
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/mcp-sympy-server ./mcp-sympy-server
COPY --from=builder /app/seo ./seo

# Server files
COPY package.json heroku-start.js solve-pipeline.js mcp-proxy-server.js \
     lean-proxy-server.js prompts.json extraction-templates.js \
     deterministic-solvers.js decomposer.js discord-bot.js ./
COPY docs ./docs

# RAG Python environment
COPY rag_service ./rag_service
COPY requirements.txt ./
## NEW: Added --no-cache-dir to prevent pip from storing useless zip files
RUN python3 -m venv rag_service/venv \
    && rag_service/venv/bin/pip install --no-cache-dir -r requirements.txt

# Start command
CMD ["npm", "run", "start:heroku"]