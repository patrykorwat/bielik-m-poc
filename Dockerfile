# ── Stage 1: Lean 4 + Mathlib (cached unless Dockerfile changes) ─────
FROM node:20-slim AS lean-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/root
ENV ELAN_HOME=/root/.elan
ENV PATH="/root/.elan/bin:${PATH}"

# Install elan and Lean 4
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain leanprover/lean4:stable --no-modify-path \
    && elan show \
    && lean --version

# Create Lean project with Mathlib dependency and download pre-compiled oleans
WORKDIR /root/lean-project
RUN lake init formulo_verify math \
    && lake update \
    && lake exe cache get \
    && echo "=== Mathlib cache downloaded ==="

# ── Stage 2: Build frontend + TypeScript ─────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm run build:server && npm run generate:seo \
    && cd mcp-sympy-server && npm install && npm run build

# ── Stage 3: Production ──────────────────────────────────────────────
FROM lean-base

WORKDIR /app

# node_modules from builder (changes when package-lock changes)
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
RUN python3 -m venv rag_service/venv \
    && rag_service/venv/bin/pip install --no-cache-dir \
       -r rag_service/requirements.txt -r requirements.txt

EXPOSE 5000
CMD ["node", "--import", "dd-trace/initialize.mjs", "heroku-start.js"]
