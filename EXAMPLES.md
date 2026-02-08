# Przykłady użycia Bielik-M z MLX

## Przykład 1: Podstawowe użycie z Claude

```typescript
import { GroupChatOrchestrator, createMathAgents } from './src/services/agentService';

// Konfiguracja z Claude
const agents = createMathAgents();
const orchestrator = new GroupChatOrchestrator(
  'claude',
  agents,
  'sk-ant-your-api-key-here'
);

// Zadanie matematyczne
const result = await orchestrator.orchestrateConversation(
  "Oblicz pole trójkąta o podstawie 10cm i wysokości 6cm",
  2,
  (message) => {
    console.log(`[${message.agentName}]: ${message.content}`);
  }
);
```

## Przykład 2: Podstawowe użycie z MLX

```typescript
import { GroupChatOrchestrator, createMathAgents } from './src/services/agentService';

// Konfiguracja z MLX
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

// Zadanie matematyczne
const result = await orchestrator.orchestrateConversation(
  "Oblicz pole trójkąta o podstawie 10cm i wysokości 6cm",
  2,
  (message) => {
    console.log(`[${message.agentName}]: ${message.content}`);
  }
);
```

## Przykład 3: Różne modele MLX dla różnych zadań

```typescript
// Szybki model dla prostych obliczeń (3B)
const fastOrchestrator = new GroupChatOrchestrator(
  'mlx',
  agents,
  undefined,
  {
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    temperature: 0.3, // Niska temperatura dla precyzji
    maxTokens: 2048
  }
);

// Większy model dla złożonych problemów (11B - polski!)
const powerfulOrchestrator = new GroupChatOrchestrator(
  'mlx',
  agents,
  undefined,
  {
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Bielik-11B-v2.3-Instruct-4bit',
    temperature: 0.7,
    maxTokens: 4096
  }
);
```

## Przykład 4: Dynamiczne przełączanie między providerami

```typescript
type Provider = 'claude' | 'mlx';

async function solveWithProvider(
  provider: Provider,
  problem: string,
  claudeKey?: string
) {
  const agents = createMathAgents();

  const orchestrator = provider === 'claude'
    ? new GroupChatOrchestrator('claude', agents, claudeKey!)
    : new GroupChatOrchestrator('mlx', agents, undefined, {
        baseUrl: 'http://localhost:8080',
        model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
        temperature: 0.7,
        maxTokens: 4096
      });

  return await orchestrator.orchestrateConversation(problem, 2);
}

// Użycie
const claudeResult = await solveWithProvider(
  'claude',
  'Rozwiąż x² - 4 = 0',
  'sk-ant-key'
);

const mlxResult = await solveWithProvider(
  'mlx',
  'Rozwiąż x² - 4 = 0'
);
```

## Przykład 5: Obsługa błędów MLX

```typescript
import { GroupChatOrchestrator, createMathAgents } from './src/services/agentService';
import { MLXAgent } from './src/services/mlxAgent';

async function solveWithMLXFallback(problem: string) {
  const agents = createMathAgents();

  // Sprawdź dostępność MLX
  const mlxAgent = new MLXAgent({
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    temperature: 0.7,
    maxTokens: 4096
  });

  const isAvailable = await mlxAgent.isAvailable();

  if (!isAvailable) {
    console.warn('MLX server not available. Please start it with:');
    console.warn('mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit');
    return null;
  }

  // MLX jest dostępny, kontynuuj
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

  try {
    return await orchestrator.orchestrateConversation(problem, 2);
  } catch (error) {
    console.error('Error during conversation:', error);
    return null;
  }
}
```

## Przykład 6: Listowanie dostępnych modeli MLX

```typescript
import { MLXAgent } from './src/services/mlxAgent';

async function listMLXModels() {
  const mlxAgent = new MLXAgent({
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
  });

  const models = await mlxAgent.listModels();

  console.log('Available MLX models:');
  models.forEach(model => console.log(`  - ${model}`));

  return models;
}

// Użycie
const models = await listMLXModels();
```

