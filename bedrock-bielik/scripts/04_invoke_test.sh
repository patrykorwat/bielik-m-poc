#!/usr/bin/env bash
# Smoke test zaimportowanego modelu. Wywołanie przez bedrock-runtime z promptem ChatML.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"
ARN_FILE="${SCRIPT_DIR}/../.imported_model_arn"

if [[ ! -f "$ARN_FILE" ]]; then
  echo "Brak pliku ${ARN_FILE}. Najpierw odpal scripts/03_create_import_job.sh"
  exit 1
fi

MODEL_ARN=$(cat "$ARN_FILE")
REGION=$(cd "$TF_DIR" && terraform output -raw region)

echo "Model:  ${MODEL_ARN}"
echo "Region: ${REGION}"
echo

# ChatML prompt zgodny z formatem Bielik 11B v3.0 Instruct.
read -r -d '' PROMPT <<'TXT' || true
<|im_start|>system
Jesteś pomocnym polskim asystentem AI. Odpowiadaj zwięźle i konkretnie.<|im_end|>
<|im_start|>user
Wymień trzy największe rzeki w Polsce w kolejności od najdłuższej do najkrótszej.<|im_end|>
<|im_start|>assistant
TXT

PAYLOAD=$(jq -n \
  --arg p "$PROMPT" \
  '{
    prompt: $p,
    max_tokens: 256,
    temperature: 0.2,
    top_p: 0.9
  }')

echo "Wysyłam zapytanie..."
echo "$PAYLOAD" > /tmp/bielik_payload.json

# Pierwsze wywołanie po dłuższej bezczynności może mieć cold start (kilkadziesiąt sekund).
aws bedrock-runtime invoke-model \
  --region "$REGION" \
  --model-id "$MODEL_ARN" \
  --content-type application/json \
  --accept application/json \
  --body fileb:///tmp/bielik_payload.json \
  /tmp/bielik_response.json

echo
echo "Odpowiedź surowa:"
cat /tmp/bielik_response.json | jq .

echo
echo "Wygenerowany tekst:"
jq -r '.choices[0].text // .generation // .outputs[0].text // .' /tmp/bielik_response.json
