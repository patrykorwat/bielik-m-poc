/**
 * createLLMClient: factory zwracajacy klienta z interfejsem OpenAI
 * (`.chat.completions.create()`), ale uderza w AWS Bedrock Custom Model Import
 * jezeli ustawione jest BEDROCK_MODEL_ARN.
 *
 * Drop-in replacement dla `new OpenAI(...)` w solve-pipeline.js.
 *
 * Format ChatML pod Bielik 11B v3.0 Instruct.
 * Bedrock CMI zwraca text_completion z vLLM, mapujemy na chat.completion.
 */

import OpenAI from 'openai';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'node:crypto';

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

class BedrockChatShim {
  constructor({ region, modelArn, defaultModelName }) {
    this.client = new BedrockRuntimeClient({ region });
    this.modelArn = modelArn;
    this.defaultModelName = defaultModelName;
    this.chat = { completions: { create: this.create.bind(this) } };
  }

  async create(opts) {
    const {
      messages = [],
      temperature = 0.3,
      max_tokens = 512,
      top_p = 0.9,
      stop,
      stream = false,
      model,
    } = opts;

    if (stream) {
      throw new Error('BedrockChatShim: streaming nie jest tu zaimplementowane. Dodaj jak bedzie potrzebne.');
    }

    const prompt = messagesToChatML(messages);
    const stopSeqs = Array.from(new Set([
      '<|im_end|>',
      ...(Array.isArray(stop) ? stop : stop ? [stop] : []),
    ]));

    const body = JSON.stringify({
      prompt,
      max_tokens,
      temperature,
      top_p,
      stop: stopSeqs,
    });

    const cmd = new InvokeModelCommand({
      modelId: this.modelArn,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const resp = await this.client.send(cmd);
    const text = new TextDecoder('utf-8').decode(resp.body);
    const parsed = JSON.parse(text);

    const choice = parsed.choices?.[0] || {};
    const content = (choice.text || '').replace(/<\|im_end\|>\s*$/, '');

    return {
      id: `chatcmpl-${randomUUID()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model || this.defaultModelName || 'speakleash/Bielik-11B-v3.0-Instruct',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: choice.finish_reason || 'stop',
      }],
      usage: parsed.usage ? {
        prompt_tokens: parsed.usage.prompt_tokens,
        completion_tokens: parsed.usage.completion_tokens,
        total_tokens: parsed.usage.total_tokens,
      } : {},
    };
  }
}

/**
 * Wybiera backend na podstawie env:
 *   - BEDROCK_MODEL_ARN ustawione  -> Bedrock shim
 *   - inaczej                       -> OpenAI client (np. vLLM via LLM_API_URL)
 */
export function createLLMClient({
  baseURL,
  apiKey,
  bedrockRegion,
  bedrockModelArn,
  defaultModelName,
} = {}) {
  if (bedrockModelArn) {
    return new BedrockChatShim({
      region: bedrockRegion || 'us-east-1',
      modelArn: bedrockModelArn,
      defaultModelName,
    });
  }
  return new OpenAI({ apiKey, baseURL });
}
