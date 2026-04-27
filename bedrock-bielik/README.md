# Bielik 11B v3.0 Instruct na AWS Bedrock

Bundle do deploymentu Bielik-11B-v3.0-Instruct na AWS Bedrock przez Custom Model Import (CMI).

## Co to jest

Bedrock Custom Model Import importuje wagi w formacie HuggingFace transformers (safetensors) i serwuje je jako natywny model w Bedrock. Płacisz za Custom Model Units (CMU) per minuta aktywności. Model po 5 minutach bezczynności jest wyładowywany, kolejne wywołanie powoduje cold start.

Bielik 11B v3.0 Instruct bazuje na architekturze Mistral (depth upscaled z Mistral 7B v0.2), więc jest zgodny z CMI. Format promptu to ChatML.

## Wymagania

Lokalnie:

* Python 3.10+ z `huggingface_hub`
* AWS CLI v2
* Terraform 1.5+
* `jq`
* Około 25 GB wolnego miejsca na dysku
* Dobre łącze (pobranie 22 GB)

Na koncie AWS:

* Region us-east-1 (lub us-west-2)
* Uprawnienia do tworzenia: S3 bucket, IAM role, Bedrock model import job
* Włączony dostęp do Bedrock w konsoli (jednorazowy klik w "Model access" przy pierwszym użyciu)
* Service quota: domyślnie 3 imported models per account, wystarcza

## Pliki

```
bedrock-bielik/
├── terraform/
│   ├── main.tf              S3 bucket plus IAM role dla Bedrock CMI
│   ├── variables.tf
│   └── outputs.tf
├── scripts/
│   ├── 01_download_model.sh    Pobranie wag z Hugging Face (lokalnie)
│   ├── 02_upload_to_s3.sh      Sync do S3 (z laptopa)
│   ├── stage_full_aws.sh       ALTERNATYWA dla 01+02: cały staging na EC2
│   ├── 03_create_import_job.sh Job importu w Bedrock
│   └── 04_invoke_test.sh       Smoke test
└── README.md
```

## Runbook

### Krok 0: Konfiguracja

```bash
aws configure                # albo export AWS_PROFILE=...
export AWS_REGION=us-east-1
export HF_TOKEN=hf_...        # opcjonalnie, jeśli HF wymaga
```

### Krok 1: Provisioning S3 i IAM

```bash
cd bedrock-bielik/terraform
terraform init
terraform plan
terraform apply
```

Wyjścia: `bucket_name`, `model_s3_uri`, `import_role_arn`, `region`.

### Krok 2 i 3: Staging modelu

Masz dwie opcje. Wybierz jedną.

**Opcja A: lokalnie (szybka jeśli masz dobry upload)**

```bash
cd ..
bash scripts/01_download_model.sh   # ~22 GB pobiera do ./model-cache/
bash scripts/02_upload_to_s3.sh     # sync do S3
```

Wąskim gardłem jest Twój upload bandwidth. Przy 100 Mbps symetrycznym ~30 do 45 minut, przy 20 Mbps upload ~2,5 godziny.

**Opcja B: cały staging na EC2 (zalecane jeśli masz słaby upload domowy)**

```bash
cd ..
bash scripts/stage_full_aws.sh
```

Skrypt provisionuje krótkotrwałą EC2 (c7g.large, Graviton, default VPC), tworzy efemeryczną IAM role z dostępem do S3, instancja pobiera model z Hugging Face (kilka minut bo łącze AWS) i robi sync do S3 in-region (sekundy). Self-terminate, cleanup IAM i SG. Cały czas: 10 do 15 minut. Koszt: poniżej 0,05 USD.

Możesz w drugim terminalu śledzić logi przez SSM Session Manager (komenda zostanie wypisana po starcie instancji).

### Krok 4: Import do Bedrock

```bash
bash scripts/03_create_import_job.sh
```

Tworzy job, polluje status co 30s, czeka na `Completed`. Typowo 15 do 45 minut. Zapisuje ARN zaimportowanego modelu do `.imported_model_arn`.

### Krok 5: Smoke test

```bash
bash scripts/04_invoke_test.sh
```

Wysyła ChatML prompt po polsku i wypisuje odpowiedź. Pierwsze wywołanie po imporcie albo po dłuższej bezczynności potrafi mieć cold start kilkadziesiąt sekund.

## Format promptu

Bielik v3 używa ChatML:

