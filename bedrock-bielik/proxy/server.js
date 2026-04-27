#!/usr/bin/env node
/**
 * OpenAI-compatible proxy do AWS Bedrock Custom Model Import.
 * Tlumaczy /v1/chat/completions (OpenAI chat) na Bedrock invoke-model
 * z ChatML promptem (Bielik 11B v3.0 Instruct).
 *
 * Konfiguracja przez env:
 *   PORT                  port HTTP (domyslnie 8011)
 *   BEDROCK_REGION        np. us-east-1
 *   BEDROCK_MODEL_ARN     ARN importowanego modelu
 *   PROXY_API_KEY         opcjonalnie, jezeli ustawione, klient musi przyslac
 *                         Authorization: Bearer <PROXY_API_KEY>
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY  (lub IAM role) standardowe AWS creds
 */

import express from 'express';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8011);
const REGION = process.env.BEDROCK_REGION || 'us-east-1';
const MODEL_ARN = process.env.BEDROCK_MODEL_ARN;
const PROXY_API_KEY = process.env.PROXY_API_KEY || '';

if (!MODEL_ARN) {
  console.error('BEDROCK_MODEL_ARN nie ustawiony. Wyjscie.');
  process.exit(1);
}

const bedrock = new BedrockRuntimeClient({ region: REGION });

// ─── Format ChatML pod Bielik 11B v3.0 Instruct ──────────────────────────
function messagesToChatML(messages) {
  const parts = [];
  for (const m of messages) {
    const role = m.role || 'user';
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(c => c.text ?? '').join('')
        : String(m.content ?? '');
    parts.push(`<|im_start|>${role}\n${content}<|im_end|>`);
  }
  parts.push('<|im_start|>assistant\n');
  return parts.join('\n');
}

// ─── Util: budowa OpenAI-style odpowiedzi z Bedrock body ─────────────────
function buildChatResponse({ id, model, completionText, finishReason, usage }) {
  return {
    id: `chatcmpl-${id}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: completionText },
      finish_reason: finishReason || 'stop',
    }],
    usage: usage || {},
  };
}

// ─── Express ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

// Auth middleware (opcjonalny)
app.use((req, res, next) => {
  if (!PROXY_API_KEY) return next();
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${PROXY_API_KEY}`) {
    return res.status(401).json({ error: { message: 'unauthorized' } });
  }
  next();
});

app.get('/healthz', (req, res) => res.json({ ok: true, model_arn: MODEL_ARN, region: REGION }));

// /v1/models dla zgodnosci z OpenAI klientami
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{
      id: 'speakleash/Bielik-11B-v3.0-Instruct',
      object: 'model',
      created: 0,
      owned_by: 'speakleash',
    }],
  });
});

// /v1/chat/completions
app.post('/v1/chat/completions', async (req, res) => {
  const {
    model = 'speakleash/Bielik-11B-v3.0-Instruct',
    messages = [],
    temperature = 0.3,
    max_tokens = 512,
    top_p = 0.9,
    stop,
    stream = false,
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages must be non-empty array' } });
  }

  const prompt = messagesToChatML(messages);
  const stopSequences = Array.from(new Set([
    '<|im_end|>',
    ...(Array.isArray(stop) ? stop : stop ? [stop] : []),
  ]));

  const body = {
    prompt,
    max_tokens,
    temperature,
    top_p,
    stop: stopSequences,
  };

  const requestId = randomUUID();

  try {
    if (stream) {
      // ── Streaming ────────────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const cmd = new InvokeModelWithResponseStreamCommand({
        modelId: MODEL_ARN,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });

      const resp = await bedrock.send(cmd);
      const decoder = new TextDecoder('utf-8');
      const created = Math.floor(Date.now() / 1000);
      const chunkId = `chatcmpl-${requestId}`;

      // Pierwszy chunk z rola
      res.write(`data: ${JSON.stringify({
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let finishReason = 'stop';
      for await (const event of resp.body) {
        if (!event.chunk?.bytes) continue;
        const text = decoder.decode(event.chunk.bytes);
        let parsed;
        try { parsed = JSON.parse(text); } catch { continue; }

        const choice = parsed.choices?.[0];
        const piece = choice?.delta?.content ?? choice?.text ?? '';
        if (piece) {
          res.write(`data: ${JSON.stringify({
            id: chunkId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })}\n\n`);
        }
        if (choice?.finish_reason) {
          finishReason = choice.finish_reason;
        }
      }

      // Final chunk
      res.write(`data: ${JSON.stringify({
        id: chunkId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      // ── Non-streaming ────────────────────────────────────────────────
      const cmd = new InvokeModelCommand({
        modelId: MODEL_ARN,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      });

      const resp = await bedrock.send(cmd);
      const text = new TextDecoder('utf-8').decode(resp.body);
      const parsed = JSON.parse(text);

      const choice = parsed.choices?.[0] || {};
      const completionText = (choice.text || '').replace(/<\|im_end\|>\s*$/, '');
      const usage = parsed.usage ? {
        prompt_tokens: parsed.usage.prompt_tokens,
        completion_tokens: parsed.usage.completion_tokens,
        total_tokens: parsed.usage.total_tokens,
      } : {};

      res.json(buildChatResponse({
        id: requestId,
        model,
        completionText,
        finishReason: choice.finish_reason,
        usage,
      }));
    }
  } catch (err) {
    console.error('[proxy] bedrock error', err?.name, err?.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: `bedrock: ${err?.message || 'unknown'}`, type: err?.name },
      });
    } else {
      try {
        res.write(`data: ${JSON.stringify({ error: { message: err?.message } })}\n\n`);
        res.end();
      } catch {}
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] OpenAI->Bedrock proxy nasluchuje na :${PORT}`);
  console.log(`[proxy] model: ${MODEL_ARN} region: ${REGION}`);
});
