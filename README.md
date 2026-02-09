# 🤖 Agent Matematyczny z SymPy (Bielik-M)

Inteligentny agent AI z dostępem do narzędzi matematycznych SymPy, umożliwiający rozwiązywanie zaawansowanych problemów matematycznych.

## 📋 Opis

![math-simple](math-simple.png)

Bielik-M to aplikacja demonstrująca integrację agenta AI (Claude lub MLX) z Model Context Protocol (MCP) i narzędziami SymPy:

- **🤖 Agent Matematyczny** - Inteligentny agent AI który analizuje problemy matematyczne i używa odpowiednich narzędzi
- **🔧 MCP + SymPy** - 9 narzędzi do symbolicznych obliczeń matematycznych (rozwiązywanie równań, pochodne, całki, upraszczanie, itp.)
- **📐 LaTeX Rendering** - Pięknie sformatowane wzory matematyczne w interfejsie użytkownika

Agent automatycznie wybiera odpowiednie narzędzia SymPy, wykonuje obliczenia i prezentuje wyniki w czytelny sposób.

## ✨ Funkcje

- **🔧 9 Narzędzi SymPy** - Pełny zestaw narzędzi do symbolicznych obliczeń matematycznych
- **🤖 MCP Integration** - Integracja z Model Context Protocol dla standardowego interfejsu narzędzi
- **📐 LaTeX Rendering** - Automatyczne renderowanie wzorów matematycznych z KaTeX
- **🎯 Automatyczne wykrywanie zmiennych** - Wszystkie symbole w wyrażeniach są automatycznie definiowane
- **💬 Multi-Provider** - Wybór między Claude (cloud) a MLX (lokalny)
- **🇵🇱 Polski interfejs** - Kompletnie spolszczony UI
- **📜 Historia konwersacji** - Zapisywanie i wczytywanie poprzednich sesji
- **🔄 Wyświetlanie wyników narzędzi** - Przejrzyste pokazywanie wywołań i wyników narzędzi

## 🚀 Szybki start

### Wymagania

- Node.js 18+ lub nowszy
- Python 3.8+ (dla serwera MCP SymPy)
- **Dla Claude**: Klucz API Anthropic
- **Dla MLX**: Mac z Apple Silicon (M1/M2/M3/M4) i uruchomiony serwer MLX

### Instalacja

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

**WAŻNE:** Aplikacja wymaga uruchomienia **dwóch serwerów** - MCP proxy (dla narzędzi SymPy) i aplikacji webowej.

#### Krok 1: Uruchom MCP Proxy Server

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

#### Krok 2: Uruchom aplikację webową

W drugim terminalu:

```bash
# Z głównego katalogu projektu
npm run dev
```

Aplikacja uruchomi się na `http://localhost:5173`

#### Krok 3: Konfiguracja w UI

##### Opcja A: Claude (Cloud)

1. Otwórz aplikację w przeglądarce
2. Wybierz provider "Claude (Anthropic)"
3. Wprowadź swój klucz API Anthropic
4. Upewnij się że widzisz status "**MCP Connected**" (zielony)
5. Kliknij "Rozpocznij"

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
   mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8080
   ```

3. W aplikacji:
   - Wybierz provider "MLX (Apple Silicon - lokalny)"
   - Wprowadź URL serwera (domyślnie `http://localhost:8011`)
   - Wprowadź nazwę modelu (domyślnie `LibraxisAI/Bielik-11B-v3.0-mlx-q4`)
   - Upewnij się że widzisz status "**MCP Connected**" (zielony)
   - Kliknij "Rozpocznij"

**Wymagania MLX:**
- Mac z Apple Silicon (M1/M2/M3/M4)
- macOS 14.0 lub wyższy
- Darmowy, lokalny inference bez kosztów API
- Akceleracja sprzętowa za pomocą Neural Engine

### ⚠️ Rozwiązywanie problemów

#### MCP nie jest połączony (czerwony status)

Jeśli widzisz komunikat "MCP Disconnected" (czerwony):

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

**Rozwiązywanie równań:**
```
Rozwiąż równanie kwadratowe: 2x² + 5x - 3 = 0
```

**Pochodne:**
```
Oblicz pochodną funkcji f(x) = x³ + 2x² - 5x + 1
```

**Całki:**
```
Oblicz całkę z sin(x)*cos(x)
```

**Upraszczanie:**
```
Uprość wyrażenie: (x+1)² - (x-1)²
```

**Faktoryzacja:**
```
Zfaktoryzuj: x² - 9
```

**Granice:**
```
Oblicz granicę lim(x→0) sin(x)/x
```

**Wyrażenia z wieloma zmiennymi:**
```
Oblicz pochodną 3*a²*(R - a)/(2*R) względem a
```

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
│   │   ├── mcpAgentService.ts       # Orkiestracja agenta z MCP
│   │   ├── mcpClientBrowser.ts      # Klient MCP dla przeglądarki
│   │   ├── mlxAgent.ts              # Implementacja MLX agenta
│   │   └── chatHistoryService.ts    # Zarządzanie historią
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
├── mcp-proxy-server.js             # HTTP proxy dla MCP
├── index.html
├── package.json
└── vite.config.ts
```

### Komponenty systemu

#### MCPAgentOrchestrator

Główna klasa zarządzająca agentem AI z dostępem do narzędzi MCP:

```typescript
// Tworzenie orchestratora z Claude
const orchestrator = new MCPAgentOrchestrator(
  'claude',
  apiKey
);

// Lub z MLX
const orchestrator = new MCPAgentOrchestrator(
  'mlx',
  undefined,
  {
    baseUrl: 'http://localhost:8011',
    model: 'LibraxisAI/Bielik-11B-v3.0-mlx-q4',
    temperature: 0.7,
    maxTokens: 4096
  }
);

// Połącz z MCP
await orchestrator.connectMCP('http://localhost:3001');

// Przetwarzaj wiadomości
await orchestrator.processMessage(
  "Rozwiąż równanie: x² - 5x + 6 = 0",
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

### Przepływ danych

```
Użytkownik → Wiadomość
    ↓
MCPAgentOrchestrator
    ↓
Agent AI (Claude/MLX)
    ↓
[Decyzja o użyciu narzędzia]
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
Agent AI → Analiza wyniku
    ↓
UI ← Sformatowana odpowiedź z LaTeX
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

### MCP Proxy

```bash
# Uruchom MCP proxy server (port 3001)
npm run mcp-proxy
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

✅ **Integracja MCP** - Standardowy protokół dla narzędzi AI
✅ **9 narzędzi SymPy** - Pełny zestaw do symbolicznych obliczeń matematycznych
✅ **Automatyczne wykrywanie symboli** - Brak potrzeby manualnego definiowania zmiennych
✅ **LaTeX rendering** - Piękne wzory matematyczne w czasie rzeczywistym
✅ **Multi-provider** - Claude (cloud) lub MLX (lokalny)
✅ **Historia konwersacji** - Zapisywanie i wczytywanie sesji
✅ **Przejrzysty UI** - Widoczne wywołania i wyniki narzędzi

## 📄 Licencja

MIT

## 👨‍💻 Autor

Projekt stworzony jako demonstracja integracji AI agents z Model Context Protocol i narzędziami SymPy.

---

**Wskazówka:** Pamiętaj aby uruchomić **oba serwery** (`npm run mcp-proxy` i `npm run dev`) przed rozpoczęciem pracy z aplikacją!
