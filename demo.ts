import { packet } from './examples/packet.ts';
import { runChecks } from './lib/checks.ts';
import { actorFor, applyAction, initialState } from './lib/workflow.ts';

const findings = runChecks(packet);
const finding = findings.find(item => item.checkType === 'duplicate_mileage');
if (!finding?.suggestedAdjustment) throw new Error('Expected a duplicate mileage adjustment');
const adjustment = finding.suggestedAdjustment;
const updated = applyAction(packet, findings, initialState(packet), actorFor(packet, 'preparer'), 'adjust', {
  targetId: adjustment.lineKey,
  newValue: adjustment.newValue,
  reason: 'The two source pages describe the same trip.',
});

console.log(JSON.stringify({
  finding: { title: finding.title, evidence: finding.evidence },
  adjustment: updated.adjustments[0],
  contentRevision: updated.contentRevision,
}, null, 2));
