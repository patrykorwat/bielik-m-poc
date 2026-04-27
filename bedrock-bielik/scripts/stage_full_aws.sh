#!/usr/bin/env bash
# Pełny staging modelu w AWS bez ruszania pliku z laptopa.
# Odpala krótkotrwałą EC2 (Graviton, c7g.large) która:
#   1. pobiera Bielik 11B v3.0 Instruct z Hugging Face
#   2. wgrywa do S3 w tym samym regionie
#   3. zostawia marker sukcesu i sama się terminuje
#
# Czas: 10 do 15 minut. Koszt: poniżej 0,05 USD.
# Alternatywa dla par 01_download_model.sh + 02_upload_to_s3.sh
# kiedy masz słaby upload z domu.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${SCRIPT_DIR}/../terraform"

# Czytanie outputów Terraforma
echo "[1/7] Czytanie outputów z Terraform"
pushd "$TF_DIR" >/dev/null
BUCKET=$(terraform output -raw bucket_name)
S3_URI=$(terraform output -raw model_s3_uri)
REGION=$(terraform output -raw region)
popd >/dev/null
echo "  bucket: ${BUCKET}"
echo "  s3 uri: ${S3_URI}"
echo "  region: ${REGION}"

# HF token: Bielik 11B v3 jest gated, EC2 nie ma cache, musimy mu przekazac token.
echo
echo "[1.5/7] Sprawdzanie HF tokena (model jest gated)"
if [[ -z "${HF_TOKEN:-}" ]]; then
  for candidate in "$HOME/.cache/huggingface/token" "$HOME/.huggingface/token"; do
    if [[ -s "$candidate" ]]; then
      HF_TOKEN=$(cat "$candidate" | tr -d '[:space:]')
      echo "  zaladowano token z $candidate"
      break
    fi
  done
fi
if [[ -z "${HF_TOKEN:-}" ]]; then
  cat <<EOM
  BRAK HF_TOKEN.
  Bielik 11B v3 jest gated. Zrob jedno z dwoch:
    a) huggingface-cli login   (zapisze token do ~/.cache/huggingface/token)
    b) export HF_TOKEN=hf_...   (token z https://huggingface.co/settings/tokens)
  Token musi miec uprawnienie Read i konto musi miec zaakceptowane warunki repo.
EOM
  exit 1
fi
echo "  HF token OK (${#HF_TOKEN} znakow)"

# Sufix unikalny per uruchomienie
SUFFIX="$(date +%s)-$$"
ROLE_NAME="bielik-staging-ec2-role-${SUFFIX}"
PROFILE_NAME="${ROLE_NAME}"
SG_NAME="bielik-staging-sg-${SUFFIX}"
INSTANCE_TYPE="${INSTANCE_TYPE:-m7g.large}"
DISK_GB="${DISK_GB:-60}"

# AMI Amazon Linux 2023 ARM64 (Graviton, taniej i szybciej)
AMI_PARAM="/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"

INSTANCE_ID=""
SG_ID=""

cleanup() {
  local rc=$?
  echo
  echo "[cleanup] Sprzątanie efemerycznych zasobów"

  if [[ -n "$INSTANCE_ID" ]]; then
    STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
      --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo unknown)
    if [[ "$STATE" != "terminated" && "$STATE" != "unknown" ]]; then
      echo "  terminate $INSTANCE_ID"
      aws ec2 terminate-instances --region "$REGION" --instance-ids "$INSTANCE_ID" >/dev/null 2>&1 || true
      aws ec2 wait instance-terminated --region "$REGION" --instance-ids "$INSTANCE_ID" 2>/dev/null || true
    fi
  fi

  # Profile + role
  aws iam remove-role-from-instance-profile --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" 2>/dev/null || true
  aws iam delete-instance-profile --instance-profile-name "$PROFILE_NAME" 2>/dev/null || true
  aws iam delete-role-policy --role-name "$ROLE_NAME" --policy-name s3-write 2>/dev/null || true
  aws iam detach-role-policy --role-name "$ROLE_NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null || true
  aws iam delete-role --role-name "$ROLE_NAME" 2>/dev/null || true

  if [[ -n "$SG_ID" ]]; then
    # SG nie da się skasować od razu po terminate, retry przez minutę
    for i in 1 2 3 4 5 6; do
      if aws ec2 delete-security-group --region "$REGION" --group-id "$SG_ID" 2>/dev/null; then
        break
      fi
      sleep 10
    done
  fi

  echo "[cleanup] Gotowe."
  exit $rc
}
trap cleanup EXIT INT TERM

