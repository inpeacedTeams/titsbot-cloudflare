import test from 'node:test';
import assert from 'node:assert/strict';
import {mtMetrics} from '../src/core.mjs';
test('timeline has 30 finite observations and agrees with final score metrics',()=>{
  const events=[{t:0,kind:'insert',char:'а'},{t:999,kind:'insert',char:'x'},{t:1000,kind:'delete'},{t:1100,kind:'insert',char:'б'},{t:2000,kind:'delete'},{t:29999,kind:'insert',char:'б'}];
  const m=mtMetrics(events,'абв');
  assert.equal(m.timeline.length,30);
  assert.deepEqual(m.timeline[0],{second:1,wpm:12,raw_wpm:24,errors:1});
  assert.equal(m.timeline[1].wpm,12);
  assert.equal(m.timeline[1].errors,0);
  assert.equal(m.timeline[2].wpm,4);
  assert.equal(m.timeline.at(-1).wpm,m.wpm);
  assert.equal(m.timeline.at(-1).raw_wpm,m.raw_wpm);
  assert.equal(m.timeline.reduce((n,p)=>n+p.errors,0),m.errors);
  assert.ok(m.timeline.every(p=>Object.values(p).every(Number.isFinite)));
});
test('idle seconds are measured zero, not invented activity',()=>{
  const m=mtMetrics([],'абв');
  assert.equal(m.timeline.length,30);
  assert.ok(m.timeline.every(p=>p.wpm===0&&p.raw_wpm===0&&p.errors===0));
});
test('exact second boundaries belong to the next interval',()=>{
  const m=mtMetrics([{t:1000,kind:'insert',char:'а'}],'абв');
  assert.equal(m.timeline[0].wpm,0);
  assert.equal(m.timeline[1].wpm,6);
  assert.equal(m.timeline[29].wpm,m.wpm);
});
