// Server-only, explicitly invoked after TopicStore.submit has saved the story.
// Use one shared TopicStore per data directory. No queue, startup scan or retries.
// `sent` means Formspree acknowledged the request, not confirmed inbox delivery.
export async function deliverTopicMail(store, id, { formId, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  let attempt;
  try { attempt = store.beginMail(id); }
  catch { return { status: 'failed' }; } // No durable claim means no network request.
  if (!attempt.claimed) return { status: attempt.status };

  let status = 'failed';
  if (typeof formId === 'string' && /^[a-zA-Z0-9]{1,64}$/.test(formId)
      && typeof fetchImpl === 'function' && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000) {
    const controller = new AbortController();
    let timer;
    try {
      const deadline = new Promise(resolve => {
        timer = setTimeout(() => { resolve('failed'); controller.abort(); }, timeoutMs);
      });
      const request = async () => {
        const response = await fetchImpl(`https://formspree.io/f/${formId}`, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          // Only stored story fields, no user-controlled recipients or provider options.
          body: JSON.stringify({ subject: 'ERCraft 단톡방 이야기 제보',
            title: attempt.topic.title, message: attempt.topic.text, sourceUrl: attempt.topic.sourceUrl }),
        });
        const body = await response.json();
        return response.ok === true && body?.ok === true ? 'sent' : 'failed';
      };
      // Bound both fetch and JSON parsing, even when an injected fetch ignores abort.
      status = await Promise.race([request(), deadline]);
    } catch { /* Rejects, non-JSON replies and timeouts never count as sent. */ }
    finally { clearTimeout(timer); }
  }

  try { return { status: store.finishMail(id, status) }; }
  catch {
    // The durable pending marker remains. Delivery may have happened; never resend.
    return { status: 'pending' };
  }
}