echo
echo "[2/7] Sprawdzanie aws CLI i tożsamości"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
echo "  account: ${ACCOUNT_ID}"

echo
echo "[3/7] Wybieranie AMI i sieci"
AMI=$(aws ssm get-parameter --region "$REGION" --name "$AMI_PARAM" --query 'Parameter.Value' --output text)
VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=is-default,Values=true \
      --query 'Vpcs[0].VpcId' --output text)
if [[ "$VPC" == "None" || -z "$VPC" ]]; then
  echo "  Brak default VPC w ${REGION}. Utwórz VPC albo podaj VPC_ID przez zmienną środowiskową."
  exit 1
fi
SUBNET=$(aws ec2 describe-subnets --region "$REGION" \
         --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true \
         --query 'Subnets[0].SubnetId' --output text)
echo "  ami:    ${AMI}"
echo "  vpc:    ${VPC}"
echo "  subnet: ${SUBNET}"

echo
echo "[4/7] Tworzenie efemerycznej IAM role i instance profile"
TRUST_POLICY=$(cat <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ec2.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
JSON
)

S3_POLICY=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "s3:PutObject",
      "s3:GetObject",
      "s3:ListBucket",
      "s3:AbortMultipartUpload",
      "s3:ListMultipartUploadParts"
    ],
    "Resource": [
      "arn:aws:s3:::${BUCKET}",
      "arn:aws:s3:::${BUCKET}/*"
    ]
  }]
}
JSON
)

aws iam create-role --role-name "$ROLE_NAME" \
  --assume-role-policy-document "$TRUST_POLICY" >/dev/null
aws iam put-role-policy --role-name "$ROLE_NAME" \
  --policy-name s3-write --policy-document "$S3_POLICY"
aws iam attach-role-policy --role-name "$ROLE_NAME" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
aws iam add-role-to-instance-profile \
  --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME"

# IAM ma eventual consistency, instance profile musi się rozpropagować
echo "  czekam 15s na propagację IAM"
sleep 15

echo
echo "[5/7] Security group (egress only)"
SG_ID=$(aws ec2 create-security-group --region "$REGION" \
  --vpc-id "$VPC" --group-name "$SG_NAME" \
  --description "Bielik staging ephemeral SG" \
  --query GroupId --output text)
echo "  sg: ${SG_ID}"

