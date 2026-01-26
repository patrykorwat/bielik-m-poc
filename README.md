# 🤖 System Agentów Matematycznych Bielik-M

System wykorzystujący dwa agenty AI współpracujące w trybie group chat orchestration do rozwiązywania zadań matematycznych.

## 📋 Opis

Bielik-M to aplikacja demonstrująca współpracę dwóch wyspecjalizowanych agentów AI:

- **🔍 Analizator** - Analizuje problemy matematyczne, rozbija je na kroki i tworzy strategię rozwiązania
- **🔢 Kalkulator** - Wykonuje obliczenia krok po kroku i weryfikuje wyniki

Agenty wymieniają się informacjami w grupowym czacie, współpracując nad kompletnymi rozwiązaniami matematycznymi.

## ✨ Funkcje

- **Group Chat Orchestration** - Orkiestracja konwersacji między wieloma agentami
- **Brak Chain of Thoughts** - Agenty komunikują się bezpośrednio bez wewnętrznych rozważań
- **Polski interfejs użytkownika** - Kompletnie spolszczony UI
- **Konfigurowalność** - Możliwość ustawienia liczby rund konwersacji
- **Historia konwersacji** - Pełna historia interakcji z agentami
- **Obsługa streamu** - Wiadomości pojawiają się na bieżąco

## 🚀 Szybki start

### Wymagania

- Node.js 18+ lub nowszy
- Klucz API Anthropic

### Instalacja

```bash
# Sklonuj repozytorium
git clone https://github.com/yourusername/bielik-m.git
cd bielik-m

# Zainstaluj zależności
npm install

# Uruchom aplikację w trybie deweloperskim
npm run dev
```

### Konfiguracja

1. Otwórz aplikację w przeglądarce (domyślnie `http://localhost:5173`)
2. Wprowadź swój klucz API Anthropic
3. Kliknij "Rozpocznij"

### Uzyskiwanie klucza API

1. Odwiedź [console.anthropic.com](https://console.anthropic.com/)
2. Zarejestruj się lub zaloguj
3. Przejdź do sekcji API Keys
4. Wygeneruj nowy klucz API

## 💻 Użycie

### Przykładowe pytania

```
Rozwiąż równanie kwadratowe: 2x² + 5x - 3 = 0
```

```
Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1
```

```
Jakie jest pole koła o promieniu 7 cm?
```

```
Rozwiąż układ równań:
2x + y = 5
x - y = 1
```

### Konfiguracja rund konwersacji

Możesz ustawić liczbę rund (1-5), w których agenty będą wymieniać informacje:

- **1 runda** - Szybka odpowiedź, każdy agent odpowiada raz
- **2 rundy** (domyślnie) - Dobra równowaga między jakością a czasem
- **3+ rundy** - Głębsza analiza dla złożonych problemów

## 🏗️ Architektura

### Struktura projektu

```
bielik-m/
├── src/
│   ├── services/
│   │   └── agentService.ts      # Logika orkiestracji agentów
│   ├── App.tsx                  # Główny komponent UI
│   ├── App.css                  # Style aplikacji
│   ├── main.tsx                 # Punkt wejścia
│   └── vite-env.d.ts           # Typy TypeScript
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

### Komponenty systemu

#### GroupChatOrchestrator

Główna klasa zarządzająca konwersacją między agentami:

```typescript
// Tworzenie orchestratora
const agents = createMathAgents();
const orchestrator = new GroupChatOrchestrator(apiKey, agents);

// Rozpoczęcie konwersacji
await orchestrator.orchestrateConversation(
  "Rozwiąż równanie: x² - 5x + 6 = 0",
  rounds: 2,
  onMessageCallback: (message) => console.log(message)
);
```

#### Agenci matematyczni

Dwaj wyspecjalizowani agenci:

```typescript
const agents = createMathAgents();
// agents[0] - Analizator (analiza problemów)
// agents[1] - Kalkulator (wykonywanie obliczeń)
```

### Przepływ danych

```
Użytkownik → Wiadomość
    ↓
GroupChatOrchestrator
    ↓
Analizator (runda 1) → Strategia rozwiązania
    ↓
Kalkulator (runda 1) → Pierwsze obliczenia
    ↓
Analizator (runda 2) → Weryfikacja/doprecyzowanie
    ↓
Kalkulator (runda 2) → Finalne wyniki
    ↓
UI ← Kompletne rozwiązanie
```

## 🛠️ Technologie

- **React 18** - Biblioteka UI
- **TypeScript** - Typy statyczne
- **Vite** - Bundler i dev server
- **Anthropic SDK** - Integracja z Claude AI
- **CSS3** - Stylowanie (gradientowe, responsywne)

## 📦 Skrypty

```bash
# Tryb deweloperski z hot reload
npm run dev

# Build produkcyjny
npm run build

# Podgląd buildu produkcyjnego
npm run preview

# Linting
npm run lint
```

## 🔒 Bezpieczeństwo

- Klucz API jest przechowywany tylko w pamięci przeglądarki
- Komunikacja odbywa się bezpośrednio z API Anthropic (HTTPS)
- Brak przechowywania danych na serwerze
- Opcja `dangerouslyAllowBrowser: true` włączona dla demo (w produkcji użyj backendu)

## 🚨 Ważne uwagi

⚠️ **Uwaga bezpieczeństwa**: Aplikacja używa `dangerouslyAllowBrowser: true` do celów demonstracyjnych. W środowisku produkcyjnym klucz API powinien być przechowywany na backendzie, a komunikacja z Anthropic powinna odbywać się przez serwer proxy.

## 🤝 Wkład w rozwój

Zachęcamy do zgłaszania issues i pull requestów!

## 📄 Licencja

MIT

## 👨‍💻 Autor

Projekt stworzony jako demonstracja group chat orchestration z agentami AI.

---

**Zbudowano z wykorzystaniem Claude 3.5 Sonnet i React**