```
<|im_start|>system
{system}<|im_end|>
<|im_start|>user
{user}<|im_end|>
<|im_start|>assistant

```

Payload do `bedrock-runtime invoke-model`:

```json
{
  "prompt": "<|im_start|>system\n...<|im_end|>\n<|im_start|>user\n...<|im_end|>\n<|im_start|>assistant\n",
  "max_tokens": 512,
  "temperature": 0.3,
  "top_p": 0.9
}
```

Stop sequence: `<|im_end|>`.

Format odpowiedzi to OpenAI text_completion (Bedrock CMI uruchamia vLLM pod spodem):

```json
{
  "id": "cmpl-...",
  "object": "text_completion",
  "model": "<account>-<modelId>",
  "choices": [
    {
      "index": 0,
      "text": "wygenerowany tekst",
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 78,
    "completion_tokens": 192,
    "total_tokens": 270
  }
}
```

Tekst wyciągasz z `.choices[0].text`.

## Koszty

CMU to jednostka rozliczeniowa Bedrock CMI. Bielik 11B w bf16 mieści się typowo w 2 CMU (Mistral architecture, do 12B parametrów). Cennik on demand (us-east-1, połowa 2025):

| Pozycja | Stawka |
|---|---|
| 1 CMU per minuta (active) | ~0,0785 USD |
| 2 CMU per minuta (Bielik 11B) | ~0,157 USD |
| 1 CMU per godzina | ~4,71 USD |
| Storage modelu | ~1,95 USD per model per miesiąc |

Przykładowy miesięczny koszt:

* 100 requestów dziennie, średnio 1s gen na request, model wyładowany większość czasu: praktycznie tylko cold starty plus active minutes. Spodziewaj się ~30 do 60 USD/miesiąc.
* Stały ruch (model praktycznie cały czas active): 2 CMU * 60 minut * 24h * 30 = ~6800 USD/miesiąc. W tym scenariuszu SageMaker Real Time Endpoint na ml.g5.2xlarge wychodzi około 850 USD/miesiąc i jest dużo tańszy.

Wniosek: Bedrock CMI ma sens dla ruchu sporadycznego do średniego. Dla stałego load przerzuć się na SageMaker albo EC2 plus vLLM.

Aktualne ceny: <https://aws.amazon.com/bedrock/pricing/> sekcja Custom Model Import.

## Wywołanie z aplikacji

### Python (boto3)

```python
import boto3, json

client = boto3.client("bedrock-runtime", region_name="us-east-1")
model_arn = "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123"

prompt = (
    "<|im_start|>system\nJesteś pomocnym asystentem.<|im_end|>\n"
    "<|im_start|>user\nWyjaśnij twierdzenie Pitagorasa.<|im_end|>\n"
    "<|im_start|>assistant\n"
)

resp = client.invoke_model(
    modelId=model_arn,
    body=json.dumps({
        "prompt": prompt,
        "max_tokens": 512,
        "temperature": 0.3,
        "top_p": 0.9,
    }),
)
print(json.loads(resp["body"].read()))
```

### Node.js (AWS SDK v3)

```javascript
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";

const client = new BedrockRuntimeClient({ region: "us-east-1" });
const modelArn = "arn:aws:bedrock:us-east-1:123456789012:imported-model/abc123";

const prompt =
  "<|im_start|>system\nJesteś pomocnym asystentem.<|im_end|>\n" +
  "<|im_start|>user\nWyjaśnij twierdzenie Pitagorasa.<|im_end|>\n" +
  "<|im_start|>assistant\n";

const cmd = new InvokeModelCommand({
  modelId: modelArn,
  contentType: "application/json",
  accept: "application/json",
  body: JSON.stringify({
    prompt,
    max_tokens: 512,
    temperature: 0.3,
    top_p: 0.9,
  }),
});

const resp = await client.send(cmd);
const json = JSON.parse(new TextDecoder().decode(resp.body));
console.log(json);
```

## Troubleshooting

**Job importu kończy się statusem Failed z komunikatem o konfiguracji**: sprawdź czy w S3 są wszystkie pliki, w tym `model.safetensors.index.json`. Bedrock CMI wymaga formatu shardowanego safetensors. Bielik publikuje to natywnie.

**Job Failed z komunikatem o architekturze**: zweryfikuj że `config.json` ma `"model_type": "mistral"`. Inne typy (np. mixtral, llama) działają, ale niektóre customowe nie.

