import { revisionFor, shouldTouch } from './revise.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
};

{
  const plan = revisionFor(
    [{ seq: 4, title: 'Design guidelines', department: 'design', status: 'failed' }],
    [
      { seq: 1, title: 'Audience', department: 'strategy', status: 'done' },
      { seq: 2, title: 'Research', department: 'research', status: 'done' },
      { seq: 3, title: 'Brand', department: 'branding', status: 'done' },
      { seq: 4, title: 'Design guidelines', department: 'design', status: 'failed' },
      { seq: 5, title: 'Data model', department: 'database', status: 'done' },
      { seq: 6, title: 'Compose', department: 'compose', status: 'blocked' },
      { seq: 7, title: 'Render Home', department: 'render', status: 'blocked' },
    ],
  );
  ok('design fail is a design revision', plan.kind === 'design');
  ok('reopens design→qa', plan.reopen[0] === 'design' && plan.reopen.includes('compose') && plan.reopen.includes('render') && plan.reopen.includes('qa'));
  ok('preserves database', plan.preserve.includes('database'));
  ok('preserves branding', plan.preserve.includes('branding'));
  ok('clears rejected layout', plan.clearLayout === true && plan.clearSite === true);
  ok('does not touch database', shouldTouch('database', plan) === false);
  ok('does touch design', shouldTouch('design', plan) === true);
}

{
  const plan = revisionFor(
    [{ seq: 9, title: 'QA', department: 'qa', status: 'failed' }],
    [
      { seq: 5, title: 'Data model', department: 'database', status: 'done' },
      { seq: 6, title: 'Design', department: 'design', status: 'done' },
      { seq: 7, title: 'Compose', department: 'compose', status: 'done' },
      { seq: 8, title: 'Render', department: 'render', status: 'done' },
      { seq: 9, title: 'QA', department: 'qa', status: 'failed' },
    ],
  );
  ok('QA reject opens a design revision (not QA-only)', plan.kind === 'design' && plan.reopen[0] === 'design');
  ok('QA reject does not regenerate customer data', !plan.reopen.includes('database') && plan.preserve.includes('database'));
  ok('QA reject does not blindly keep the layout', plan.clearLayout === true);
}

{
  const plan = revisionFor(
    [{ seq: 5, title: 'Data model', department: 'database', status: 'failed' }],
    [
      { seq: 4, title: 'Design', department: 'design', status: 'done' },
      { seq: 5, title: 'Data model', department: 'database', status: 'failed' },
    ],
  );
  ok('database fail is a data revision', plan.kind === 'data');
  ok('data revision does not reopen design', !plan.reopen.includes('design') && plan.preserve.includes('design'));
  ok('data revision keeps layout', plan.clearLayout === false && plan.clearSite === false);
}

{
  const plan = revisionFor([{ seq: 1, title: 'Audience', department: 'strategy', status: 'failed' }]);
  ok('strategy fail is a task retry, not a design rewrite', plan.kind === 'task' && plan.reopen.includes('strategy') && plan.clearLayout === false);
}

{
  const runner = readFileSync(fileURLToPath(new URL('./runner.ts', import.meta.url)), 'utf8');
  ok('runner uses revisionFor (not a blunt all-failed resurrect)', runner.includes('revisionFor') && runner.includes("'design_revision'"));
  ok('runner never drop-schema on revision', runner.includes('do not drop schema') && !/drop schema if exists/i.test(runner));
}

console.log(`\nrevise:check — ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
