#!/usr/bin/env node
/*
 * Kubester test suite (no dependencies):
 *   1. unit checks for parsers/helpers
 *   2. replays EVERY lesson's solution on a fresh simulated cluster and asserts each step's check passes
 *
 *   node tests/run-tests.js            # everything
 *   node tests/run-tests.js services   # only lessons whose id contains "services"
 */
'use strict';
const KS = require('./load.js')();
const makeDriver = require('./driver.js');
const filter = process.argv[2];
let failures = 0, passes = 0;
const ok = (cond, msg) => { if (cond) passes++; else { failures++; console.log('  ✗ ' + msg); } };

// ---------------------------------------------------------------- unit checks
if (!filter) {
  console.log('unit checks');
  const U = KS.util;
  ok(U.humanDuration(65000) === '65s' && U.humanDuration(185000) === '3m5s' && U.humanDuration(3 * 3600e3) === '3h', 'humanDuration');
  ok(U.parseCpu('250m') === 250 && U.parseCpu('1.5') === 1500 && U.parseMem('1Gi') === 1024 && Math.abs(U.parseMem('256M') - 244.14) < 0.01, 'quantities');
  const sel = U.parseSelectorString('app=web,tier!=db,env in (a,b),!legacy');
  ok(U.matchSelector(sel, { app: 'web', tier: 'fe', env: 'a' }) && !U.matchSelector(sel, { app: 'web', tier: 'db', env: 'a' }) && !U.matchSelector(sel, { app: 'web', env: 'a', legacy: 'x' }), 'label selectors');
  ok(KS.jsonpath.template('{range .items[*]}{.n}{"\\n"}{end}', { items: [{ n: 'a' }, { n: 'b' }] }) === 'a\nb\n', 'jsonpath range');
  ok(KS.jsonpath.template('{.items[?(@.t=="x")].v}', { items: [{ t: 'x', v: 1 }, { t: 'y', v: 2 }] }) === '1', 'jsonpath filter');
  ok(KS.cron.parse('*/5 * * * *') && !KS.cron.parse('61 * * * *') && KS.cron.parse('@hourly'), 'cron parse');
  const R = KS.runtime;
  const fs = new R.Fs(); const env = new R.ShellEnv({ fs, hostname: 'h' });
  const r1 = R.runSync(env, 'for i in 1 2; do echo $i; done | wc -l');
  ok(r1.stdout.trim() === '2', 'shell pipes/loops');
  ok(R.runSync(env, 'printf "a\\nb\\nc\\n" | grep -A1 a').stdout === 'a\nb\n', 'grep -A');
  ok(R.resolveImage('nginx:1.99').error === 'notag' && R.resolveImage('ngnix').error === 'norepo' && R.resolveImage('nginx:1.14.2').ok, 'image resolution');
  const tw = KS.tabwrite('Name:\tx\nNamespace:\tdefault');
  ok(tw === 'Name:       x\nNamespace:  default', 'tabwriter');
}

// ---------------------------------------------------------------- lesson replays
const lessons = KS.LESSONS.filter(l => !filter || l.id.includes(filter));
const t0 = Date.now();
for (const lesson of lessons) {
  const c = new KS.Cluster({ seed: 17 + lesson.index, startTime: Date.UTC(2026, 10, 18, 10, 0, 0) });
  const sh = new KS.HostShell(c, {});
  const ctx = new KS.LessonCtx(() => c, sh);
  sh.hooks = {
    afterCommand: (line, code) => ctx.record('line', line, code),
    onKubectl: (args, code) => ctx.record('kubectl', (args[0] === 'helm' || args[0] === 'sim' ? '' : 'kubectl ') + args.join(' '), code),
  };
  const run = makeDriver(KS, c, sh);
  if (lesson.setup) lesson.setup(c, sh);
  let lessonOk = true;
  const done = new Set();
  for (const step of lesson.steps) {
    c.advance(1500); // a human takes at least a moment between commands
    const cmd = KS.lessonFill(step.cmd, c, 'default');
    const r = run(cmd, { interactive: step.interactive, editor: step.editor, taskLimit: 30000 });
    const deadline = (step.wait || 0) + 2000;
    let passed = false;
    for (let t = 0; t <= deadline; t += 250) {
      // like the UI: earlier steps that are satisfied later also count
      lesson.steps.forEach(s2 => { if (!done.has(s2.index)) { try { if (s2.check(ctx)) done.add(s2.index); } catch (e) { /* not yet */ } } });
      if (done.has(step.index)) { passed = true; break; }
      c.advance(250);
    }
    if (!passed) {
      lessonOk = false;
      ok(false, `[${lesson.id}] step ${step.index + 1} did not pass: ${cmd}\n      exit=${r.code}\n      ${r.all.split('\n').slice(0, 14).join('\n      ')}`);
    } else passes++;
  }
  console.log(`${lessonOk ? '✓' : '✗'} ${lesson.id} (${lesson.steps.length} steps)`);
}
console.log(`\n${passes} passed, ${failures} failed — ${((Date.now() - t0) / 1000).toFixed(1)}s`);
process.exit(failures ? 1 : 0);
