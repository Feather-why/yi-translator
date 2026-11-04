import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仅用于调度先导实验，不修改正式Core。
// 调用方须先独占实验GPU，并在隔离端口启动六槽Q4测试服务。
const root = fileURLToPath(new URL('../../', import.meta.url));
const server = new URL(process.env.LLAMA_URL || 'http://127.0.0.1:8083');
assert.equal(server.protocol, 'http:'); assert.equal(server.port, '8083');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(server.hostname));
assert.ok(!server.username && !server.password && !server.search && !server.hash && server.pathname === '/');
const directory = path.resolve(process.env.REPORT_DIR || path.join(root, '../../work/optimization-028/long-chunk-pilot'));
const require = createRequire(import.meta.url), build = process.env.BACKEND_BUILD_DIR || path.join(root, 'tests/.compiled');
const compiled = (name) => require(path.join(build, 'backend', name + '.js'));
const { BackendCore } = compiled('core'), { BackendStorage } = compiled('storage'), { SecretVault } = compiled('secrets');
const { splitTranslationText } = compiled('translation-chunks'), { validTranslation } = compiled('validation');
const provider = compiled('providers/llamacpp').default;
assert.equal(provider.limits.concurrency, 6);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const sentences = [
  'The following account describes a synthetic public exhibition, not a real emergency or an instruction for operating equipment. Visitors enter a science centre through the eastern door, while the western door remains closed until the afternoon inspection has finished.',
  'A standard ticket includes the morning exhibition and the guided tour, but it does not include the evening workshop. If that workshop is cancelled, staff refund the workshop fee without cancelling a visitor’s existing reservation for the tour.',
  'The first tour starts at 09:40 and the second starts at 14:20. Both tours last exactly 35 minutes. A visitor who arrives after the first tour has started may join the second tour, but must not interrupt the group that is already inside.',
  'Groups with fewer than eight people should wait beside the small information desk to the left of the main staircase. Larger groups wait near the courtyard entrance, not beside the narrow passage that leads to the underground gallery.',
  'Each visitor may borrow one portable receiver. It works in the main building but receives no signal in the underground gallery. The receiver must be returned after the tour, whereas the printed map may be kept and taken home.',
  'An outdoor temperature below -3 degrees Celsius closes only the garden route; it does not close the indoor exhibition. When the temperature returns to 2 degrees Celsius, staff inspect that route before allowing visitors to use it again.',
  'The exhibition contains an original wooden model and a modern copy made from metal. The original is smaller but heavier than the copy. The label beside the copy describes its maker, while the label beside the original describes its place of discovery.',
  'Two separate storage boxes are marked A and B. The label on box A says “Keep dry.” The label on box B also says “Keep dry.” These are two independent instructions, not a printing error, and neither label says that its box contains glass.',
  'Before moving the metal copy, the assistant closes the cabinet and records the current display number. Only after the supervisor confirms that number may the assistant move the copy. The wooden original must remain in its own display case.',
  'The final visitor leaves the reading room at 18:30, which means half past six in the evening rather than in the morning. Staff then check both inventories, place the spare key in the cabinet, and leave the primary key with the administrator.',
  'A family can reserve either one morning visit or one afternoon visit on the same day, but cannot use a single reservation for both. Children under twelve enter without paying only when accompanied by an adult who holds a valid ticket.',
  'At the end of the demonstration, the guide asks whether the receiver worked inside the main building. A negative answer is a report about that device, not a request to cancel the workshop. The staff member records the answer without changing the visitor’s reservation.',
];
const source = sentences.join(' '), chunks = splitTranslationText(source, provider.limits.maxChars, 'en');
assert.ok(source.length >= 2500 && source.length <= 3500, `Unexpected source length ${source.length}`);
assert.ok(chunks.length >= 3 && chunks.length <= 4); assert.equal(chunks.join(''), source);
assert.ok(chunks.every((text) => text.length <= provider.limits.maxChars && validTranslation(text, text)));
const expectedFacts = [
  'The western door stays closed until the afternoon inspection finishes; the eastern door is the entry.',
  'A normal ticket excludes the evening workshop; a workshop refund does not cancel the tour.',
  'Tour starts 09:40 and 14:20, each lasts 35 minutes; late visitors may join only the later tour.',
  'Fewer than eight people wait at the small desk left of the staircase; larger groups use the courtyard entrance.',
  'One receiver per visitor, usable in the main building but not underground; return the receiver and keep the map.',
  'Below negative three degrees closes only the garden; at positive two an inspection is still needed before reopening.',
  'The wooden original is smaller but heavier than the modern metal copy; the two labels describe different things.',
  'Retain both separate Keep dry instructions for boxes A and B; neither says glass.',
  'Close the cabinet and record the display number, then obtain supervisor confirmation before moving only the copy.',
  '18:30 is evening; check both inventories; spare and primary keys go to different places.',
  'One reservation covers morning or afternoon, not both; under-twelves enter free only with a ticket-holding adult.',
  'A negative receiver report is not a workshop-cancellation request and does not change the reservation.',
];
const background = Array.from({ length: 12 }, (_, index) => `Background queue sample ${String(index + 1).padStart(2, '0')}. The museum guide explains that the east room opens after the inspection, while the west room remains closed. A standard ticket includes the public exhibition but not the evening workshop. Please retain the original reservation when recording the visitor’s question.`);
const context = { url: 'https://example.test/synthetic-public-exhibition', title: 'Synthetic public exhibition visitor information' };
const trials = [
  { scenario: 'idle', round: 0, seed: 42, strategy: 'serial' }, { scenario: 'idle', round: 0, seed: 42, strategy: 'parallel2' },
  { scenario: 'backlog6', round: 0, seed: 42, strategy: 'serial' }, { scenario: 'backlog6', round: 0, seed: 42, strategy: 'parallel2' },
  { scenario: 'backlog6', round: 1, seed: 77, strategy: 'parallel2' }, { scenario: 'backlog6', round: 1, seed: 77, strategy: 'serial' },
  { scenario: 'idle', round: 1, seed: 77, strategy: 'parallel2' }, { scenario: 'idle', round: 1, seed: 77, strategy: 'serial' },
];
const plannedRequests = trials.length * chunks.length + 4 * background.length;
const sourceHashes = new Map([...chunks.map((text, index) => [hash(text), { role: 'main', index }]), ...background.map((text, index) => [hash(text), { role: 'background', index }])]);
const codeFiles = ['src/backend/core.ts', 'src/backend/translation-chunks.ts', 'src/backend/providers/llamacpp.ts', 'src/backend/scheduler/provider-slots.ts'];
const manifest = { at: new Date().toISOString(), server: server.href, adapterVersion: provider.version, source, sourceChars: source.length,
  chunks: chunks.map((text, index) => ({ index, text, chars: text.length, hash: hash(text) })), background, expectedFacts, context,
  trials, plannedRequests, sampling: { temperature: 0.7, top_p: 0.6, top_k: 20, min_p: 0, repeat_penalty: 1.05, max_tokens: 1024, cache_prompt: false },
  sourceHashes: Object.fromEntries(await Promise.all(codeFiles.map(async (file) => [file, hash(await readFile(path.join(root, file)))]))),
  compiledCoreHash: hash(await readFile(path.join(build, 'backend/core.js'))), scriptHash: hash(await readFile(fileURLToPath(import.meta.url))),
  scope: 'Synthetic raw Core scheduling pilot, not an integrated Core optimization. Parallel2 uses at most two independent child jobs through the same six-slot Core, then restores original chunk order. No frontend, cache, model change or production-server request.',
  caveats: ['One independent long source, two seeds, two paired rounds per load condition.', 'Cold prompt KV requested on every call; inspect actual cache_n.', 'Externally prewarmed model; startup is not measured.', 'JSON/SSE model outputs may differ under different batch composition despite the same seed.', 'First word means Core observer visible content, not DOM rendering. Timing recovery and six-slot peak memory are outside this pilot.'] };
