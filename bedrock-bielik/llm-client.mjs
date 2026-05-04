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
import {
  markBedrockAttempt,
  markBedrockColdStart,
  markBedrockSuccess,
  markBedrockFailure,
} from './state.mjs';

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

    // Bedrock CMI cold start: po ~5 min bezczynnosci model jest wyladowany,
    // pierwszy invoke zwraca ModelNotReadyException (HTTP 429). Cold start
    // potrafi trwac do 5 min przy pierwszym uruchomieniu po dlugim idle.
    // Retry'ujemy 10 razy ze wzrastajacym backoffem do ~5 minut total.
    console.log('[bedrock] invoke start, modelArn=' + this.modelArn);
    markBedrockAttempt();
    let resp;
    const maxAttempts = 10;
    const delays = [3000, 5000, 8000, 12000, 18000, 25000, 35000, 50000, 60000, 60000];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        resp = await this.client.send(cmd);
        markBedrockSuccess();
        if (attempt > 0) {
          console.log(`[bedrock] invoke OK po ${attempt + 1} probach`);
        }
        break;
      } catch (err) {
        const isColdStart = err?.name === 'ModelNotReadyException'
          || err?.$metadata?.httpStatusCode === 429;
        console.log(`[bedrock] attempt ${attempt + 1}/${maxAttempts} blad: name=${err?.name} status=${err?.$metadata?.httpStatusCode} coldStart=${isColdStart}`);
        if (isColdStart && attempt < maxAttempts - 1) {
          markBedrockColdStart();
          const delay = delays[attempt];
          console.log(`[bedrock] ModelNotReady, czekam ${delay}ms i retry`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        markBedrockFailure();
        throw err;
      }
    }

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
