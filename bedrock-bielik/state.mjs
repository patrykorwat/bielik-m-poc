/**
 * Wspoldzielony stan Bedrock invocation, czytany przez /api/status w heroku-start.js
 * i aktualizowany przez llm-client.mjs przy kazdym invoke.
 *
 * Effective status liczony z faktow:
 *   - jesli aktualnie trwa retry (isWarming = true) -> 'warming'
 *   - jesli ostatni success < 4 min temu -> 'warm'  (model loaded w Bedrock)
 *   - inaczej -> 'cold' (model prawdopodobnie wyladowany po >5 min idle)
 */

const state = {
  isWarming: false,
  warmingStartedAt: null,
  lastSuccessAt: null,
  lastAttemptAt: null,
  consecutiveColdStartAttempts: 0,
  totalInvokes: 0,
  totalRetries: 0,
};

export function markBedrockAttempt() {
  state.lastAttemptAt = Date.now();
  state.totalInvokes++;
}

export function markBedrockColdStart() {
  state.consecutiveColdStartAttempts++;
  state.totalRetries++;
  if (!state.isWarming) {
    state.isWarming = true;
    state.warmingStartedAt = Date.now();
  }
}

export function markBedrockSuccess() {
  state.lastSuccessAt = Date.now();
  state.isWarming = false;
  state.warmingStartedAt = null;
  state.consecutiveColdStartAttempts = 0;
}

export function markBedrockFailure() {
  state.isWarming = false;
  state.warmingStartedAt = null;
}

export function getBedrockEffectiveStatus() {
  const now = Date.now();
  if (state.isWarming) {
    return {
      status: 'warming',
      warmingForSec: state.warmingStartedAt
        ? Math.round((now - state.warmingStartedAt) / 1000)
        : null,
      lastSuccessAt: state.lastSuccessAt,
      totalInvokes: state.totalInvokes,
      totalRetries: state.totalRetries,
    };
  }
  if (state.lastSuccessAt && now - state.lastSuccessAt < 4 * 60 * 1000) {
    return {
      status: 'warm',
      sinceSec: Math.round((now - state.lastSuccessAt) / 1000),
      lastSuccessAt: state.lastSuccessAt,
      totalInvokes: state.totalInvokes,
      totalRetries: state.totalRetries,
    };
  }
  return {
    status: 'cold',
    lastSuccessAt: state.lastSuccessAt,
    totalInvokes: state.totalInvokes,
    totalRetries: state.totalRetries,
  };
}