await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'plan.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
const reports = [], stop = new AbortController(); let requestCount = 0;
const onStop = () => stop.abort(new DOMException('Pilot interrupted', 'AbortError'));
process.once('SIGINT', onStop); process.once('SIGTERM', onStop);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const visible = (text) => /[\p{L}\p{N}]/u.test(text.replace(/<[^>]*>?/g, ''));
const wrap = (chunk, output) => (chunk.match(/^\s*/)?.[0] ?? '') + output.trim() + (chunk.match(/\s*$/)?.[0] ?? '');
try {
  for (const [trialIndex, trial] of trials.entries()) {
    stop.signal.throwIfAborted();
    const record = { ...trial, trialIndex, requests: [], mainFirstWordMs: null, mainOutput: null, background: [] };
    reports.push(record);
    const origin = performance.now(); let active = 0, maxActive = 0;
    const fetcher = async (url, init = {}) => {
      assert.equal(new URL(url).origin, server.origin); assert.equal(new URL(url).pathname, '/v1/chat/completions');
      const body = JSON.parse(init.body), prompt = body.messages[0].content, text = prompt.split('：\n').at(-1), identity = sourceHashes.get(hash(text));
      assert.ok(identity, 'Unexpected model text or hidden recovery request'); assert.ok(++requestCount <= plannedRequests);
      assert.equal(body.temperature, 0.7); assert.equal(body.top_p, 0.6); assert.equal(body.top_k, 20); assert.equal(body.max_tokens, 1024); assert.equal(body.stream, true);
      body.seed = trial.seed; body.cache_prompt = false;
      const request = { ...identity, sourceHash: hash(text), promptHash: hash(prompt), startMs: performance.now() - origin, number: requestCount };
      record.requests.push(request); active++; maxActive = Math.max(active, maxActive);
      let finished = false, raw = '';
      const decoder = new TextDecoder();
      const finish = () => { if (finished) return; finished = true; active--; request.endMs = performance.now() - origin; request.httpMs = request.endMs - request.startMs;
        for (const event of (raw + decoder.decode()).split(/\r?\n\r?\n/)) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (!data || data === '[DONE]') continue;
          try { const value = JSON.parse(data); if (value.timings) request.timings = value.timings;
            if (value.choices?.[0]?.finish_reason) request.finishReason = value.choices[0].finish_reason; } catch { request.unparsedSseEvent = true; }
        }
      };
      try {
        const response = await fetch(url, { ...init, body: JSON.stringify(body), credentials: 'omit', redirect: 'error' });
        request.status = response.status;
        if (!response.body) { finish(); return response; }
        const reader = response.body.getReader();
        return new Response(new ReadableStream({ async pull(controller) {
          try { const next = await reader.read(); if (next.done) { finish(); controller.close(); reader.releaseLock(); }
            else { raw += decoder.decode(next.value, { stream: true }); controller.enqueue(next.value); } }
          catch (error) { request.error = String(error); finish(); controller.error(error); void reader.cancel().catch(() => {}); }
        }, async cancel(reason) { finish(); await reader.cancel(reason).catch(() => {}); try { reader.releaseLock(); } catch {} } }),
        { status: response.status, statusText: response.statusText, headers: response.headers });
      } catch (error) { request.error = String(error); finish(); throw error; }
    };
    const data = {}, area = { async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(data[key])])); }, async set(value) { Object.assign(data, structuredClone(value)); } };
    globalThis.chrome = { storage: { local: area } };
    const core = new BackendCore({ providers: [provider], storage: new BackendStorage({ memory: true }), vault: new SecretVault({ memory: true, storage: area }), fetch: fetcher });
    await core.ready(); await core.save(provider.id, true, { url: server.href });
    const translate = (text, id, priority, observer) => {
      const segment = { id, text, kind: 'paragraph' }, job = { jobId: `${trialIndex}-${id}`, mode: 'accurate', sourceLang: 'en', targetLang: 'zh-CN',
        priority, noCache: true, stream: true, context, segments: [segment] };
      return core.translate(job, segment, 'accurate', stop.signal, observer);
    };
    const backgroundWork = trial.scenario === 'backlog6' ? background.map((text, index) => {
      const started = performance.now();
      return translate(text, `bg${index}`, 10).then((value) => { record.background.push({ index, elapsedMs: performance.now() - started, endMs: performance.now() - origin, text: value.text }); return value; });
    }) : [];
    if (backgroundWork.length) {
      const deadline = Date.now() + 5000;
      while (active < 6) { assert.ok(Date.now() < deadline, 'Six background slots did not fill'); await pause(2); }
    }
    const mainStarted = performance.now(); record.mainStartMs = mainStarted - origin;
    record.backgroundActiveAtMain = active; record.backgroundRequestsAtMain = record.requests.length;
    const preview = (text) => { if (record.mainFirstWordMs === null && visible(text)) record.mainFirstWordMs = performance.now() - mainStarted; };
    if (trial.strategy === 'serial') {
      const result = await translate(source, 'main', 0, { onPartial: ({ text }) => preview(text) });
      record.mainOutput = result.text; record.coreTiming = result.timing;
    } else {
      const completed = new Array(chunks.length), partials = new Array(chunks.length); let next = 0;
      record.children = [];
      const emitOrdered = () => { let text = ''; for (let index = 0; index < chunks.length; index++) {
        if (completed[index] !== undefined) text += completed[index];
        else { if (partials[index] !== undefined) text += (chunks[index].match(/^\s*/)?.[0] ?? '') + partials[index]; break; }
      } preview(text); };
      const worker = async () => { while (next < chunks.length) { const index = next++, started = performance.now();
        const value = await translate(chunks[index], `main${index}`, 0, { onPartial: ({ text }) => { partials[index] = text; emitOrdered(); } });
        completed[index] = wrap(chunks[index], value.text); record.children.push({ index, elapsedMs: performance.now() - started, endMs: performance.now() - origin, timing: value.timing }); emitOrdered();
      } };
      await Promise.all([worker(), worker()]); record.mainOutput = completed.join('');
    }
    record.mainDoneMs = performance.now() - mainStarted; record.mainEndMs = performance.now() - origin;
    await Promise.all(backgroundWork); record.allDoneMs = performance.now() - origin;
    record.maxConcurrentHttp = maxActive; record.structureValid = validTranslation(source, record.mainOutput);
    assert.ok(record.structureValid); assert.ok(maxActive <= 6);
    assert.equal(record.requests.filter((request) => request.role === 'main').length, chunks.length);
    assert.equal(record.requests.filter((request) => request.role === 'background').length, backgroundWork.length);
    assert.ok(record.requests.every((request) => request.status === 200 && request.finishReason === 'stop' && request.timings?.cache_n === 0));
    record.semanticPass = null;
    await appendFile(path.join(directory, 'trials.jsonl'), JSON.stringify(record) + '\n');
    console.log(JSON.stringify({ trialIndex, scenario: trial.scenario, strategy: trial.strategy, mainFirstWordMs: record.mainFirstWordMs,
      mainDoneMs: record.mainDoneMs, allDoneMs: record.allDoneMs, requests: record.requests.length }));
  }
} catch (error) {
  stop.abort(error); throw error;
} finally {
  process.removeListener('SIGINT', onStop); process.removeListener('SIGTERM', onStop);
  const paired = ['idle', 'backlog6'].flatMap((scenario) => [0, 1].map((round) => {
    const serial = reports.find((row) => row.scenario === scenario && row.round === round && row.strategy === 'serial');
    const parallel = reports.find((row) => row.scenario === scenario && row.round === round && row.strategy === 'parallel2');
    if (!serial || !parallel || serial.mainOutput === null || parallel.mainOutput === null) return { scenario, round, incomplete: true };
    const requestKey = (row) => `${row.role}:${row.index}`;
    const inputsEqual = serial.requests.every((row) => parallel.requests.some((other) => requestKey(row) === requestKey(other) && row.promptHash === other.promptHash));
    const backgroundEnd = (row) => row.background.length ? Math.max(...row.background.map((item) => item.endMs)) : null;
    return { scenario, round, seed: serial.seed, samePrompts: inputsEqual, sameRequestCount: serial.requests.length === parallel.requests.length,
      sameOutput: serial.mainOutput === parallel.mainOutput, mainFirstWordSavingMs: serial.mainFirstWordMs - parallel.mainFirstWordMs,
      mainDoneSavingMs: serial.mainDoneMs - parallel.mainDoneMs, mainDoneSavingPercent: 100 * (serial.mainDoneMs - parallel.mainDoneMs) / serial.mainDoneMs,
      allDoneSavingMs: serial.allDoneMs - parallel.allDoneMs,
      backgroundCompletionPenaltyMs: scenario === 'backlog6' ? backgroundEnd(parallel) - backgroundEnd(serial) : null,
      serialTokens: serial.requests.filter((row) => row.role === 'main').reduce((sum, row) => sum + (row.timings?.predicted_n ?? 0), 0),
      parallelTokens: parallel.requests.filter((row) => row.role === 'main').reduce((sum, row) => sum + (row.timings?.predicted_n ?? 0), 0) };
  }));
  const nonce = randomBytes(12).toString('hex'), unique = new Map(), mapping = [];
  for (const row of reports.filter((row) => row.mainOutput !== null)) {
    const key = hash(row.mainOutput); let blindId = unique.get(key)?.blindId;
    if (!blindId) { blindId = 'lc-' + hash(nonce + key).slice(0, 12); unique.set(key, { blindId, source, output: row.mainOutput, checks: expectedFacts }); }
    mapping.push({ blindId, trialIndex: row.trialIndex, scenario: row.scenario, strategy: row.strategy, seed: row.seed });
  }
  const result = { ...manifest, finishedAt: new Date().toISOString(), complete: reports.length === trials.length && reports.every((row) => row.allDoneMs !== undefined),
    actualRequests: requestCount, paired, reports };
  await writeFile(path.join(directory, 'results.json'), JSON.stringify(result, null, 2));
  await writeFile(path.join(directory, 'blind.json'), JSON.stringify({ rows: [...unique.values()].sort((a, b) => a.blindId.localeCompare(b.blindId)) }, null, 2));
  await writeFile(path.join(directory, 'blind-mapping.json'), JSON.stringify(mapping, null, 2));
}
