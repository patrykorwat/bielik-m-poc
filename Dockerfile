# ── Stage 1: Lean 4 + Mathlib (pre-compiled cache, ~5GB) ─────────────
FROM node:20-slim AS lean-base

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

ENV ELAN_HOME=/opt/elan
ENV PATH="/opt/elan/bin:${PATH}"

# Instalacja elan (pozwoli automatycznie pobrac toolchain wymagany przez lean-project)
RUN curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh \
    | sh -s -- -y --default-toolchain none --no-modify-path \
    && chmod -R 777 /opt/elan

# Lean project + Mathlib pre-compiled. Toolchain wybierany przez lean-toolchain
# z lean-project/, mathlib pobierany jako pre-built olean cache (lake exe cache get).
COPY lean-project /app/lean-project
WORKDIR /app/lean-project
RUN elan toolchain install $(cat lean-toolchain) \
    && elan default $(cat lean-toolchain) \
    && lean --version \
    && lake update \
    && lake exe cache get \
    && chmod -R 755 /opt/elan
WORKDIR /app

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

# Install Tesseract OCR for image-to-text (math problems from photos)
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-pol \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

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
COPY datasets ./datasets

# Bedrock client shim (uzywany przez solve-pipeline.js gdy BEDROCK_MODEL_ARN ustawione)
COPY bedrock-bielik/llm-client.mjs ./bedrock-bielik/llm-client.mjs

# RAG Python environment
COPY rag_service ./rag_service
COPY requirements.txt ./
RUN python3 -m venv rag_service/venv \
    && rag_service/venv/bin/pip install --no-cache-dir -r requirements.txt

# MCP SymPy server venv (sympy must be importable z mcp-sympy-server/venv/bin/python3)
RUN python3 -m venv mcp-sympy-server/venv \
    && mcp-sympy-server/venv/bin/pip install --no-cache-dir sympy

# Slim Python venvs: usuwamy testy paczek (numpy/scipy/sklearn pakuja kompletne
# suity testowe, ~500 MB w sumie), bytecode cache, dist-info docs.
RUN find /app -type d \( \
        -name 'tests' -o -name 'test' -o -name '__pycache__' \
    \) -prune -exec rm -rf {} + 2>/dev/null || true \
    && find /app -type d -name '*.dist-info' \
        -exec sh -c 'rm -rf "$1"/RECORD "$1"/INSTALLER "$1"/REQUESTED' _ {} \; 2>/dev/null || true \
    && find /app -name '*.pyc' -delete 2>/dev/null || true \
    && find /app -name '*.pyo' -delete 2>/dev/null || true

# Start entrypoint: launch Datadog agent then the app
COPY deploy/docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["npm", "run", "start:heroku"]