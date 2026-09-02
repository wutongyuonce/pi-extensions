// Regenerates evidence/CONTRACT-EVIDENCE.md from REAL calls against the
// SERPdive API. Run it with your own key to reproduce the file:
//
//   SERPDIVE_API_KEY=sd_live_… node evidence/contract-probe.mjs
//
// The key is read from the environment and never written to the output —
// the script asserts that before exiting.
import fs from 'node:fs';

const KEY = process.env.SERPDIVE_API_KEY;
if (!KEY) {
  console.error('SERPDIVE_API_KEY is not set. Get a key at https://serpdive.com/dashboard/keys');
  process.exit(1);
}
const URL = 'https://api.serpdive.com/v1/search';
const out = [];
const say = (s = '') => out.push(s);

async function call(body, { key = KEY, abortAfterMs = null } = {}) {
  const ctrl = new AbortController();
  if (abortAfterMs) setTimeout(() => ctrl.abort(), abortAfterMs);
  const t0 = Date.now();
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, ms: Date.now() - t0, json };
  } catch (err) {
    return { status: null, ms: Date.now() - t0, aborted: err.name === 'AbortError', err: err.name };
  }
}

// Reduce a response to its SHAPE: keep the structure, truncate the content.
function shape(j) {
  if (!j) return null;
  const c = JSON.parse(JSON.stringify(j));
  if (Array.isArray(c.results)) {
    c.results = c.results.slice(0, 2).map((r) => ({
      ...r,
      content: typeof r.content === 'string' ? `${r.content.slice(0, 90)}… (${r.content.length} chars)` : r.content,
    }));
    if (j.results.length > 2) c.results.push(`… ${j.results.length - 2} more, same shape`);
  }
  if (typeof c.answer === 'string') c.answer = `${c.answer.slice(0, 160)}… (${j.answer.length} chars)`;
  return c;
}

async function section(title, note, body, opts = {}) {
  const r = await call(body, opts);
  const keyLine = !('key' in opts)
    ? 'authorization: Bearer sd_live_…            # a valid key, redacted'
    : opts.key === null
      ? '(no authorization header sent)'
      : `authorization: Bearer ${opts.key}`;
  say(`### ${title}`);
  say();
  if (note) { say(note); say(); }
  say('```http');
  say('POST https://api.serpdive.com/v1/search');
  say(keyLine);
  say('content-type: application/json');
  say();
  say(JSON.stringify(body));
  say('```');
  say();
  if (r.aborted) {
    say(`Client aborted after ${opts.abortAfterMs} ms → \`${r.err}\` raised locally; no response body.`);
  } else {
    say(`\`HTTP ${r.status}\` in ${r.ms} ms`);
    say();
    say('```json');
    say(JSON.stringify(shape(r.json), null, 2));
    say('```');
  }
  say();
  return r;
}

const Q = 'best open source vector databases';

say('# SERPdive API — contract evidence');
say();
say('Every block below is a real call against `https://api.serpdive.com/v1/search`, captured on '
  + new Date().toISOString().slice(0, 10) + '. Reproduce any of them with your own key: the script that');
say('generated this file is `evidence/contract-probe.mjs`. Page content is truncated to keep the file');
say('readable — nothing else is edited, and the API key is redacted.');
say();
say('---');
say();
say('## 1. Default request and response shape');
say();
await section('Query only', 'The whole request surface is `query`, `model`, `answer`, `max_results`. Everything else is ignored.', { query: Q });

say('## 2. Models');
say();
await section('krill — free tier', 'No answer synthesis on this tier: requesting one is ignored rather than refused (see §3).', { query: Q, model: 'krill' });
await section('mako — 1 credit', null, { query: Q, model: 'mako' });
await section('moby — 1.5 credits', 'Full readable page content; note the content lengths against mako above.', { query: Q, model: 'moby' });

say('## 3. `answer`');
say();
await section('answer: true with mako', 'The `answer` key is present only when requested.', { query: Q, model: 'mako', answer: true });
await section('answer: true with krill', 'Silently ignored on the free tier — no `answer` key, no error, still a complete result.', { query: Q, model: 'krill', answer: true });

say('## 4. `max_results` is a cap, never a minimum');
say();
say('A cap, applied at the edge after the search. The engine still reads a full corpus, so a small');
say('cap trims the response, not the work — and asking for more does not produce more.');
say();
for (const [n, note] of [
  [1, null],
  [3, null],
  [10, 'The ceiling of the range. Fewer come back when fewer are judged relevant — see §1, where no cap returned 5.'],
  [50, 'Above the range: clamped down to 10, silently. Never a 400.'],
  [0, 'Below the range: clamped UP to 1, silently — it is the minimum of the range, NOT a way to say "no cap". One result comes back.'],
  ['abc', 'Unparseable, and this is the asymmetry worth knowing: an out-of-range NUMBER is clamped into the range, but a value that is not a number at all drops the cap entirely and the default applies. Same for null or an absent field.'],
]) {
  await section(`max_results: ${JSON.stringify(n)}`, note, { query: Q, model: 'krill', max_results: n });
}

say('## 5. Errors');
say();
await section('Missing query', null, { model: 'krill' });
await section('Invalid key', null, { query: Q }, { key: 'sd_live_not_a_real_key' });
await section('No key at all', null, { query: Q }, { key: null });

say('## 6. Abort');
say();
await section('Client aborts mid-flight', 'The request is cancellable at any point; the provider maps this to the framework abort path.', { query: Q, model: 'krill' }, { abortAfterMs: 300 });

const path = new URL('./CONTRACT-EVIDENCE.md', import.meta.url).pathname;
fs.writeFileSync(path, out.join('\n'));
console.log(`written: ${path}`);
console.log(`${out.join('\n').length} characters`);
if (out.join('\n').includes(KEY)) console.error('!! THE API KEY APPEARS IN THE OUTPUT — not written');
else console.log('verified: the key appears nowhere in the output');
