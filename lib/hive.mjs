// Server-only Hive credentials. Never send these settings or upstream error bodies to the UI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function hiveConnection(cfg) {
  const file = cfg.hive?.providerConfigPath || path.join(os.homedir(), '.opencodex', 'config.json');
  const provider = JSON.parse(fs.readFileSync(file, 'utf8')).providers?.[cfg.hive?.providerId || 'HIVE'];
  if (!provider?.apiKey || typeof provider.apiKey !== 'string') throw new Error('Hive API key unavailable');
  const url = new URL(provider.baseUrl);
  if (url.protocol !== 'https:' || !['api-cdn.thehive.ai', 'api.thehive.ai', 'api-va1.thehive.ai'].includes(url.hostname)
      || url.pathname.replace(/\/$/, '') !== '/api/v3' || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error('Unsupported Hive endpoint');
  }
  return { apiKey: provider.apiKey, endpoint: url.href.replace(/\/$/, '') + '/chat/completions' };
}

export function hiveAvailable(cfg) {
  try { hiveConnection(cfg); return true; } catch { return false; }
}

export async function hiveChat(cfg, brief, turn, { signal, fetchImpl = fetch } = {}) {
  const started = Date.now();
  const failure = (detail) => ({ ok: false, text: '', ms: Date.now() - started, detail });
  try {
    const connection = hiveConnection(cfg);
    const model = cfg.agents.deepseek.model;
    const requested = Number(cfg.agents.deepseek.maxOutputTokens ?? 2048);
    const maxTokens = Number.isInteger(requested) ? Math.max(64, Math.min(4096, requested)) : 2048;
    const response = await fetchImpl(connection.endpoint, {
      method: 'POST', redirect: 'error', signal,
      headers: { Authorization: `Bearer ${connection.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: `${brief}\n\n=====\n\n${turn}` }], stream: false, max_tokens: maxTokens }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      return failure(`Hive HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    const chunks = []; let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) { await reader.cancel(); return failure('Hive response too large'); }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result.model && result.model !== model) return failure('Hive returned an unexpected model');
    const choice = result.choices?.[0];
    if (choice?.finish_reason !== 'stop') return failure('Hive response incomplete or unsupported');
    const text = choice.message?.content;
    if (typeof text !== 'string' || !text.trim()) return failure('Hive returned no text');
    const token = (key) => Number.isFinite(result.usage?.[key]) ? result.usage[key] : null;
    return { ok: true, text, ms: Date.now() - started, detail: '', usage: {
      prompt_tokens: token('prompt_tokens'), completion_tokens: token('completion_tokens'), total_tokens: token('total_tokens'),
    } };
  } catch {
    return failure(signal?.aborted ? 'Hive request cancelled or timed out' : 'Hive connection/configuration error');
  }
}
