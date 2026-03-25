#!/usr/bin/env node

/**
 * Discord Bot for Formulo
 *
 * Uses the SAME /api/guardrail + /api/solve endpoints as the web UI.
 * No direct LLM or SymPy calls. Single pipeline for both consumers.
 *
 * Environment variables:
 *   DISCORD_TOKEN        - Bot token from Discord Developer Portal (required)
 *   DISCORD_CHANNEL_ID   - Channel ID to monitor (required)
 *   FORMULO_API_URL      - Base URL of the Formulo server (default: http://localhost:5000)
 */

import { Client, GatewayIntentBits } from 'discord.js';

// ── Configuration ────────────────────────────────────────────────────────────

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const API_BASE = process.env.FORMULO_API_URL || `http://localhost:${process.env.PORT || 5000}`;

if (!DISCORD_TOKEN) {
  console.error('[discord-bot] DISCORD_TOKEN is required');
  process.exit(1);
}
if (!DISCORD_CHANNEL_ID) {
  console.error('[discord-bot] DISCORD_CHANNEL_ID is required');
  process.exit(1);
}

// ── API helpers ──────────────────────────────────────────────────────────────

/**
 * Call the server-side guardrail. Returns { valid, reason }.
 * Fails open (returns valid:true) on network errors.
 */
async function checkGuardrail(message) {
  try {
    const res = await fetch(`${API_BASE}/api/guardrail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { valid: true };
    return await res.json();
  } catch (err) {
    console.error('[discord-bot] Guardrail error:', err.message);
    return { valid: true };
  }
}

/**
 * Call /api/solve (SSE) and collect the final result.
 * Calls onStep for each progress event so the bot can update its message.
 * Returns the final result object from the 'done' event.
 */
async function callSolve(message, sessionId, onStep) {
  const res = await fetch(`${API_BASE}/api/solve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId }),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`/api/solve returned ${res.status}: ${text}`);
  }

  // Parse SSE stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result = null;
  let lastError = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // Process complete SSE events (separated by double newline)
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let eventType = 'message';
      let eventData = '';

      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event: ')) {
          eventType = line.slice(7);
        } else if (line.startsWith('data: ')) {
          eventData += line.slice(6);
        }
      }

      if (!eventData) continue;

      try {
        const parsed = JSON.parse(eventData);

        if (eventType === 'step' && onStep) {
          onStep(parsed);
        } else if (eventType === 'done') {
          result = parsed;
        } else if (eventType === 'error') {
          lastError = parsed.error || 'Unknown error';
        }
      } catch {
        // Ignore malformed SSE data
      }
    }
  }

  if (lastError && !result) {
    throw new Error(lastError);
  }

  return result;
}

// ── Discord Bot ──────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`[discord-bot] Logged in as ${client.user.tag}`);
  console.log(`[discord-bot] Monitoring channel: ${DISCORD_CHANNEL_ID}`);
  console.log(`[discord-bot] API base: ${API_BASE}`);
});

/**
 * Split a long string into chunks ≤ maxLen characters, breaking on newlines.
 */
function splitMessage(text, maxLen = 1990) {
  if (text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DISCORD_CHANNEL_ID) return;

  // Only respond when the bot is mentioned
  if (!message.mentions.has(client.user)) return;

  // Strip the mention from the message to get the actual problem
  const problem = message.content.replace(/<@!?\d+>/g, '').trim();
  if (!problem) return;

  console.log(`[discord-bot] Received: ${problem.slice(0, 100)}`);

  let progressMsg;
  try {
    progressMsg = await message.channel.send('Przetwarzam zadanie...');
  } catch (err) {
    console.error('[discord-bot] Failed to send initial message:', err);
    return;
  }

  const updateProgress = async (text) => {
    try {
      await progressMsg.edit(text);
    } catch {
      // Ignore edit errors (rate limits, etc.)
    }
  };

  try {
    // Step 1: Guardrail
    await updateProgress('Sprawdzam zapytanie...');
    const guard = await checkGuardrail(problem);

    if (!guard.valid) {
      await progressMsg.edit(guard.reason || 'To zapytanie nie dotyczy matematyki.');
      return;
    }

    // Step 2: Solve via SSE
    await updateProgress('Rozwiazuję zadanie...');

    const sessionId = `discord-${message.author.id}-${Date.now()}`;

    const result = await callSolve(problem, sessionId, (step) => {
      // Update progress message with the latest step
      if (step.content && step.agentName) {
        updateProgress(`${step.agentName}: ${step.content.slice(0, 150)}`);
      }
    });

    if (!result || !result.success) {
      await progressMsg.edit('Nie udalo sie rozwiazac zadania.');
      return;
    }

    // Delete progress message and send results
    try {
      await progressMsg.delete();
    } catch {
      // Ignore
    }

    // Send classification info
    if (result.classification) {
      const classType = result.classification.type || 'general';
      const conf = Math.round((result.classification.confidence || 0) * 100);
      await message.channel.send(`**Klasyfikacja:** ${classType} (${conf}%)`);
    }

    // Send SymPy result
    if (result.sympyResult) {
      for (const chunk of splitMessage(`**Wynik SymPy:**\n${result.sympyResult}`)) {
        await message.channel.send(chunk);
      }
    }

    // Send summary (the main explanation)
    if (result.summary) {
      for (const chunk of splitMessage(result.summary)) {
        await message.channel.send(chunk);
      }
    }

  } catch (err) {
    console.error('[discord-bot] Pipeline error:', err);
    try {
      await progressMsg.edit(`Blad: ${err.message}`);
    } catch {
      // Ignore
    }
  }
});

console.log('[discord-bot] Attempting login...');
console.log(`[discord-bot] DISCORD_CHANNEL_ID: ${DISCORD_CHANNEL_ID}`);
console.log(`[discord-bot] API_BASE: ${API_BASE}`);

client.login(DISCORD_TOKEN).catch((err) => {
  console.error('[discord-bot] Login failed:', err.message);
  process.exit(1);
});
