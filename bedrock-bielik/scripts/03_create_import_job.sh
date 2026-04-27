#!/usr/bin/env bash
# Utworzenie joba importu w Bedrock i poczekanie aż zakończy się sukcesem.
# Job typowo trwa 15 do 45 minut dla 11B.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"
JOB_NAME="${JOB_NAME:-bielik-11b-v3-import-$(date +%Y%m%d-%H%M%S)}"
MODEL_NAME="${MODEL_NAME:-bielik-11b-v3-instruct}"

echo "[1/4] Czytanie outputów z Terraform"
pushd "$TF_DIR" >/dev/null
S3_URI=$(terraform output -raw model_s3_uri)
ROLE_ARN=$(terraform output -raw import_role_arn)
REGION=$(terraform output -raw region)
popd >/dev/null

echo "  s3 uri:   ${S3_URI}"
echo "  role arn: ${ROLE_ARN}"
echo "  region:   ${REGION}"
echo "  job:      ${JOB_NAME}"
echo "  model:    ${MODEL_NAME}"

echo
echo "[2/4] Tworzenie joba importu"
aws bedrock create-model-import-job \
  --region "$REGION" \
  --job-name "$JOB_NAME" \
  --imported-model-name "$MODEL_NAME" \
  --role-arn "$ROLE_ARN" \
  --model-data-source "s3DataSource={s3Uri=${S3_URI}}" \
  --output json | tee /tmp/bielik_import_job.json

JOB_ARN=$(jq -r '.jobArn' /tmp/bielik_import_job.json)
echo "  jobArn: ${JOB_ARN}"

echo
echo "[3/4] Czekanie na zakończenie joba (poll co 30s, timeout 90 min)"
DEADLINE=$(( $(date +%s) + 90 * 60 ))
while true; do
  STATUS=$(aws bedrock get-model-import-job \
    --region "$REGION" \
    --job-identifier "$JOB_ARN" \
    --query 'status' --output text)
  echo "  $(date +%H:%M:%S) status=${STATUS}"
  case "$STATUS" in
    Completed)
      break
      ;;
    Failed)
      echo "Job się nie powiódł. Szczegóły:"
      aws bedrock get-model-import-job --region "$REGION" --job-identifier "$JOB_ARN"
      exit 1
      ;;
    InProgress|Submitted)
      ;;
    *)
      echo "Nieznany status: ${STATUS}"
      ;;
  esac
  if (( $(date +%s) > DEADLINE )); then
    echo "Timeout. Job nadal w toku, sprawdź ręcznie."
    exit 2
  fi
  sleep 30
done

echo
echo "[4/4] Pobieranie ARN zaimportowanego modelu"
MODEL_ARN=$(aws bedrock get-model-import-job \
  --region "$REGION" \
  --job-identifier "$JOB_ARN" \
  --query 'importedModelArn' --output text)

echo "  importedModelArn: ${MODEL_ARN}"

# Zapis do pliku żeby smoke test go znalazł
echo "${MODEL_ARN}" > "${SCRIPT_DIR}/../.imported_model_arn"
echo
echo "Gotowe. ARN zapisany w bedrock-bielik/.imported_model_arn"
echo "Następny krok: bash scripts/04_invoke_test.sh"