# User data: bulletproof staging.
# - Watchdog w tle co 30s wgrywa log do S3 (gwarancja widocznosci progresu)
# - bash -x daje pelny trace kazdej komendy
# - jawne sprawdzanie wersji huggingface_hub po instalacji
# - sanity check rozmiaru modelu lokalnie I w S3 zanim oznaczy sie sukces
# - shutdown odlozony do samego konca, po wgraniu markera
USER_DATA=$(cat <<USERDATA
#!/bin/bash
LOG=/var/log/staging.log

upload_log() {
  aws s3 cp \$LOG "${S3_URI}_staging.log" --region "${REGION}" >/dev/null 2>&1 || true
}

# Watchdog: co 30s wysyla aktualny log do S3 niezaleznie od tego co robi reszta
(
  while true; do
    sleep 30
    upload_log
  done
) &
WATCHDOG_PID=\$!

# Wszystko dalej leci do logu i z trace
set -x
exec > >(tee -a \$LOG) 2>&1

echo "=== START \$(date -u) ==="
uname -a
id
cat /etc/os-release || true
ip -4 addr show | grep inet || true

# Test DNS i sieci do HF zanim cokolwiek robimy
echo "-- DNS test --"
getent hosts huggingface.co || echo "huggingface.co NIE rozwiazuje"
getent hosts cas-bridge.xethub.hf.co || echo "cas-bridge nie rozwiazuje"

# Mala pauza na finalizacje servisow systemowych po booth
sleep 5

# Wybor pythona: wolimy 3.11 jesli da sie zainstalowac
echo "-- instalacja Python i pip --"
dnf install -y python3.11 python3.11-pip 2>/dev/null || true
if command -v python3.11 >/dev/null && command -v pip3.11 >/dev/null; then
  PY=python3.11
  PIP=pip3.11
else
  dnf install -y python3-pip
  PY=python3
  PIP=pip3
fi
\$PY --version
\$PIP --version

echo "-- instalacja huggingface_hub --"
\$PIP install --no-cache-dir --upgrade "huggingface_hub>=0.24.0"

echo "-- weryfikacja pakietu --"
\$PY -c "import huggingface_hub; print('hf_hub:', huggingface_hub.__version__)"
HF_VERIFY_RC=\$?
echo "hf verify rc=\$HF_VERIFY_RC"

mkdir -p /mnt/model

echo "-- pobieranie modelu z HF (gated, z tokenem) --"
# Token przekazany przez env, nie wpisany do logu (set +x dla tej sekcji)
set +x
export HF_TOKEN="${HF_TOKEN}"
set -x
# Skrypt python z verbose loggingiem i jawnym exit code
\$PY <<'PY'
import logging, sys, os
logging.basicConfig(level=logging.INFO, stream=sys.stderr,
                    format='%(asctime)s %(levelname)s %(name)s %(message)s')
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
token = os.environ.get("HF_TOKEN")
if not token:
    print("BRAK HF_TOKEN w env, model jest gated", flush=True)
    sys.exit(3)
try:
    from huggingface_hub import snapshot_download
    print("calling snapshot_download (with token)", flush=True)
    p = snapshot_download(
        repo_id="speakleash/Bielik-11B-v3.0-Instruct",
        local_dir="/mnt/model",
        token=token,
        allow_patterns=[
            "config.json", "generation_config.json", "tokenizer.json",
            "tokenizer.model", "tokenizer_config.json", "special_tokens_map.json",
            "*.safetensors", "model.safetensors.index.json",
        ],
        max_workers=8,
    )
    print("snapshot_download path:", p, flush=True)
except Exception as e:
    print("snapshot_download FAILED:", repr(e), flush=True)
    sys.exit(2)
PY
PY_RC=\$?
echo "python download rc=\$PY_RC"
unset HF_TOKEN

echo "-- stan /mnt/model --"
ls -lah /mnt/model || true
df -h / || true

# Sanity check lokalny
SHARDS=\$(ls /mnt/model/*.safetensors 2>/dev/null | wc -l)
TOTAL=\$(du -sb /mnt/model 2>/dev/null | cut -f1)
echo "shards=\$SHARDS total_bytes=\$TOTAL"

STATUS=failure
if [[ "\$PY_RC" -eq 0 ]] && [[ "\$SHARDS" -eq 5 ]] && [[ "\$TOTAL" -ge 21000000000 ]]; then
  echo "-- lokalna weryfikacja OK, sync do S3 --"
  aws s3 sync /mnt/model "${S3_URI}" --region "${REGION}" \
    --exclude ".cache/*" --only-show-errors --no-progress
  SYNC_RC=\$?
  echo "sync rc=\$SYNC_RC"

  # Weryfikacja w S3: tylko shardy "model-NNNNN-of-NNNNN.safetensors",
  # bez index.json ktory tez zawiera slowo "safetensors"
  S3_SHARDS=\$(aws s3 ls "${S3_URI}" --recursive --region "${REGION}" \
    | grep -v "/\.cache/" \
    | grep -cE 'model-[0-9]+-of-[0-9]+\.safetensors\$' || true)
  echo "s3 shards=\$S3_SHARDS"

  if [[ "\$SYNC_RC" -eq 0 ]] && [[ "\$S3_SHARDS" -eq 5 ]]; then
    STATUS=success
  else
    echo "ERROR: sync albo zawartosc S3 nie ok"
  fi
else
  echo "ERROR: lokalna weryfikacja nie przeszla (py_rc=\$PY_RC shards=\$SHARDS total=\$TOTAL)"
fi

set +x
echo "=== END status=\$STATUS \$(date -u) ==="

# Zatrzymaj watchdoga i wyslij ostateczny log
kill \$WATCHDOG_PID 2>/dev/null || true
wait \$WATCHDOG_PID 2>/dev/null || true
upload_log

# Marker
if [[ "\$STATUS" == "success" ]]; then
  echo "ok \$(date -u)" | aws s3 cp - "${S3_URI}_STAGING_SUCCESS" --region "${REGION}" || true
else
  echo "fail \$(date -u) py_rc=\$PY_RC shards=\$SHARDS total=\$TOTAL" \
    | aws s3 cp - "${S3_URI}_STAGING_FAILURE" --region "${REGION}" || true
fi

# Daj 2 minuty na ostatni flush plus margines
/sbin/shutdown -h +2
USERDATA
)

echo
echo "[6/7] Uruchamianie EC2 ${INSTANCE_TYPE}"
INSTANCE_ID=$(aws ec2 run-instances \
  --region "$REGION" \
  --image-id "$AMI" \
  --instance-type "$INSTANCE_TYPE" \
  --subnet-id "$SUBNET" \
  --security-group-ids "$SG_ID" \
  --iam-instance-profile "Name=$PROFILE_NAME" \
  --instance-initiated-shutdown-behavior terminate \
  --block-device-mappings "[{\"DeviceName\":\"/dev/xvda\",\"Ebs\":{\"VolumeSize\":${DISK_GB},\"VolumeType\":\"gp3\",\"DeleteOnTermination\":true}}]" \
  --metadata-options "HttpTokens=required,HttpEndpoint=enabled" \
  --user-data "$USER_DATA" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=bielik-staging},{Key=Project,Value=bielik-bedrock}]" \
  --query 'Instances[0].InstanceId' \
  --output text)

echo "  instanceId: ${INSTANCE_ID}"

echo
echo "[7/7] Czekanie na zakończenie (poll co 30s, timeout 60 min)"
echo "Watchdog na EC2 wgrywa /var/log/staging.log do S3 co 30s,"
echo "wiec orchestrator co 45s wypluje Ci tail tego logu zebys widzial co sie dzieje."
echo

LOG_LOCAL="/tmp/bielik_staging_${INSTANCE_ID}.log"
START=$(date +%s)
DEADLINE=$((START + 60 * 60))
LAST_LOG_FETCH=0

while true; do
  STATE=$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo "?")
  ELAPSED=$(( $(date +%s) - START ))
  echo "  [$(printf '%4ds' $ELAPSED)] state=${STATE}"

  # Co 45s sciagnij log z S3 i pokaz ostatnie 30 linii
  NOW=$(date +%s)
  if (( NOW - LAST_LOG_FETCH >= 45 )); then
    LAST_LOG_FETCH=$NOW
    if aws s3 cp "${S3_URI}_staging.log" "$LOG_LOCAL" --region "$REGION" 2>/dev/null; then
      echo "  --- /var/log/staging.log (ostatnie 30 linii) ---"
      tail -30 "$LOG_LOCAL" | sed 's/^/    /'
      echo "  ---"
    fi
  fi

  if [[ "$STATE" == "terminated" ]]; then
    break
  fi

  if (( $(date +%s) > DEADLINE )); then
    echo "Timeout 60 min. Sprawdź instancję ręcznie: ${INSTANCE_ID}"
    exit 2
  fi

  sleep 30
done

echo
echo "Sprawdzanie statusu w S3"
if aws s3 ls "${S3_URI}_STAGING_SUCCESS" --region "$REGION" >/dev/null 2>&1; then
  echo "OK marker sukcesu obecny."
  aws s3 rm "${S3_URI}_STAGING_SUCCESS" --region "$REGION" >/dev/null
  # Log zachowujemy zeby mozna bylo potem zerknac jak co dlugo trwalo.
  echo
  echo "Pliki w S3 (${S3_URI}, recursive, bez .cache):"
  aws s3 ls "${S3_URI}" --region "$REGION" --recursive --human-readable --summarize \
    | grep -v "/\.cache/" || true
  echo
  echo "Log z EC2 zostawiony pod ${S3_URI}_staging.log (mozesz usunac recznie)."
  echo
  echo "Następny krok: bash scripts/03_create_import_job.sh"
else
  echo "BRAK markera sukcesu."
  if aws s3 ls "${S3_URI}_STAGING_FAILURE" --region "$REGION" >/dev/null 2>&1; then
    echo "Marker FAILURE obecny. Pobieram log z S3..."
    LOG_LOCAL="/tmp/bielik_staging_${INSTANCE_ID}.log"
    aws s3 cp "${S3_URI}_staging.log" "$LOG_LOCAL" --region "$REGION" 2>&1 || true
    if [[ -f "$LOG_LOCAL" ]]; then
      echo
      echo "===== /var/log/staging.log z EC2 ====="
      cat "$LOG_LOCAL"
      echo "===== koniec logu ====="
      echo
      echo "Lokalna kopia logu: $LOG_LOCAL"
    else
      echo "Nie udało się pobrać logu z S3. Pewnie nawet do tego nie doszło."
    fi
    aws s3 rm "${S3_URI}_STAGING_FAILURE" --region "$REGION" >/dev/null 2>&1 || true
    aws s3 rm "${S3_URI}_staging.log" --region "$REGION" >/dev/null 2>&1 || true
  else
    echo "Brak także markera FAILURE - user-data prawdopodobnie nie doszło do końca."
    echo "Możliwe przyczyny: cloud-init nie odpalił, instance nie miał IAM albo egress."
    echo "Spróbuj ponownie albo dodaj --no-terminate i SSM in."
  fi
  exit 1
fi
