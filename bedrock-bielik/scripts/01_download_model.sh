#!/usr/bin/env bash
# Pobranie wag Bielik 11B v3.0 Instruct z Hugging Face do lokalnego katalogu.
# Wymaga: huggingface-hub (pip install huggingface_hub) i opcjonalnie HF_TOKEN.
# Pobiera tylko pliki niezbędne do importu w Bedrock CMI (safetensors + tokenizer + configi).

set -euo pipefail

REPO="speakleash/Bielik-11B-v3.0-Instruct"
LOCAL_DIR="${LOCAL_DIR:-./model-cache/bielik-11b-v3.0-instruct}"

mkdir -p "$LOCAL_DIR"

echo "[1/2] Sprawdzanie zależności"
if ! python3 -c "import huggingface_hub" >/dev/null 2>&1; then
  echo "Instaluje huggingface_hub"
  python3 -m pip install --quiet --upgrade "huggingface_hub>=0.24.0"
fi

echo "[2/2] Pobieranie ${REPO} do ${LOCAL_DIR}"
echo "Rozmiar ~22 GB. Pobieranie potrwa zależnie od łącza."

python3 <<PY
from huggingface_hub import snapshot_download
import os

repo_id = "${REPO}"
local_dir = "${LOCAL_DIR}"
token = os.environ.get("HF_TOKEN")

# Pliki potrzebne dla Bedrock Custom Model Import.
# Pomijamy GGUF, AWQ, oraz pliki .bin gdy są równoważne safetensors.
allow = [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer.model",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "chat_template.json",
    "*.safetensors",
    "model.safetensors.index.json",
]

snapshot_download(
    repo_id=repo_id,
    local_dir=local_dir,
    allow_patterns=allow,
    token=token,
    max_workers=8,
)

print("Pobrano:", local_dir)
PY

echo
echo "Lista plików:"
ls -lah "$LOCAL_DIR"

echo
echo "Sprawdzenie czy są wszystkie wymagane pliki:"
for f in config.json tokenizer.json tokenizer_config.json model.safetensors.index.json; do
  if [[ -f "$LOCAL_DIR/$f" ]]; then
    echo "  OK $f"
  else
    echo "  BRAK $f"
    exit 1
  fi
done

echo
echo "Gotowe. Następny krok: bash scripts/02_upload_to_s3.sh"
