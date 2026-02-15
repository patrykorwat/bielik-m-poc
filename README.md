# 🤖 System Trzech Agentów (Bielik-M)

Zaawansowany system trzech inteligentnych agentów AI z dostępem do narzędzi matematycznych SymPy oraz inteligentną weryfikacją dowodów, umożliwiający zarówno obliczenia symboliczne jak i formalne weryfikacje matematyczne.

## 📋 Opis

![math-simple](math-simple.png)

Bielik-M to aplikacja demonstrująca integrację trzech agentów AI (Claude lub MLX) z Model Context Protocol (MCP), narzędziami SymPy oraz Lean Prover:

- **🧠 Agent Analityczny** - Analizuje problemy matematyczne i rozbija je na kroki rozwiązania
- **⚡ Agent Wykonawczy** - Wykonuje obliczenia SymPy lub tworzy formalne dowody krok po kroku
- **🎯 Agent Weryfikujący** - Weryfikuje poprawność dowodów za pomocą Lean Prover (profesjonalny theorem prover)
- **🔧 MCP + SymPy** - 9 narzędzi do symbolicznych obliczeń matematycznych
- **🎯 Lean Prover** - Formalna weryfikacja dowodów matematycznych
- **📐 LaTeX Rendering** - Pięknie sformatowane wzory matematyczne w interfejsie użytkownika

System automatycznie wykrywa czy zadanie wymaga obliczeń numerycznych (SymPy) czy formalnego dowodu (Lean Prover), wybiera odpowiednie narzędzia i prezentuje wyniki w czytelny sposób.

## ✨ Funkcje

### 🎯 Główne funkcje

- **🧠 System Trzech Agentów** - Analityczny → Wykonawczy → Weryfikujący
- **🔍 Inteligentne wykrywanie** - Automatyczny wybór między obliczeniami (SymPy) a dowodem formalnym (Lean)
- **✅ Weryfikacja dowodów** - Agent Weryfikujący używa Lean Prover do formalnej weryfikacji matematycznej
- **🔄 Elastyczny Backend** - Możliwość wyboru: tylko SymPy, tylko Lean Prover, lub oba

### Pozostałe funkcje

- **🔧 9 Narzędzi SymPy** - Pełny zestaw narzędzi do symbolicznych obliczeń matematycznych
- **🤖 MCP Integration** - Integracja z Model Context Protocol dla standardowego interfejsu narzędzi
- **📐 LaTeX Rendering** - Automatyczne renderowanie wzorów matematycznych z KaTeX
- **🎯 Automatyczne wykrywanie zmiennych** - Wszystkie symbole w wyrażeniach są automatycznie definiowane
- **💬 Multi-Provider** - Wybór między Claude (cloud) a MLX (lokalny)
- **🇵🇱 Polski interfejs** - Kompletnie spolszczony UI
- **📜 Historia konwersacji** - Zapisywanie i wczytywanie poprzednich sesji
- **🔄 Wyświetlanie wyników narzędzi** - Przejrzyste pokazywanie wywołań i wyników narzędzi

## 🚀 Szybki start

### ⚡ Quick Start (TL;DR)

**Linux/macOS:**
```bash
git clone https://github.com/yourusername/bielik-m-poc.git
cd bielik-m-poc
./setup.sh    # Instalacja wszystkiego
./start.sh    # Uruchomienie aplikacji
```

**Windows:**
```cmd
git clone https://github.com/yourusername/bielik-m-poc.git
cd bielik-m-poc
setup.bat     # Instalacja wszystkiego
start.bat     # Uruchomienie aplikacji
```

