import { promises as fs } from 'node:fs';

/**
 * A spending ceiling for the Token Factory outlet. The platform documents no per-key cap, and a
 * card-backed balance may go negative, so the only reliable stop is here.
 *
 * Each call reserves its worst case on disk before the request leaves, then settles to the usage
 * the provider reports. A crash between the two leaves the reservation in place, which can only
 * overstate spending. Without prices the ceiling cannot be computed, so a configured budget with
 * missing prices counts as exhausted rather than unlimited.
 */
const defaultOutputTokens = 4096;
const money = value => Math.round(value * 1e6) / 1e6;

export function createBudget(env, file) {
  const limit = env.NEBIUS_BUDGET_USD === undefined ? null : Number(env.NEBIUS_BUDGET_USD);
  const inPrice = Number(env.NEBIUS_PRICE_INPUT_PER_M);
  const outPrice = Number(env.NEBIUS_PRICE_OUTPUT_PER_M);
  const priced = Number.isFinite(inPrice) && inPrice > 0 && Number.isFinite(outPrice) && outPrice > 0;
  const configured = limit !== null;
  const usable = configured && Number.isFinite(limit) && limit > 0 && priced;
  let queue = Promise.resolve();
  let spent = 0;
  let loaded = false;

  const serial = work => { const run = queue.then(work); queue = run.catch(() => {}); return run; };
  const load = async () => {
    if (loaded) return;
    const saved = await fs.readFile(file, 'utf8').then(JSON.parse, error => {
      if (error.code === 'ENOENT') return { spentUsd: 0 };
      throw error;
    });
    if (!Number.isFinite(saved.spentUsd) || saved.spentUsd < 0) throw new Error('Invalid budget ledger');
    spent = saved.spentUsd;
    loaded = true;
  };
  const save = async () => {
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({ spentUsd: money(spent) }), { mode: 0o600 });
    await fs.rename(temporary, file);
  };
  const cost = (input, output) => (input * inPrice + output * outPrice) / 1e6;

  return {
    configured,
    async exhausted() {
      if (!configured) return false;
      if (!usable) return true;
      return serial(async () => { await load(); return spent >= limit; });
    },
    async status() {
      if (!configured) return { limited: false };
      return serial(async () => {
        await load().catch(() => {});
        return { limited: true, limitUsd: usable ? limit : null, spentUsd: money(spent),
          exhausted: !usable || spent >= limit };
      });
    },
    // A fetch for the Token Factory outlet only. It refuses before sending when the worst case
    // would cross the ceiling, and never lets a ledger failure turn into an unmetered call.
    fetch: (url, init = {}, request = fetch) => {
      if (!configured) return request(url, init);
      const body = typeof init.body === 'string' ? init.body : '';
      let maxOutput = defaultOutputTokens;
      try { maxOutput = JSON.parse(body).max_tokens ?? defaultOutputTokens; } catch { /* keep the default */ }
      // Tokens never outnumber UTF-8 bytes, so the byte length bounds the prompt from above.
      const reserve = cost(Buffer.byteLength(body), maxOutput);
      return serial(async () => {
        if (!usable) throw Object.assign(new Error('NEBIUS_BUDGET_EXHAUSTED'), { status: 503 });
        await load();
        if (spent + reserve > limit) throw Object.assign(new Error('NEBIUS_BUDGET_EXHAUSTED'), { status: 503 });
        spent += reserve;
        await save();
      }).then(async () => {
        let actual = reserve;
        try {
          const response = await request(url, init);
          if (!response.ok) actual = 0;
          else {
            const usage = await response.clone().json().then(payload => payload?.usage, () => null);
            if (Number.isFinite(usage?.prompt_tokens) && Number.isFinite(usage?.completion_tokens)) {
              actual = cost(usage.prompt_tokens, usage.completion_tokens);
            }
          }
          return response;
        } finally {
          await serial(async () => { spent = Math.max(0, spent - reserve + actual); await save(); });
        }
      });
    }
  };
}