**Cold start trwa 60+ sekund**: to normalne dla pierwszego wywołania albo po długim idle. Trzymaj model "ciepły" przez okresowe ping requesty co 4 minuty, jeśli chcesz uniknąć opóźnień.

**ThrottlingException**: domyślny limit to 1 RPS dla custom modeli per account. Zwiększenie przez Service Quotas: Bedrock => "On-demand inference custom model requests per second".

**Wagi nie pasują (size mismatch)**: upewnij się że nie pobrałeś omyłkowo wariantu GGUF, AWQ, FP8 albo MLX. Skrypt 01 ma ograniczone `allow_patterns` i powinien tego unikać.

## Dezprovision

```bash
# Usuń zaimportowany model w Bedrock
aws bedrock delete-imported-model \
  --region us-east-1 \
  --model-identifier "$(cat .imported_model_arn)"

# Wyczyść bucket i zniszcz infrastrukturę
cd terraform
aws s3 rm "$(terraform output -raw model_s3_uri)" --recursive
terraform destroy
```

## Integracja z aplikacja formulo (direct, bez proxy)

`bedrock-bielik/llm-client.mjs` to drop-in replacement dla `new OpenAI(...)`.
Eksportuje `createLLMClient(...)` ktory zwraca albo OpenAI klienta (gdy
`BEDROCK_MODEL_ARN` jest puste), albo BedrockChatShim z identycznym
interfejsem `.chat.completions.create()` ale wolajacy bezposrednio
`bedrock:InvokeModel`. ChatML translation, mapowanie text_completion -> chat.completion,
ten sam shape `{choices: [{message: {role, content}, finish_reason}], usage: {...}}`.

solve-pipeline.js zaimportowano juz z tego modulu, nic wiecej w kodzie nie zmieniasz.

### IAM user dla aplikacji

Terraform tworzy usera `BielikBedrockProxy` (nazwa historyczna, ale uzywamy go teraz
direct z formulo). Po imporcie modelu odpal:

```bash
cd bedrock-bielik/terraform
ARN=$(cat ../.imported_model_arn)
terraform apply -var="imported_model_arn=$ARN"

# Sensitive output, zapisz w secret managerze albo bezposrednio do env Lightsaila
terraform output -raw proxy_aws_access_key_id
terraform output -raw proxy_aws_secret_access_key
```

Polityka tego usera obejmuje wylacznie `bedrock:InvokeModel` i
`bedrock:InvokeModelWithResponseStream` na ten konkretny importowany model.
Wyciek = atakujacy moze placic za inferencje, nic wiecej.

### Konfiguracja env na Lightsail

W docker-compose albo w env Lightsailowego kontenera dodaj:

```
BEDROCK_MODEL_ARN=arn:aws:bedrock:us-east-1:122952597476:imported-model/<id>
BEDROCK_REGION=us-east-1
AWS_ACCESS_KEY_ID=<z terraform output>
AWS_SECRET_ACCESS_KEY=<z terraform output>
```

`LLM_API_URL` i `LLM_API_KEY` mozesz zostawic puste albo usunac. Gdy
`BEDROCK_MODEL_ARN` jest ustawione, klient jedzie do Bedrock i ignoruje
te zmienne.

### Latencja

Lightsail Frankfurt -> Bedrock us-east-1 to ~110 ms RTT plus inferencja.
Nie da sie tego w prosty sposob skrocic, chyba ze przeniesiesz aplikacje
do us-east-1 (albo Bedrock zacznie udostepniac CMI w Europie).
Frankfurt zostaje sensowny tylko dla dolnych warstw stacku ktore nie
wymagaja LLM (statyki, frontend, cache).

### Alternatywa: proxy jako standalone (folder proxy/)

Folder `proxy/` zawiera Node serwer ktory wystawia `/v1/chat/completions` i
tlumaczy do Bedrock. Jezeli chcesz zostawic OpenAI-compatible API i nie
modyfikowac klientow, mozesz odpalic to jako sidecar. Dla samego formulo
juz niepotrzebne, mozesz skasowac: `rm -rf bedrock-bielik/proxy`.

## Linki

* Model: <https://huggingface.co/speakleash/Bielik-11B-v3.0-Instruct>
* Bedrock CMI docs: <https://docs.aws.amazon.com/bedrock/latest/userguide/model-customization-import-model.html>
* Bedrock pricing: <https://aws.amazon.com/bedrock/pricing/>