Otwórz [http://localhost:5173](http://localhost:5173) i ciesz się!

---

### Wymagania

- Node.js 18+ lub nowszy
- Python 3.8+ (dla serwera MCP SymPy)
- **Dla Claude**: Klucz API Anthropic
- **Dla MLX**: Mac z Apple Silicon (M1/M2/M3/M4) i uruchomiony serwer MLX

### Instalacja

#### 🚀 Metoda 1: Automatyczna instalacja (REKOMENDOWANA)

**Linux/macOS:**
```bash
# Sklonuj repozytorium
git clone https://github.com/yourusername/bielik-m-poc.git
cd bielik-m-poc

# Uruchom skrypt instalacyjny
chmod +x setup.sh
./setup.sh
```

**Windows:**
```cmd
REM Sklonuj repozytorium
git clone https://github.com/yourusername/bielik-m-poc.git
cd bielik-m-poc

REM Uruchom skrypt instalacyjny
setup.bat
```

Skrypt automatycznie:
- ✅ Sprawdzi wymagane zależności (Node.js, Python)
- ✅ Zainstaluje zależności Node.js
- ✅ Skonfiguruje środowisko Python z SymPy
- ✅ Zbuduje MCP server

#### 📦 Metoda 2: Instalacja manualna

```bash
# Sklonuj repozytorium
git clone https://github.com/yourusername/bielik-m-poc.git
cd bielik-m-poc

# Zainstaluj zależności głównej aplikacji
npm install

# Zainstaluj zależności MCP SymPy server
cd mcp-sympy-server
npm install

# Zainstaluj Python dependencies dla SymPy
python3 -m venv venv
source venv/bin/activate  # Na Windows: venv\Scripts\activate
pip install sympy

# Zbuduj MCP server
npm run build
cd ..
```

### Uruchomienie aplikacji

#### 🚀 Metoda 1: Automatyczne uruchomienie (REKOMENDOWANA)

**Linux/macOS:**
```bash
# Uruchom wszystkie serwery jednym poleceniem
./start.sh
```

**Windows:**
```cmd
REM Uruchom wszystkie serwery
start.bat
```

Skrypt automatycznie:
- ✅ Sprawdzi wszystkie wymagania
- ✅ Wykryje konflikty portów i zaproponuje rozwiązanie
- ✅ Uruchomi MCP Proxy (SymPy) - port 3001
- ✅ Uruchomi aplikację webową - port 5173
- ✅ Otworzy przeglądarkę automatycznie
- ✅ Zapisze logi do katalogu `logs/`

**Zatrzymanie:**
- **Linux/macOS:** Naciśnij `Ctrl+C` w terminalu
- **Windows:** Zamknij okna serwerów

#### 📦 Metoda 2: Uruchomienie manualne

**WAŻNE:** Aplikacja wymaga uruchomienia **dwóch serwerów**:
1. **MCP proxy** (port 3001) - dla narzędzi SymPy
2. **Aplikacja webowa** (port 5173) - frontend React

##### Krok 1: Uruchom MCP Proxy Server

W osobnym terminalu:

```bash
# Z głównego katalogu projektu
npm run mcp-proxy
```

Ten serwer:
- Uruchamia się na porcie **3001**
- Łączy się z MCP SymPy serverem
- Udostępnia 9 narzędzi matematycznych
- **MUSI działać** aby aplikacja mogła używać narzędzi SymPy

Powinieneś zobaczyć:
```
MCP Proxy Server running on http://localhost:3001
Available tools: [
  'sympy_calculate',
  'sympy_simplify',
  'sympy_solve',
  'sympy_differentiate',
  'sympy_integrate',
  'sympy_expand',
  'sympy_factor',
  'sympy_limit',
  'sympy_matrix'
]
```

##### Krok 2: Uruchom aplikację webową

W drugim terminalu:

```bash
# Z głównego katalogu projektu
npm run dev
```

Aplikacja uruchomi się na `http://localhost:5173`

**Alternatywnie - uruchom wszystko na raz:**

```bash
# Zainstaluj concurrently (jeśli nie zainstalowane)
npm install

# Uruchom wszystkie serwery jednocześnie
npm run start:all
```

#### Konfiguracja w UI

##### Opcja A: Claude (Cloud)

1. Otwórz aplikację w przeglądarce
2. Wybierz provider "Claude (Anthropic)"
3. Wybierz backend dowodzenia:
   - **Oba (SymPy + Weryfikacja)** - rekomendowane, automatyczny wybór
   - **Tylko SymPy** - tylko obliczenia numeryczne/symboliczne
   - **Tylko weryfikacja formalna** - tylko dowody logiczne (bez obliczeń)
4. Wprowadź swój klucz API Anthropic
5. Upewnij się że widzisz status "**🔌 SymPy**"
6. Kliknij "Rozpocznij"

**Uzyskiwanie klucza API:**
1. Odwiedź [console.anthropic.com](https://console.anthropic.com/)
2. Zarejestruj się lub zaloguj
3. Przejdź do sekcji API Keys
4. Wygeneruj nowy klucz API

##### Opcja B: MLX (Lokalny - Apple Silicon)

1. Zainstaluj MLX:
   ```bash
   # Opcja 1: Homebrew (zalecane dla macOS)
   brew install mlx-lm

   # Opcja 2: pip
   pip install mlx mlx-lm
   ```

2. Uruchom serwer MLX:
   ```bash
   mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit

   # Lub na innym porcie:
   mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8011
   ```

3. W aplikacji:
   - Wybierz provider "MLX (Apple Silicon - lokalny)"
   - Wprowadź URL serwera (domyślnie `http://localhost:8011`)
   - Wprowadź nazwę modelu (domyślnie `LibraxisAI/Bielik-11B-v3.0-mlx-q5`)
   - Upewnij się że widzisz status "**MCP Connected**" (zielony)
   - Kliknij "Rozpocznij"

**Wymagania MLX:**
- Mac z Apple Silicon (M1/M2/M3/M4)
- macOS 14.0 lub wyższy
- Darmowy, lokalny inference bez kosztów API
- Akceleracja sprzętowa za pomocą Neural Engine

### ⚠️ Rozwiązywanie problemów

#### MCP nie jest połączony

Jeśli nie widzisz statusu "🔌 SymPy":

1. **Sprawdź czy MCP proxy działa:**
   ```bash
   curl http://localhost:3001/health
   ```
   Powinno zwrócić: `{"status":"ok","mcpConnected":true,"toolsCount":9}`

2. **Jeśli MCP proxy nie działa, uruchom go:**
   ```bash
   npm run mcp-proxy
   ```

3. **Sprawdź czy port 3001 nie jest zajęty:**
   ```bash
   lsof -i :3001
   ```

4. **Odśwież aplikację w przeglądarce** po uruchomieniu MCP proxy

#### Błędy narzędzi SymPy

Jeśli narzędzia zwracają błędy typu "name 'X' is not defined":

1. **Sprawdź czy Python i SymPy są zainstalowane:**
   ```bash
   cd mcp-sympy-server
   source venv/bin/activate
   python -c "import sympy; print(sympy.__version__)"
   ```

2. **Przebuduj MCP server:**
   ```bash
   cd mcp-sympy-server
   npm run build
   cd ..
   ```

3. **Zrestartuj MCP proxy** (zatrzymaj i uruchom ponownie `npm run mcp-proxy`)

## 💻 Użycie

### Inteligentny wybór backendu

System automatycznie wykrywa typ zadania:

**Zadania wymagające formalnego dowodu (Lean Prover):**
- Zawierają słowa kluczowe: "udowodnij", "wykaż", "dowód", "twierdzenie", "indukcja", "dla każdego"
- Wymagają logicznego rozumowania i formalnej weryfikacji
- Agent Weryfikujący używa Lean Prover do weryfikacji poprawności matematycznej

**Zadania obliczeniowe (SymPy):**
- Obliczenia numeryczne i symboliczne
- Rozwiązywanie równań, pochodne, całki
- Upraszczanie wyrażeń

### 🎯 Lean Prover - Formalna weryfikacja dowodów

Lean Prover to profesjonalny interactive theorem prover używany w:
- Badaniach matematycznych (np. Liquid Tensor Experiment)
- Weryfikacji formalnej oprogramowania
- Nauczaniu matematyki i logiki

**Korzyści z integracji Lean:**
- ✅ Formalna weryfikacja matematyczna - Lean gwarantuje poprawność dowodów
- 🔬 Używany w badaniach - zaufany przez matematyków na całym świecie
- 📚 Bogata biblioteka Mathlib - tysiące zweryfikowanych twierdzeń
- 🎓 Edukacja - uczenie się formalnego rozumowania matematycznego

**Instalacja Lean:**

macOS (via Homebrew):
```bash
brew install elan-init
elan default leanprover/lean4:stable
```

Linux:
```bash
curl https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -sSf | sh
elan default leanprover/lean4:stable
```

Windows:
- Download from: https://github.com/leanprover/lean4/releases
- Or use elan: https://github.com/leanprover/elan

**Weryfikacja instalacji:**
```bash
lean --version
```

**Uruchomienie z Lean:**
```bash
# Uruchom wszystkie serwery (MCP + Lean + frontend)
./start.sh          # Linux/macOS
start.bat           # Windows

# Lub ręcznie:
npm run start:all   # Wszystko jednocześnie
# Lub osobno:
npm run lean-proxy  # Lean Proxy na porcie 3002
npm run mcp-proxy   # SymPy Proxy na porcie 3001
npm run dev         # Frontend na porcie 5173
```

### Dostępne narzędzia SymPy

Agent ma dostęp do 9 narzędzi matematycznych:

1. **sympy_calculate** - Dowolne obliczenia SymPy (również wieloliniowe skrypty)
2. **sympy_solve** - Rozwiązywanie równań i układów równań
3. **sympy_differentiate** - Obliczanie pochodnych
4. **sympy_integrate** - Całkowanie (oznaczone i nieoznaczone)
5. **sympy_simplify** - Upraszczanie wyrażeń
6. **sympy_expand** - Rozwijanie wyrażeń
7. **sympy_factor** - Faktoryzacja
8. **sympy_limit** - Obliczanie granic
9. **sympy_matrix** - Operacje na macierzach

### Przykładowe pytania

**Obliczenia (SymPy):**
```
Rozwiąż równanie kwadratowe: 2x² + 5x - 3 = 0
Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1
Oblicz całkę z sin(x)*cos(x)
Uprość wyrażenie: (x+1)² - (x-1)²
Zfaktoryzuj: x² - 9
Oblicz granicę lim(x→0) sin(x)/x
Oblicz pochodną 3*a²*(R - a)/(2*R) względem a
```

**Formalne dowody (weryfikacja logiczna):**
```
Udowodnij, że dla każdej liczby naturalnej n, n + 0 = n
Wykaż własność przemienności dodawania: a + b = b + a
Dowód przez indukcję: suma pierwszych n liczb naturalnych wynosi n(n+1)/2
Udowodnij, że suma kątów w trójkącie wynosi 180 stopni
Wykaż, że jeśli a = b i b = c, to a = c (przechodniość równości)
```

**Uwaga:** System wspiera zarówno weryfikację przez agenta AI jak i przez Lean Prover - profesjonalny system dowodzenia twierdzeń matematycznych używany w badaniach akademickich.

### Cechy interfejsu

- **🔧 Wyświetlanie wywołań narzędzi** - Widoczne parametry każdego wywołania
- **✅ Wyniki narzędzi** - Przejrzyste pokazywanie wyników z SymPy
- **📐 LaTeX rendering** - Wzory matematyczne renderowane w czasie rzeczywistym
- **📜 Historia** - Zapisywanie i wczytywanie poprzednich sesji
- **⏱️ Znaczniki czasu** - Czas każdej wiadomości

## 🏗️ Architektura

### Struktura projektu

```
bielik-m-poc/
├── src/
│   ├── services/
│   │   ├── threeAgentSystem.ts           # System trzech agentów
│   │   ├── mcpClientBrowser.ts           # Klient MCP dla przeglądarki
│   │   ├── mlxAgent.ts                   # Implementacja MLX agenta
│   │   ├── leanProverService.ts          # Lean Prover (Node.js)
│   │   ├── leanProverService.browser.ts  # Lean Prover (przeglądarka)
│   │   └── chatHistoryService.ts         # Zarządzanie historią
│   ├── components/
│   │   ├── MessageContent.tsx       # Renderowanie LaTeX
│   │   └── ChatHistorySidebar.tsx   # Sidebar z historią
│   ├── App.tsx                      # Główny komponent UI
│   ├── App.css                      # Style aplikacji
│   └── main.tsx                     # Punkt wejścia
├── mcp-sympy-server/               # MCP Server dla SymPy
│   ├── src/
│   │   └── index.ts                # Implementacja narzędzi SymPy
│   ├── dist/                       # Zbudowany serwer
│   ├── venv/                       # Python virtual environment
│   └── package.json
├── mcp-proxy-server.js             # HTTP proxy dla MCP (SymPy)
├── lean-proxy-server.js            # HTTP proxy dla Lean Prover
├── start.sh / start.bat            # Skrypty uruchamiające
├── setup.sh / setup.bat            # Skrypty instalacyjne
├── index.html
├── package.json
└── vite.config.ts
```

### Komponenty systemu

#### ThreeAgentOrchestrator

Główna klasa zarządzająca systemem trzech agentów AI z dostępem do narzędzi MCP i Lean Prover:

```typescript
// Tworzenie orchestratora z Claude i oboma backendami
const orchestrator = new ThreeAgentOrchestrator(
  'claude',
  'both',  // 'sympy' | 'lean' | 'both'
  apiKey
);

// Lub z MLX
const orchestrator = new ThreeAgentOrchestrator(
  'mlx',
  'both',
  undefined,
  {
    baseUrl: 'http://localhost:8011',
    model: 'LibraxisAI/Bielik-11B-v3.0-mlx-q5',
    temperature: 0.7,
    maxTokens: 4096
  }
);

// Połącz z MCP (SymPy)
await orchestrator.connectMCP('http://localhost:3001');

// Połącz z Lean Prover
await orchestrator.connectLean('http://localhost:3002');

// Przetwarzaj wiadomości - system wybierze odpowiedni backend
await orchestrator.processMessage(
  "Udowodnij, że suma kątów w trójkącie wynosi 180 stopni",
  (message) => console.log(message)
);
```

#### MCP Proxy Server

HTTP proxy który umożliwia przeglądarce komunikację z MCP serverem:

- **Port:** 3001
- **Endpoints:**
  - `GET /health` - Status połączenia
  - `GET /tools` - Lista dostępnych narzędzi
  - `POST /tools/call` - Wywołanie narzędzia
- **Komunikacja:** HTTP/JSON ↔ stdio (MCP server)

#### MCP SymPy Server

Serwer MCP implementujący narzędzia SymPy:

- **Technologia:** TypeScript + Python
- **Narzędzi:** 9 (solve, differentiate, integrate, etc.)
- **Automatyczne wykrywanie symboli:** Wszystkie zmienne w wyrażeniach są automatycznie definiowane

#### Lean Proxy Server

HTTP proxy umożliwiający komunikację przeglądarki z Lean Prover:

- **Port:** 3002
- **Endpoints:**
  - `GET /health` - Sprawdza czy Lean jest zainstalowany
  - `POST /verify` - Weryfikuje kod Lean
  - `POST /prove` - Generuje i weryfikuje theorem z opisu problemu
  - `GET /workspace` - Lista plików w workspace
  - `GET /install` - Instrukcje instalacji Lean
- **Komunikacja:** HTTP/JSON ↔ Lean CLI
- **Workspace:** Tymczasowy katalog dla plików `.lean`

### Przepływ danych

**Dla obliczeń (SymPy):**
```
Użytkownik → Wiadomość
    ↓
ThreeAgentOrchestrator
    ↓
Agent Analityczny → Rozbicie problemu
    ↓
Agent Wykonawczy → Kod Python/SymPy
    ↓
MCP Client (browser) → HTTP Request
    ↓
MCP Proxy Server (port 3001)
    ↓
MCP SymPy Server (stdio)
    ↓
Python + SymPy → Obliczenia
    ↓
Wynik ← MCP Proxy ← MCP Client
    ↓
Agent Weryfikujący → Analiza wyniku
    ↓
UI ← Sformatowana odpowiedź z LaTeX
```

**Dla formalnych dowodów (Lean):**
```
Użytkownik → Wiadomość ("udowodnij...")
    ↓
ThreeAgentOrchestrator → wykrywa potrzebę dowodu
    ↓
Agent Analityczny → Rozbicie problemu
    ↓
Agent Wykonawczy → Dowód krok po kroku
    ↓
Agent Weryfikujący → Weryfikacja z Lean
    ↓
Lean Prover Service (browser) → HTTP Request
    ↓
Lean Proxy Server (port 3002)
    ↓
Lean CLI → Weryfikacja formalna
    ↓
Wynik (verified/errors) ← Lean Proxy
    ↓
Agent Weryfikujący → Analiza wyniku Lean
    ↓
UI ← Raport weryfikacji + dowód
```

## 🛠️ Technologie

### Frontend
- **React 18** - Biblioteka UI
- **TypeScript** - Typy statyczne
- **Vite** - Bundler i dev server
- **KaTeX** - Renderowanie LaTeX
- **CSS3** - Stylowanie (gradientowe, responsywne)

### Backend / Narzędzia
- **Model Context Protocol (MCP)** - Standardowy interfejs dla narzędzi AI
- **SymPy** - Biblioteka Python do symbolicznych obliczeń matematycznych
- **Node.js** - Runtime dla MCP proxy i serwera
- **Express** - HTTP server dla MCP proxy

### AI Providers
- **Anthropic SDK** - Integracja z Claude AI (Claude Haiku 4.5)
- **MLX** - Apple Silicon optimized inference (opcjonalne)

### Porównanie providerów

| Feature | Claude | MLX |
|---------|--------|-----|
| **Koszt** | Płatny (API) | Darmowy (lokalny) |
| **Jakość** | Bardzo wysoka | Dobra |
| **Szybkość** | Szybka | Bardzo szybka (z akceleracją) |
| **Prywatność** | Cloud | 100% lokalny |
| **Wymagania** | Klucz API | Apple Silicon Mac |
| **Offline** | ❌ | ✅ |

## 📦 Skrypty

### Aplikacja główna

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

### Proxy Serwery

```bash
# Uruchom MCP proxy server (port 3001) - SymPy
npm run mcp-proxy

# Uruchom Lean proxy server (port 3002) - Lean Prover
npm run lean-proxy

# Uruchom oba proxy serwery
npm run start:proxies

# Uruchom wszystko (dev + oba proxy)
npm run start:all
```

### MCP SymPy Server

```bash
cd mcp-sympy-server

# Zbuduj serwer TypeScript
npm run build

# Uruchom serwer bezpośrednio (dla testów)
node dist/index.js
```

## 🔒 Bezpieczeństwo

- Klucz API jest przechowywany tylko w pamięci przeglądarki
- Komunikacja odbywa się bezpośrednio z API Anthropic (HTTPS)
- Brak przechowywania danych na serwerze
- Opcja `dangerouslyAllowBrowser: true` włączona dla demo (w produkcji użyj backendu)

## 🚨 Ważne uwagi

⚠️ **Uwaga bezpieczeństwa**: Aplikacja używa `dangerouslyAllowBrowser: true` do celów demonstracyjnych. W środowisku produkcyjnym klucz API powinien być przechowywany na backendzie, a komunikacja z Anthropic powinna odbywać się przez serwer proxy.

## 📚 Dodatkowa dokumentacja

- [MLX_GUIDE.md](MLX_GUIDE.md) - Kompletny przewodnik po MLX
- [EXAMPLES.md](EXAMPLES.md) - Przykłady użycia z MLX i Claude

## 🤝 Wkład w rozwój

Zachęcamy do zgłaszania issues i pull requestów!

## 🎯 Kluczowe osiągnięcia

✅ **System Trzech Agentów** - Analityczny → Wykonawczy → Weryfikujący
✅ **Lean Prover Integration** - Formalna weryfikacja matematyczna z profesjonalnym theorem prover
✅ **Inteligentne wykrywanie** - Automatyczny wybór między SymPy a Lean Prover
✅ **Elastyczny Backend** - SymPy dla obliczeń, Lean Prover dla formalnych dowodów, lub oba
✅ **Integracja MCP** - Standardowy protokół dla narzędzi AI
✅ **9 narzędzi SymPy** - Pełny zestaw do symbolicznych obliczeń matematycznych
✅ **Automatyczne wykrywanie symboli** - Brak potrzeby manualnego definiowania zmiennych
✅ **LaTeX rendering** - Piękne wzory matematyczne w czasie rzeczywistym
✅ **Multi-provider** - Claude (cloud) lub MLX (lokalny)
✅ **Historia konwersacji** - Zapisywanie i wczytywanie sesji
✅ **Przejrzysty UI** - Widoczne wywołania i wyniki narzędzi
✅ **Dual Proxy Architecture** - Osobne serwery proxy dla SymPy i Lean

## 📄 Licencja

MIT

## 👨‍💻 Autor

Projekt stworzony jako demonstracja integracji AI agents z Model Context Protocol i narzędziami SymPy.

---

**Wskazówka:** Pamiętaj aby uruchomić **MCP proxy server** (`npm run mcp-proxy`) i **aplikację** (`npm run dev`) przed rozpoczęciem pracy!
