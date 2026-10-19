import crypto from 'node:crypto';
import { parseAction } from './prompt.mjs';

// Hash exact strings, including the brief, without retaining environment values.
// Sort object keys so an equivalent settings/env object keeps the same identity.
export function geminiIdentity(value) {
  const serialized = JSON.stringify(value, (_key, item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

export class GeminiSession {
  seed = null;
  pending = null;

  begin(identity, rotate, isolated = false) {
    if (isolated) return { id: null, n: 0, identity, isolated: true };
    const limit = Number.isSafeInteger(rotate) && rotate > 0 ? rotate : 6;
    const seed = this.seed;
    const reuse = seed?.identity === identity && seed.n < limit;
    const request = { id: reuse ? seed.id : null, n: reuse ? seed.n : 0, identity };
    // An in-flight request is not a confirmed seed. Overlapping calls start fresh;
    // only the latest request can publish state, and failure invalidates them all.
    this.seed = null;
    this.pending = request;
    return request;
  }

  succeed(request, id) {
    if (request.isolated || this.pending !== request) return;
    this.pending = null;
    this.seed = id ? { id, n: request.n + 1, identity: request.identity } : null;
  }

  invalidate() {
    this.seed = null;
    this.pending = null;
  }
}

export function geminiReply(result, request) {
  const failed = result.code !== 0 || result.timedOut;
  let reply;
  try { reply = JSON.parse(result.stdout); }
  catch { throw new Error(failed ? '' : 'Missing or invalid agy JSON response'); }
  // Keep the existing process/status diagnostics byte-for-byte, including the
  // stderr suffix limit in the adapter. Validation errors get separate reasons.
  const deniedPass = reply?.status === 'SUCCESS'
    && (!reply.response || typeof reply.response === 'string' && !reply.response.trim())
    && Array.isArray(reply.denied_actions) && reply.denied_actions.length > 0
    && reply.denied_actions.every(d => d && typeof d === 'object'
      && [d.display_name, d.action].some(name => typeof name === 'string' && name.trim()));
  if (deniedPass) result.stderr += `\nagy tool denied: ${reply.denied_actions.map(d => d.display_name || d.action).join(', ')}`;
  if (reply?.status && reply.status !== 'SUCCESS') result.stderr += `\nstatus=${reply.status}`;
  if (failed || reply?.status && reply.status !== 'SUCCESS') throw new Error('');
  if (!reply || typeof reply !== 'object' || Array.isArray(reply) || reply.status !== 'SUCCESS') {
    throw new Error(`Unsuccessful agy response (status=${String(reply?.status).slice(0, 80)})`);
  }
  if (reply.conversation_id != null && typeof reply.conversation_id !== 'string') {
    throw new Error('Invalid agy conversation ID');
  }
  const id = reply.conversation_id?.trim() ? reply.conversation_id : null;
  // A fresh call carried the brief even if agy omitted its ID. A reduced call did
  // not: accepting an ID switch here could accept an answer without instructions.
  if (request.id && id !== request.id) throw new Error('agy conversation ID changed or missing on reused prompt');
  if (reply.response !== undefined && typeof reply.response !== 'string') {
    throw new Error('Invalid agy response text');
  }
  // Preserve the existing denied-tool pass, but require a valid success envelope.
  const text = deniedPass ? '{"action":"pass"}' : reply.response || '';
  // Use the room's existing parser, including optional actions and fenced JSON;
  // preserve the returned text verbatim instead of imposing a new action schema.
  if (!parseAction(text)) throw new Error('Missing or invalid agy chat action');
  return { text, id };
}
