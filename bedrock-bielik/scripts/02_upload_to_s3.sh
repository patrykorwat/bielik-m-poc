#!/usr/bin/env bash
# Wgranie wag Bielik 11B v3.0 do S3 pod prefix oczekiwany przez Bedrock CMI.
# Czyta zmienne z terraform output (musi być wcześniej terraform apply).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"
LOCAL_DIR="${LOCAL_DIR:-./model-cache/bielik-11b-v3.0-instruct}"

if [[ ! -d "$LOCAL_DIR" ]]; then
  echo "Brak katalogu ${LOCAL_DIR}. Najpierw odpal scripts/01_download_model.sh"
  exit 1
fi

echo "[1/3] Czytanie outputów z Terraform"
pushd "$TF_DIR" >/dev/null
BUCKET=$(terraform output -raw bucket_name)
S3_URI=$(terraform output -raw model_s3_uri)
REGION=$(terraform output -raw region)
popd >/dev/null

echo "  bucket: ${BUCKET}"
echo "  s3 uri: ${S3_URI}"
echo "  region: ${REGION}"

echo
echo "[2/3] Sprawdzanie aws CLI i tożsamości"
aws sts get-caller-identity --region "$REGION" >/dev/null
echo "  OK"

echo
echo "[3/3] Synchronizacja do S3"
echo "  źródło: ${LOCAL_DIR}"
echo "  cel:    ${S3_URI}"

aws s3 sync \
  "$LOCAL_DIR" \
  "$S3_URI" \
  --region "$REGION" \
  --only-show-errors \
  --no-progress

echo
echo "Gotowe. Plik manifestu i wagi powinny być widoczne pod:"
echo "  aws s3 ls ${S3_URI} --region ${REGION}"
echo
echo "Następny krok: bash scripts/03_create_import_job.sh"