## Przykład 7: Zmiana modelu w trakcie działania

```typescript
import { MLXAgent } from './src/services/mlxAgent';

const mlxAgent = new MLXAgent({
  baseUrl: 'http://localhost:8080',
  model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
  temperature: 0.7,
  maxTokens: 4096
});

console.log('Current model:', mlxAgent.getModel());

// Zmień na inny model
mlxAgent.setModel('mlx-community/Llama-3.2-7B-Instruct-4bit');

console.log('New model:', mlxAgent.getModel());
```

## Przykład 8: Różne temperatury dla różnych zadań

```typescript
// Niska temperatura (0.3) dla obliczeń matematycznych - precyzja
const preciseOrchestrator = new GroupChatOrchestrator(
  'mlx',
  agents,
  undefined,
  {
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    temperature: 0.3, // Deterministyczne odpowiedzi
    maxTokens: 2048
  }
);

// Wysoka temperatura (0.9) dla kreatywnych wyjaśnień - kreatywność
const creativeOrchestrator = new GroupChatOrchestrator(
  'mlx',
  agents,
  undefined,
  {
    baseUrl: 'http://localhost:8080',
    model: 'mlx-community/Llama-3.2-3B-Instruct-4bit',
    temperature: 0.9, // Bardziej kreatywne odpowiedzi
    maxTokens: 4096
  }
);
```

## Przykład 9: Benchmark - porównanie Claude vs MLX

```typescript
async function benchmarkProviders(problem: string) {
  const agents = createMathAgents();

  // Test Claude
  const claudeStart = Date.now();
  const claudeOrch = new GroupChatOrchestrator(
    'claude',
    agents,
    'sk-ant-key'
  );
  await claudeOrch.orchestrateConversation(problem, 2);
  const claudeTime = Date.now() - claudeStart;

  // Test MLX
  const mlxStart = Date.now();
  const mlxOrch = new GroupChatOrchestrator(
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
  await mlxOrch.orchestrateConversation(problem, 2);
  const mlxTime = Date.now() - mlxStart;

  console.log('Benchmark Results:');
  console.log(`Claude: ${claudeTime}ms`);
  console.log(`MLX: ${mlxTime}ms`);
  console.log(`MLX jest ${((claudeTime / mlxTime - 1) * 100).toFixed(1)}% szybszy`);
}
```

## Przykład 10: React Hook dla MLX

```typescript
import { useState, useEffect } from 'react';
import { MLXAgent } from './services/mlxAgent';

function useMLXAvailability(baseUrl = 'http://localhost:8080') {
  const [isAvailable, setIsAvailable] = useState(false);
  const [isChecking, setIsChecking] = useState(true);

  useEffect(() => {
    const checkAvailability = async () => {
      const agent = new MLXAgent({
        baseUrl,
        model: 'mlx-community/Llama-3.2-3B-Instruct-4bit'
      });

      const available = await agent.isAvailable();
      setIsAvailable(available);
      setIsChecking(false);
    };

    checkAvailability();
  }, [baseUrl]);

  return { isAvailable, isChecking };
}

// Użycie w komponencie React
function App() {
  const { isAvailable, isChecking } = useMLXAvailability();

  if (isChecking) {
    return <div>Sprawdzanie dostępności MLX...</div>;
  }

  if (!isAvailable) {
    return (
      <div>
        <h3>MLX server nie jest dostępny</h3>
        <p>Uruchom: mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit</p>
      </div>
    );
  }

  return <div>MLX jest gotowy do użycia!</div>;
}
```

## Wskazówki

1. **Wybór providera**: Użyj Claude dla najwyższej jakości, MLX dla szybkości i prywatności
2. **Rundy**: 2 rundy to sweet spot dla większości problemów
3. **Temperatura**: 0.3-0.5 dla matematyki, 0.7-0.9 dla wyjaśnień
4. **Model MLX**: Zacznij od 3B, skaluj do 7B/11B jeśli potrzebujesz lepszej jakości
