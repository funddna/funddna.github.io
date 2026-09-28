// Bounded daily backfill and material-change scan. Completed analyses are never rewritten
// just because a day passed. Missing funds are filled gradually, within the free-tier cap.
const fs = require('fs'), path = require('path');
const { buildFund } = require('../lib/fund'); const { buildAnalysis } = require('../lib/analysis');
const { signals, compare } = require('../lib/triggers');
const root = path.join(__dirname, '..', 'data'), universe = JSON.parse(fs.readFileSync(path.join(root, 'portfolio-universe.json')));
const featured = ['122639','118955','120166','118989','120503','119598'];
const codes = [...new Set([...featured, ...universe.funds.map(f => String(f.code))])];
const DAILY_CALLS = Math.min(12, Math.max(1, +(process.env.DAILY_GEMINI_CAP || 8)));
const SCAN_COUNT = Math.min(40, Math.max(DAILY_CALLS, +(process.env.DAILY_SCAN_COUNT || 20)));
const GAP = Math.max(60000, +(process.env.PREBUILD_GAP_MS || 90000));
const MAX_RUN_MS = 43 * 60e3, started = Date.now();
const file = c => path.join(root, 'analysis', `${c}.json`);
const signalFile = c => path.join(root, 'signals', `${c}.json`);
const stateFile = path.join(root, 'backfill-state.json');
const read = p => { try { return JSON.parse(fs.readFileSync(p)); } catch { return null; } };
const write = (p, x) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(x) + '\n'); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasAnalysis = a => !!(a && a.holdings && a.holdings.length && a.portfolio);
const isQuota = e => /\b429\b|quota|resource_exhausted|rate.limit/i.test(String(e));
(async () => {
  const prev = read(stateFile) || {}, cursor = (+prev.cursor || 0) % codes.length;
  // Retry transient failures before scanning new funds. Migrate failures from the old
  // state format once, excluding quota stops (the cursor already resumes those).
  // The queue is persisted independently of the current run's failure report.
  const pending = [...new Set((prev.failedFunds || (prev.failures || []).filter(f => !isQuota(f.error)).map(f => f.code))
    .map(String).filter(c => codes.includes(c)))];
  let writes = 0, attempts = 0, checked = 0, failures = [], quota = false, lastCall = 0, cursorAdvance = 0;
  const retryCodes = pending.slice(0, SCAN_COUNT);
  const queueFailure = c => { if (!pending.includes(c)) pending.push(c); };
  const clearFailure = c => { const i = pending.indexOf(c); if (i >= 0) pending.splice(i, 1); };
  const today = new Date().toISOString().slice(0,10);
  const used = prev.day === today ? (+prev.dayAttempts || 0) : 0;
  for (let i = 0; i < SCAN_COUNT; i++) {
    if (Date.now() - started > MAX_RUN_MS - 120000) break;
    const retry = i < retryCodes.length;
    const c = retry ? retryCodes[i] : codes[(cursor + cursorAdvance) % codes.length];
    if (!retry && pending.includes(c)) { cursorAdvance++; continue; }
    const prior = read(file(c)), baseline = read(signalFile(c));
    try {
      const fund = await buildFund(c);
      const current = hasAnalysis(prior) ? await signals(fund, prior) : null;
      const reasons = current ? compare(current, baseline, prior) : ['missing analysis'];
      if (!reasons.length) {
        if (!baseline) write(signalFile(c), { ...current, analysisGeneratedAt: prior.generatedAt });
        clearFailure(c); checked++; if (!retry) cursorAdvance++; continue;
      }
      if (attempts + used >= DAILY_CALLS) break;
      if (lastCall) await sleep(Math.max(0, GAP - (Date.now() - lastCall)));
      lastCall = Date.now(); attempts++;
      console.log(c, reasons.join(' | '));
      const a = await buildAnalysis(fund);
      if (!hasAnalysis(a)) {
        const err = String(a.error || 'incomplete analysis'); failures.push({ code:c, error:err.slice(0, 180) });
        if (isQuota(err)) { quota = true; break; }
        queueFailure(c); checked++; if (!retry) cursorAdvance++; continue;
      }
      // Successful research only: no partial overwrite and no baseline advance on failure.
      write(file(c), a);
      const snapshot = current || await signals(fund, a);
      write(signalFile(c), { ...snapshot, nav: fund.nav, analysisGeneratedAt:a.generatedAt });
      clearFailure(c); writes++; checked++; if (!retry) cursorAdvance++;
      console.log(c, 'published', a.holdings.length, 'positions');
    } catch (e) {
      const err = String(e.message || e); failures.push({ code:c, error:err.slice(0,180) });
      if (isQuota(err)) { quota = true; break; }
      queueFailure(c); checked++; if (!retry) cursorAdvance++;
    }
  }
  const next = (cursor + cursorAdvance) % codes.length;
  write(stateFile, { cursor:next, scanned:checked, attempts, day:today, dayAttempts:used+attempts, published:writes, quotaStopped:quota,
    total:codes.length, completed:codes.filter(c=>hasAnalysis(read(file(c)))).length, failedFunds:pending,
    lastRun:new Date().toISOString(), failures:failures.slice(0,20) });
  console.log('Coverage', codes.filter(c=>hasAnalysis(read(file(c)))).length + '/' + codes.length,
    'attempts', attempts, 'new/updated', writes, 'scanned', checked, 'quota stopped', quota, 'failures', failures);
  if (failures.length && !quota) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
