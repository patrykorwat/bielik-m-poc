# 🚀 Przewodnik MLX - Apple Silicon Optimized Inference

## Co to jest MLX?

MLX to framework machine learning zaprojektowany przez Apple specjalnie dla układów Apple Silicon. Wykorzystuje Neural Engine i GPU do ultraszybkiego lokalnego inference bez kosztów API.

## Instalacja MLX

### Opcja 1: Homebrew (zalecane)

```bash
brew install mlx-lm
```

### Opcja 2: pip

```bash
pip install mlx mlx-lm
```

## Uruchamianie serwera MLX

### Podstawowe użycie

```bash
mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit
```

Serwer uruchomi się na `http://localhost:8080` (domyślnie).

### Zaawansowane opcje

```bash
# Niestandardowy port
mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8000

# Większy model (wymaga więcej RAM)
mlx_lm.server --model mlx-community/Llama-3.2-7B-Instruct-4bit

# Polski model Bielik
mlx_lm.server --model mlx-community/Bielik-11B-v2.3-Instruct-4bit
```

## Dostępne modele MLX

### Modele małe (3B) - szybkie, wymagają ~4GB RAM
- `mlx-community/Llama-3.2-3B-Instruct-4bit`
- `mlx-community/Phi-3-mini-4k-instruct-4bit`

### Modele średnie (7B-11B) - dobra jakość, wymagają ~8GB RAM
- `mlx-community/Llama-3.2-7B-Instruct-4bit`
- `mlx-community/Mistral-7B-Instruct-v0.3-4bit`
- `mlx-community/Bielik-11B-v2.3-Instruct-4bit` ⭐ Polski model!

### Modele duże (13B+) - najlepsza jakość, wymagają 16GB+ RAM
- `mlx-community/Mixtral-8x7B-Instruct-v0.1-4bit`

## Konfiguracja w Bielik-M

### W interfejsie użytkownika

1. Wybierz "MLX (Apple Silicon - lokalny)" z dropdown
2. Wprowadź URL serwera (domyślnie `http://localhost:8080`)
3. Wprowadź nazwę modelu (np. `mlx-community/Llama-3.2-3B-Instruct-4bit`)
4. Kliknij "Rozpocznij"

### Programatycznie

```typescript
import { GroupChatOrchestrator, createMathAgents } from './services/agentService';

const agents = createMathAgents();

const orchestrator = new GroupChatOrchestrator(
  'mlx',
  agents,
  undefined,
  {
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    temperature: 0.7,
    maxTokens: 4096
  }
);

// Użyj orchestratora
await orchestrator.orchestrateConversation(
  "Rozwiąż równanie: x² + 5x + 6 = 0",
  2,
  (message) => console.log(message)
);
```

## Zalety MLX

✅ **Darmowy** - brak kosztów API
✅ **Prywatny** - wszystkie dane pozostają lokalnie
✅ **Szybki** - akceleracja sprzętowa Neural Engine
✅ **Offline** - działa bez połączenia z internetem
✅ **Efektywny** - optymalizacja dla Apple Silicon

## Wymagania systemowe

- Mac z Apple Silicon (M1, M2, M3, M4, M5)
- macOS 14.0 lub wyższy
- 8GB RAM (min.), 16GB RAM (zalecane)
- ~10GB wolnego miejsca na dysku (dla modelu)

## Rozwiązywanie problemów

### Serwer się nie uruchamia

```bash
# Sprawdź, czy MLX jest zainstalowane
mlx_lm.server --help

# Jeśli nie działa, przeinstaluj
pip uninstall mlx mlx-lm
pip install mlx mlx-lm
```

### Błąd połączenia

1. Upewnij się, że serwer MLX działa:
   ```bash
   curl http://localhost:8080/v1/models
   ```

2. Sprawdź poprawny port w konfiguracji

### Model pobiera się zbyt długo

Pierwsze uruchomienie pobiera model (~4-8GB). To normalne. Kolejne uruchomienia będą natychmiastowe.

### Za mało pamięci

Użyj mniejszego modelu:
```bash
mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit
```

## Porównanie z Claude

| Aspekt | MLX | Claude |
|--------|-----|--------|
| Koszt | 💰 Darmowy | 💰💰💰 ~$0.003/1K tokens |
| Jakość odpowiedzi | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ |
| Szybkość | ⚡⚡⚡⚡⚡ | ⚡⚡⚡⚡ |
| Prywatność | 🔒 100% lokalne | ☁️ Cloud |
| Offline | ✅ Tak | ❌ Nie |
| Setup | 🔧 Wymaga instalacji | 🔑 Tylko klucz API |

## Najlepsze praktyki

1. **Wybór modelu**: Zacznij od 3B dla testów, potem skaluj w górę
2. **Temperature**: 0.7 dla kreatywnych odpowiedzi, 0.3 dla precyzyjnych
3. **Max tokens**: 4096 to dobry balans (więcej = wolniej)
4. **Rundy**: 2 rundy wystarczą dla większości zadań

## Dodatkowe zasoby

- [MLX Documentation](https://ml-explore.github.io/mlx/)
- [MLX Community Models](https://huggingface.co/mlx-community)
- [Apple ML Research](https://machinelearning.apple.com/)

## Wsparcie

W razie problemów:
1. Sprawdź logi serwera MLX
2. Upewnij się, że masz najnowszą wersję MLX
3. Zgłoś issue na GitHub projektu bielik-m-poc
