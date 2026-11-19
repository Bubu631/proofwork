import assert from 'node:assert/strict';
import { test } from 'node:test';
import { packet } from './examples/packet.ts';
import { runChecks } from './lib/checks.ts';
import { actorFor, applyAction, initialState } from './lib/workflow.ts';

test('duplicate scan links both pages and preserves the original value', () => {
  const findings = runChecks(packet);
  const finding = findings.find(item => item.checkType === 'duplicate_mileage');
  assert(finding?.suggestedAdjustment);
  assert.equal(finding.suggestedAdjustment.newValue, 44);
  assert.deepEqual(finding.evidence.map(item => item.ref), ['doc:D900#page1', 'doc:D900#page2', 'VAL-B']);

  const before = initialState(packet);
  const after = applyAction(packet, findings, before, actorFor(packet, 'preparer'), 'adjust', {
    targetId: 'SchC.9', newValue: 44, reason: 'Duplicate scan confirmed.',
  });
  assert.equal(after.adjustments[0].originalValue, 88);
  assert.equal(after.adjustments[0].newValue, 44);
  assert.equal(after.contentRevision, before.contentRevision + 1);
  assert.deepEqual(before.adjustments, []);
});

test('equal page totals with distinct source text do not establish duplication', () => {
  const distinct = structuredClone(packet);
  distinct.documents[0].pages[1].printed_content = 'A different service trip. Page total: 88 miles.';
  assert(!runChecks(distinct).some(item => item.checkType === 'duplicate_mileage'));
});

test('browser state preserves an adjustment across local serialization', async () => {
  const { applyPublicDemoAction, publicDemoRecord, restorePublicDemoState, serializePublicDemoState }
    = await import('./lib/public-demo.ts');
  const seed = { packet, findings: [] };
  const after = await applyPublicDemoAction(seed, initialState(packet), 'preparer', 'adjust', {
    targetId: 'SchC.9', newValue: 44, reason: 'Matched the duplicate scan.',
  });
  const restored = restorePublicDemoState(serializePublicDemoState(after), seed);
  assert.equal(restored.adjustments[0].newValue, 44);
  assert.equal(publicDemoRecord(seed, restored, 'reviewer').actor.role, 'reviewer');
});
