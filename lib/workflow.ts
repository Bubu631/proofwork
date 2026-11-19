/* Pure domain transitions. Original packet is never mutated. Server owns actor and rates. */
export type Role = 'preparer' | 'reviewer' | 'partner' | 'firm_administrator' | 'quality_reviewer' | 'client';
export type Actor = { id: string; name: string; role: Role; sensitive_data_clearance?: boolean };
export type RecordValue = Record<string, any>;
export type WorkpaperState = {
  revision: number; contentRevision: number; baseVersion: string; adjustments: RecordValue[];
  issueResolutions: RecordValue; verifications: RecordValue; verificationBatches: RecordValue[]; supplementalRecords: RecordValue[]; notes: RecordValue[]; questions: RecordValue[];
  decisions: RecordValue[]; signoffs: RecordValue[]; tasks: RecordValue[]; timeEntries: RecordValue[];
  documentDisposition: RecordValue; checklist: RecordValue; standards: RecordValue;
  filing: { stage: string; cycle: number; snapshots: RecordValue[]; events: RecordValue[]; notices: RecordValue[]; extension: RecordValue | null; retentionUntil?: string };
  attachments: RecordValue[]; audit: RecordValue[]; savedScenarios: RecordValue[]; lastSeen: RecordValue; reviewCursors: RecordValue;
};
export class WorkflowError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_ACTION', public details?: unknown) { super(message); }
}
const editingRoles: Role[] = ['preparer', 'reviewer', 'partner'];
const reviewingRoles: Role[] = [...editingRoles, 'quality_reviewer'];
const staffRoles: Role[] = [...reviewingRoles, 'firm_administrator'];
const frozenStages = ['frozen', 'submitted', 'rejected', 'accepted'];
export const CAS_UPDATE_SQL = 'UPDATE engagements SET revision = ?, state_json = ?, last_event_id = ?, updated_at = ? WHERE id = ? AND revision = ?';
export const CAS_AUDIT_SQL = 'INSERT INTO audit_events (id, engagement_id, revision, actor_id, authenticated_user_id, action, event_json, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? FROM engagements WHERE id = ? AND revision = ? AND last_event_id = ?';
const clone = <T>(v: T): T => structuredClone(v);
const round = (n: number) => Math.round(n * 100) / 100 || 0;
function text(v: unknown, label: string, max = 4000): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new WorkflowError(`${label} is required (maximum ${max} characters).`);
  return v.trim();
}
function role(actor: Actor, allowed: Role[]) { if (!allowed.includes(actor.role)) throw new WorkflowError('This persona is not permitted to perform this action.', 403, 'ROLE_FORBIDDEN'); }
function writable(state: WorkpaperState) { if (frozenStages.includes(state.filing.stage)) throw new WorkflowError('This return is frozen. Start an amendment to change financial data or its evidence.', 409, 'RETURN_FROZEN'); }
function find<T extends RecordValue>(items: T[], id: unknown, label: string): T { const result = items.find(x => x.id === id); if (!result) throw new WorkflowError(`${label} was not found.`, 404, 'NOT_FOUND'); return result; }
function materialChange(state: WorkpaperState, why: string) {
  state.contentRevision++;
  for (const s of state.signoffs) if (s.status === 'valid') { s.status = 'invalidated'; s.invalidationReason = why; s.invalidatedAtContentRevision = state.contentRevision; }
}
export function actorsFor(packet: RecordValue): Actor[] { return [...packet.firm.staff, ...packet.firm.client_users]; }
export function actorFor(packet: RecordValue, id: string): Actor { return find(actorsFor(packet), id, 'Actor'); }
export function initialState(packet: RecordValue): WorkpaperState {
  const base = packet.return_versions.find((v: RecordValue) => v.version === 'v3') || packet.return_versions.at(-1);
  const disposition: RecordValue = {};
  for (const d of packet.documents) {
    const status = base.documents_superseded.includes(d.id) ? 'superseded' : base.documents_used.includes(d.id) ? 'used' : 'pending';
    disposition[d.id] = { status, replayOnly: Date.parse(d.received_at) > Date.parse(base.computed_at), reason: status === 'pending' ? '' : `Imported engine ${base.version} document manifest; requires human review.`, actorId: 'engine', at: base.computed_at };
  }
  return {
    revision: 0, contentRevision: 0, baseVersion: base.version, adjustments: [], issueResolutions: {}, verifications: {}, verificationBatches: [], supplementalRecords: [], notes: [], questions: [], decisions: [], signoffs: [],
    tasks: packet.firm.deadlines.slice(0, 4).map((d: RecordValue, i: number) => ({ id: `task-seed-${i}`, title: d.what, assignedTo: i < 2 ? 'st-03' : i === 2 ? 'st-01' : 'st-02', dueDate: d.date, status: 'open' })),
    timeEntries: [], documentDisposition: disposition, checklist: {}, standards: clone(packet.firm.starter_standards),
    filing: { stage: 'preparation', cycle: 1, snapshots: [], events: [], notices: [], extension: null }, attachments: [], audit: [], savedScenarios: [], lastSeen: {}, reviewCursors: {},
  };
}
function baseVersion(packet: RecordValue, state: WorkpaperState) { return packet.return_versions.find((v: RecordValue) => v.version === state.baseVersion); }
export function originalValue(packet: RecordValue, state: WorkpaperState, targetId: string): any {
  const source = packet.extracted_values.find((x: RecordValue) => x.id === targetId) || baseVersion(packet, state).lines.find((x: RecordValue) => x.key === targetId);
  if (!source) throw new WorkflowError('Unknown source field or return line.', 404, 'TARGET_NOT_FOUND');
  return source.value;
}
export function finalValue(packet: RecordValue, state: WorkpaperState, targetId: string): any {
  const adjustment = state.adjustments.filter(x => x.targetId === targetId && x.status === 'active').at(-1);
  return adjustment ? adjustment.newValue : originalValue(packet, state, targetId);
}
function categoryFor(targetId: string, requested: string | undefined, packet: RecordValue, state: WorkpaperState): { category: string; direction: number; estimated: boolean } {
  // Explicit money-line mappings prevent accepting caller-supplied sign/multiplier.
  if (/^SchC\.(8|9|10|11|12|13|14|15|16[ab]?|17|18|19|20[ab]?|21|22|23|24[ab]?|25|26|27[ab]?|28|30)(?:\.\d+)?$/.test(targetId)) return { category: 'schc_profit', direction: -1, estimated: true };
  if (/^SchC\.(1|3|5|6|7|29|31)$/.test(targetId)) return { category: 'schc_profit', direction: 1, estimated: true };
  if (/^SchC\.44/.test(targetId)) return { category: 'nonfinancial', direction: 0, estimated: false };
  if (/^SchA\./.test(targetId)) return { category: /^SchA\.(5|6|7)/.test(targetId) ? 'salt' : 'itemized', direction: 1, estimated: true };
  if (['F1040.25a', 'F1040.25b', 'F1040.25c', 'F1040.25d', 'F1040.26', 'F1040.31', 'F1040.33', 'F540NR.71', 'F540NR.72', 'F540NR.73', 'F540NR.78', 'F540NR.81', 'F540NR.82', 'F540NR.83', 'F540NR.84', 'F540NR.85', 'F540NR.91', 'Sch3.10'].includes(targetId)) return { category: 'payment', direction: 1, estimated: true };
  if (/^SchB\.[124]/.test(targetId) || targetId === 'F1040.2b') return { category: 'interest', direction: 1, estimated: true };
  if (['F1040.19', 'F1040.20', 'F1040.21', 'Sch3.1', 'Sch3.8', 'F8812.12', 'F2441.31', 'F540NR.39', 'ScheduleS.credit'].includes(targetId)) return { category: 'credit', direction: -1, estimated: true };
  if (['F1040.16', 'F1040.17', 'F1040.18', 'F1040.22', 'F1040.23', 'F1040.24', 'F540NR.40', 'F540NR.61', 'F540NR.64'].includes(targetId)) return { category: 'tax', direction: 1, estimated: true };
  if (targetId.startsWith('ev-')) return { category: 'nonfinancial', direction: 0, estimated: false };
  const rates = baseVersion(packet, state).tax_effect_rates;
  const category = requested || 'ordinary_income';
  if (category !== 'nonfinancial' && !rates[category]) throw new WorkflowError('Choose an available tax-effect category.');
  return { category, direction: 1, estimated: category !== 'nonfinancial' };
}
export function estimateEffect(packet: RecordValue, state: WorkpaperState, targetId: string, oldValue: any, newValue: any, requested?: string): RecordValue {
  const { category, direction, estimated } = categoryFor(targetId, requested, packet, state);
  const delta = typeof oldValue === 'number' && typeof newValue === 'number' ? newValue - oldValue : 0;
  if (category === 'payment') return { federal: targetId.startsWith('F540') ? 0 : -delta, california: targetId.startsWith('F540') ? -delta : 0, category, estimated, effectType: 'payment', basis: 'Dollar-for-dollar balance change; tax liability is unchanged.' };
  if (category === 'credit' || category === 'tax') { const california = targetId.startsWith('F540') || targetId.startsWith('ScheduleS.'); return { federal: california ? 0 : round(delta * direction), california: california ? round(delta * direction) : 0, category, estimated, effectType: 'tax', basis: 'Dollar-for-dollar isolated tax or credit sensitivity; limitations and interactions are not recomputed.' }; }
  const rates = baseVersion(packet, state).tax_effect_rates[category];
  const caRate = ['F8949.B.N1', 'F8949.B.N3'].includes(targetId) ? baseVersion(packet, state).tax_effect_rates.ca_source_income.california_per_dollar : targetId === 'F8949.E.N4' ? 0 : rates?.california_per_dollar;
  return { federal: rates ? round(delta * direction * rates.federal_per_dollar) : 0, california: rates ? round(delta * direction * caRate) : 0, category, estimated, effectType: 'tax', basis: rates ? 'Local estimate using supplied v3 marginal rates; not a tax-engine recomputation.' : 'Source/non-monetary edit: no automatic tax effect. Review dependent return lines separately.' };
}
export function financialSummary(packet: RecordValue, state: WorkpaperState) {
  const base = clone(baseVersion(packet, state).summary);
  const delta = { federal: 0, california: 0 };
  const taxDelta = { federal: 0, california: 0 };
  const paymentDelta = { federal: 0, california: 0 };
  for (const a of state.adjustments.filter(x => x.status === 'active')) for (const j of ['federal', 'california'] as const) {
    delta[j] += a.taxEffect[j] || 0;
    if (a.taxEffect.effectType === 'payment') paymentDelta[j] -= a.taxEffect[j] || 0; else taxDelta[j] += a.taxEffect[j] || 0;
  }
  const estimated = clone(base);
  for (const j of ['federal', 'california'] as const) {
    delta[j] = round(delta[j]); taxDelta[j] = round(taxDelta[j]); paymentDelta[j] = round(paymentDelta[j]);
    estimated[j].balance_due = round(base[j].balance_due + delta[j]);
    estimated[j].total_tax = round(base[j].total_tax + taxDelta[j]);
    estimated[j].payments = round(base[j].payments + paymentDelta[j]);
  }
  return { base, estimated, delta, taxDelta, paymentDelta, disclaimer: 'Estimated impact only. Supplied engine v3 remains immutable. Marginal estimates do not recompute interactions, AGI, phase-outs, penalties, or downstream lines. Source-only edits have no automatic tax impact; final filing requires a validated engine rerun.' };
}
function isValidSignoff(state: WorkpaperState, level: string, actorId?: string) { return state.signoffs.some(x => x.level === level && x.status === 'valid' && x.contentRevision === state.contentRevision && (!actorId || x.actorId === actorId)); }
export function filingGates(packet: RecordValue, findings: RecordValue[], state: WorkpaperState) {
  const blockers: string[] = [];
  const currentFindings = findings.filter(x => x.status !== 'historical' && !x.replayOnly && x.severity !== 'info');
  const unresolved = currentFindings.filter(x => state.issueResolutions[x.id]?.status !== 'resolved');
  if (unresolved.length) blockers.push(`${unresolved.length} current findings require documented resolution.`);
  const currentAt = Date.parse(baseVersion(packet, state).computed_at);
  const pending = packet.documents.filter((d: RecordValue) => !(Date.parse(d.received_at) > currentAt) && !['used', 'superseded', 'excluded'].includes(state.documentDisposition[d.id]?.status));
  if (pending.length) blockers.push(`${pending.length} documents need a disposition.`);
  const openNotes = state.notes.filter(x => x.status === 'open' && x.blocking);
  if (openNotes.length) blockers.push(`${openNotes.length} blocking review notes remain open.`);
  const questions = state.questions.filter(x => x.status !== 'evidence');
  if (questions.length) blockers.push(`${questions.length} client questions require reviewed evidence.`);
  const steps = (state.standards.required_steps || packet.firm.starter_standards.required_steps).filter((s: string) => !/sign-off|client approval/i.test(s));
  const incomplete = steps.filter((s: string) => !state.checklist[s]?.complete);
  if (incomplete.length) blockers.push(`${incomplete.length} required checklist steps are incomplete.`);
  for (const level of ['preparer', 'reviewer', 'partner']) if (!isValidSignoff(state, level)) blockers.push(`Current ${level} sign-off is required.`);
  for (const client of packet.firm.client_users) if (!isValidSignoff(state, 'client', client.id)) blockers.push(`Current e-file authorization from ${client.name} is required.`);
  return { blockers, canFreeze: blockers.length === 0, contentRevision: state.contentRevision };
}
export function resolveReference(packet: RecordValue, state: WorkpaperState, ref: string): any {
  const pointer = (root: any, path: string) => {
    let node = root;
    for (const segment of path.replace(/^\//, '').split('/').filter(Boolean)) {
      const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!node || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
      node = node[key];
    }
    return node;
  };
  const doc = /^doc:(D\d+)#page(\d+)$/.exec(ref);
  if (doc) return packet.documents.find((d: RecordValue) => d.id === doc[1])?.pages.find((p: RecordValue) => p.page === Number(doc[2]));
  if (/^D\d+$/.test(ref)) return packet.documents.find((d: RecordValue) => d.id === ref);
  if (/^(qa|msg|call)-/.test(ref)) return [...packet.client.questionnaire, ...packet.client.messages, ...packet.client.call_notes].find((x: RecordValue) => x.id === ref);
  if (ref.startsWith('py:/')) return pointer(packet.prior_years, ref.slice(3));
  if (ref.startsWith('agency:/')) return pointer(packet.tax_agency_records, ref.slice(7));
  if (ref.startsWith('household:')) return packet.household.people.find((x: RecordValue) => x.id === ref.slice(10));
  if (ref.startsWith('timeline:')) return packet.timeline.find((x: RecordValue) => x.id === ref.slice(9));
  if (ref.startsWith('asset:')) return [...baseVersion(packet, state).assets, ...(packet.prior_years.asset_records || [])].find((x: RecordValue) => x.asset_id === ref.slice(6));
  if (ref.startsWith('ref:param.')) return pointer(packet.engine_reference.parameters, ref.slice(10).replace(/\./g, '/'));
  if (ref.startsWith('ref:fx.')) return pointer(packet.engine_reference.parameters.fx, ref.slice(7).replace(/\./g, '/'));
  return packet.extracted_values.find((x: RecordValue) => x.id === ref) || baseVersion(packet, state).lines.find((x: RecordValue) => x.key === ref);
}
export function assertCurrentEvidence(packet: RecordValue, state: WorkpaperState, ref: string) {
  if (state.filing.cycle > 1) return; // Explicit amendment cycle enables the scripted later evidence.
  const baseline = Date.parse(baseVersion(packet, state).computed_at);
  const dates: number[] = [];
  const timestampKeys = new Set(['received_at', 'sent_at', 'answered_at', 'date', 'as_of', 'issued_at', 'computed_at']);
  const ownDates = (value: any) => { if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, v] of Object.entries(value)) if (timestampKeys.has(key) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) { const n = Date.parse(v); if (Number.isFinite(n)) dates.push(n); } };
  const nestedDates = (value: any) => { if (!value || typeof value !== 'object') return; ownDates(value); for (const v of Object.values(value)) if (v && typeof v === 'object') nestedDates(v); };
  const ev = packet.extracted_values.find((e: RecordValue) => e.id === ref);
  const docId = ev?.document_id || /^doc:(D\d+)/.exec(ref)?.[1] || (/^D\d+$/.test(ref) ? ref : undefined);
  if (docId) ownDates(packet.documents.find((d: RecordValue) => d.id === docId));
  else if (ref.startsWith('agency:/')) {
    let node: any = packet.tax_agency_records;
    for (const segment of ref.slice(8).split('/')) { ownDates(node); node = node?.[segment.replace(/~1/g, '/').replace(/~0/g, '~')]; }
    nestedDates(node);
  } else if (/^(qa-|msg-|call-|timeline:)/.test(ref)) nestedDates(resolveReference(packet, state, ref));
  if (dates.some(d => d > baseline)) throw new WorkflowError('This evidence was received after the current June 23 baseline. It is read-only until an explicit amendment/replay cycle is opened.', 409, 'FUTURE_EVIDENCE');
}
function validateTarget(packet: RecordValue, state: WorkpaperState, targetId: string) {
  if (typeof targetId !== 'string' || resolveReference(packet, state, targetId) === undefined) throw new WorkflowError('Evidence reference was not found.', 404, 'TARGET_NOT_FOUND');
  assertCurrentEvidence(packet, state, targetId);
}
function overlappingTargets(packet: RecordValue, state: WorkpaperState, targetId: string): string[] {
  const lines = baseVersion(packet, state).lines;
  const parents = new Map<string, string[]>();
  for (const l of lines) for (const child of [...(l.inputs || []), ...(l.sources || [])]) parents.set(child, [...(parents.get(child) || []), l.key]);
  const ancestors = (id: string) => { const seen = new Set<string>(); const todo = [id]; while (todo.length) { for (const p of parents.get(todo.pop()!) || []) if (!seen.has(p)) { seen.add(p); todo.push(p); } } return seen; };
  const thisAncestors = ancestors(targetId);
  return state.adjustments.filter(a => a.status === 'active' && a.targetId !== targetId && a.taxEffect.estimated && (thisAncestors.has(a.targetId) || ancestors(a.targetId).has(targetId))).map(a => a.targetId);
}
export function applyAction(packet: RecordValue, findings: RecordValue[], previous: WorkpaperState, actor: Actor, action: string, p: RecordValue = {}, at = new Date().toISOString(), eventId = crypto.randomUUID()): WorkpaperState {
  const state = clone(previous);
  state.verificationBatches ||= []; state.supplementalRecords ||= []; state.reviewCursors ||= {};
  const common = { actorId: actor.id, at };
  const id = (prefix: string) => `${prefix}-${eventId}`;
  const requireReason = () => text(p.reason, 'Reason');
  let summary = action;
  switch (action) {
    case 'adjust': {
      role(actor, editingRoles); writable(state);
      const targetId = text(p.targetId, 'Target', 100); const reason = requireReason();
      const targetSource = packet.extracted_values.find((v: RecordValue) => v.id === targetId);
      if (targetSource && /ssn|ip_pin|account_number|routing_number/i.test(targetSource.field) && !actor.sensitive_data_clearance) throw new WorkflowError('Sensitive field changes require clearance.', 403, 'SENSITIVE_FORBIDDEN');
      assertCurrentEvidence(packet, state, targetId);
      const original = originalValue(packet, state, targetId); const oldValue = finalValue(packet, state, targetId);
      if (p.newValue === undefined || p.newValue === null || (typeof original === 'number' && (typeof p.newValue !== 'number' || !Number.isFinite(p.newValue) || Math.abs(p.newValue) > 1e12))) throw new WorkflowError('A finite numeric value is required for this field.');
      if (typeof p.newValue !== 'string' && typeof p.newValue !== 'number' && typeof p.newValue !== 'boolean') throw new WorkflowError('New value must be text, number, or boolean.');
      if (typeof p.newValue === 'string' && p.newValue.length > 2000) throw new WorkflowError('Field value is too long.');
      if (p.newValue === oldValue) throw new WorkflowError('The new value is unchanged.');
      const taxEffect = estimateEffect(packet, state, targetId, oldValue, p.newValue, p.category);
      const conflicts = taxEffect.estimated ? overlappingTargets(packet, state, targetId) : [];
      if (conflicts.length) throw new WorkflowError('This change overlaps another estimated adjustment. Undo the overlapping line adjustment first to avoid counting the tax effect twice.', 409, 'OVERLAPPING_ADJUSTMENT', conflicts);
      state.adjustments.push({ id: id('adj'), targetId, originalValue: original, oldValue, newValue: p.newValue, reason, category: taxEffect.category, batchId: typeof p.batchId === 'string' ? p.batchId.slice(0, 100) : id('batch'), taxEffect, status: 'active', ...common });
      delete state.verifications[targetId];
      materialChange(state, `Adjustment to ${targetId}`); summary = `Adjusted ${targetId}: ${oldValue} → ${p.newValue}`; break;
    }
    case 'adjustment.undo': {
      role(actor, editingRoles); writable(state); const reason = requireReason();
      const latest = state.adjustments.filter(x => x.actorId === actor.id && x.status === 'active').at(-1);
      if (!latest || (p.batchId && p.batchId !== latest.batchId)) throw new WorkflowError('Only your latest active adjustment batch can be undone.', 409, 'UNDO_ORDER');
      const batch = state.adjustments.filter(x => x.batchId === latest.batchId && x.status === 'active');
      if (batch.some(x => x.actorId !== actor.id)) throw new WorkflowError('A batch containing another person’s work cannot be undone.', 403);
      for (const a of batch) {
        const later = state.adjustments.filter(x => x.targetId === a.targetId && x.status === 'active').at(-1);
        if (later?.batchId !== latest.batchId) throw new WorkflowError('Later work depends on this batch. Resolve it before undoing.', 409, 'UNDO_DEPENDENCY');
      }
      for (const a of batch) { a.status = 'undone'; a.undoneAt = at; a.undoReason = reason; delete state.verifications[a.targetId]; }
      materialChange(state, `Undid batch ${latest.batchId}`); summary = `Undid ${batch.length} adjustments`; break;
    }
    case 'verify.bulk': {
      role(actor, reviewingRoles); writable(state);
      if (!Array.isArray(p.targetIds) || !p.targetIds.length || p.targetIds.length > 500) throw new WorkflowError('Choose 1–500 fields to verify.');
      if (!state.standards.verification_types.includes(p.verificationType)) throw new WorkflowError('Unknown verification type.');
      const targetIds = [...new Set<string>(p.targetIds)]; const batchId = id('verification');
      const prior: RecordValue = {};
      for (const targetId of targetIds) {
        validateTarget(packet, state, targetId); prior[targetId] = state.verifications[targetId] ? clone(state.verifications[targetId]) : null;
        state.verifications[targetId] = { batchId, verificationType: p.verificationType, comment: String(p.comment || '').slice(0, 2000), contentRevision: state.contentRevision + 1, ...common };
      }
      state.verificationBatches.push({ id: batchId, batchId, targetIds, previous: prior, status: 'active', ...common });
      materialChange(state, 'Verification evidence changed'); summary = `Verified ${targetIds.length} fields`; break;
    }
    case 'verification.undo': {
      role(actor, reviewingRoles); writable(state); const reason = requireReason();
      const batch = state.verificationBatches.filter(b => b.actorId === actor.id && b.status === 'active').at(-1);
      if (!batch || (p.batchId && batch.id !== p.batchId)) throw new WorkflowError('Only your latest active verification batch can be undone.', 409, 'UNDO_ORDER');
      for (const targetId of batch.targetIds) if (state.verifications[targetId]?.batchId !== batch.id) throw new WorkflowError('A field in this batch was subsequently changed or verified. Undo cannot overwrite that later work.', 409, 'UNDO_DEPENDENCY');
      for (const targetId of batch.targetIds) {
        if (batch.previous[targetId] === null) delete state.verifications[targetId];
        else state.verifications[targetId] = { ...clone(batch.previous[targetId]), restoredAt: at, restoredBy: actor.id };
      }
      batch.status = 'undone'; batch.undoneAt = at; batch.undoReason = reason;
      materialChange(state, `Undid verification batch ${batch.id}`); summary = `Undid verification of ${batch.targetIds.length} fields`; break;
    }
    case 'supplemental.add': {
      role(actor, editingRoles); writable(state); const reason = requireReason();
      if (!['sale', 'source_field'].includes(p.kind)) throw new WorkflowError('Choose a sale or source-field record.');
      const document = find(packet.documents, p.documentId, 'Source document'); assertCurrentEvidence(packet, state, document.id);
      if (!Number.isInteger(p.page) || !document.pages.some((page: RecordValue) => page.page === p.page)) throw new WorkflowError('The source document page does not exist.', 404, 'TARGET_NOT_FOUND');
      const label = text(p.label, 'Record label', 300);
      const field = p.field ? text(p.field, 'Source field', 150) : undefined;
      if (p.kind === 'source_field' && !field) throw new WorkflowError('A source field name is required.');
      if (field && /ssn|ip_pin|account|routing/i.test(field) && !actor.sensitive_data_clearance) throw new WorkflowError('Sensitive source entries require clearance.', 403, 'SENSITIVE_FORBIDDEN');
      const relatedLine = p.relatedLine ? text(p.relatedLine, 'Related return line', 100) : undefined;
      if (relatedLine && !baseVersion(packet, state).lines.some((line: RecordValue) => line.key === relatedLine)) throw new WorkflowError('Related return line does not exist.', 404, 'TARGET_NOT_FOUND');
      const identity = (field || label).toLowerCase();
      if (state.supplementalRecords.some(r => r.status === 'active' && r.kind === p.kind && r.documentId === p.documentId && r.page === p.page && (r.field || r.label).toLowerCase() === identity)) throw new WorkflowError('This source item already has an active supplementary record. Undo it before entering a replacement.', 409, 'DUPLICATE_SUPPLEMENT');
      const record: RecordValue = { id: id('supplement'), kind: p.kind, documentId: p.documentId, page: p.page, sourceRef: `doc:${p.documentId}#page${p.page}`, label, ...(field ? { field } : {}), ...(relatedLine ? { relatedLine } : {}), reason, status: 'active', downstreamRecomputed: false, effectNotice: 'Reviewed source supplement only; engine lines and tax totals are not recomputed.', ...common };
      if (p.kind === 'sale') {
        if (![p.proceeds, p.basis].every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e12)) throw new WorkflowError('Sale proceeds and basis must be finite nonnegative amounts.');
        const holdingPeriod = p.holdingPeriod || 'unknown';
        if (!['short_term', 'long_term', 'unknown'].includes(holdingPeriod)) throw new WorkflowError('Unknown holding period.');
        record.proceeds = round(p.proceeds); record.basis = round(p.basis); record.gain = round(p.proceeds - p.basis); record.holdingPeriod = holdingPeriod;
      } else {
        if (!['number', 'string', 'boolean'].includes(typeof p.value) || (typeof p.value === 'number' && (!Number.isFinite(p.value) || Math.abs(p.value) > 1e12)) || (typeof p.value === 'string' && (!p.value.trim() || p.value.length > 2000))) throw new WorkflowError('A valid finite number, nonempty text, or boolean value is required.');
        record.value = p.value;
      }
      state.supplementalRecords.push(record);
      materialChange(state, `Supplementary source evidence added: ${label}`); summary = `Added source supplement: ${label}`; break;
    }
    case 'supplemental.undo': {
      role(actor, editingRoles); writable(state); const record = find(state.supplementalRecords, p.id, 'Supplementary record');
      if (record.actorId !== actor.id) throw new WorkflowError('Only the person who entered this supplementary record may undo it.', 403, 'UNDO_OWNER');
      if (record.status !== 'active') throw new WorkflowError('This supplementary record is already undone.', 409);
      record.status = 'undone'; record.undoneAt = at; record.undoReason = requireReason();
      materialChange(state, `Supplementary evidence removed: ${record.label}`); summary = `Undid source supplement: ${record.label}`; break;
    }
    case 'issue.resolve': case 'issue.reopen': {
      role(actor, reviewingRoles); writable(state); const finding = find(findings, p.issueId, 'Finding'); const reason = requireReason();
      if (action === 'issue.reopen') {
        state.issueResolutions[p.issueId] = { status: 'open', reason, ...common };
      } else {
        const evidenceRefs: string[] = Array.isArray(p.evidenceRefs) ? [...new Set<string>(p.evidenceRefs)] : [];
        if (evidenceRefs.length > 50) throw new WorkflowError('Choose no more than 50 evidence references.');
        for (const ref of evidenceRefs) validateTarget(packet, state, ref);
        const resolutionType = p.resolutionType || 'corrected';
        if (!['corrected', 'documented_exception'].includes(resolutionType)) throw new WorkflowError('Unknown resolution type.');
        const adjustmentIds = state.adjustments.filter(a => a.status === 'active' && finding.suggestedAdjustment?.lineKey === a.targetId && finalValue(packet, state, a.targetId) === finding.suggestedAdjustment?.newValue).map(a => a.id);
        const sourceRefs = (finding.evidence || []).map((e: RecordValue) => e.ref);
        const supplementalRecordIds = state.supplementalRecords.filter(r => r.status === 'active' && ((r.relatedLine && finding.affectedLines?.includes(r.relatedLine)) || sourceRefs.includes(r.sourceRef) || sourceRefs.some((ref: string) => packet.extracted_values.some((e: RecordValue) => e.id === ref && e.document_id === r.documentId && e.page === r.page)))).map(r => r.id);
        if (finding.kind === 'confirmed_error') {
          if (p.acknowledgeNoRerun !== true) throw new WorkflowError('Acknowledge that this review resolution does not rerun the tax engine or prove every downstream amount.', 400, 'ENGINE_LIMITATION_ACK_REQUIRED');
          if (resolutionType === 'documented_exception') {
            role(actor, ['reviewer', 'partner']);
            if (!evidenceRefs.length) throw new WorkflowError('A documented exception requires specific supporting evidence and a reviewer or partner rationale.', 400, 'RESOLUTION_EVIDENCE_REQUIRED');
          } else if (!adjustmentIds.length && !supplementalRecordIds.length) throw new WorkflowError('Record the matching correction or source supplement first, or ask a reviewer/partner to document an explicit exception.', 409, 'RESOLUTION_EVIDENCE_REQUIRED');
        } else if (!evidenceRefs.length) throw new WorkflowError('Record at least one valid evidence reference supporting this conclusion.', 400, 'RESOLUTION_EVIDENCE_REQUIRED');
        state.issueResolutions[p.issueId] = { status: 'resolved', reason, resolutionType, evidenceRefs, acknowledgeNoRerun: p.acknowledgeNoRerun === true, pendingEngineRerun: finding.kind === 'confirmed_error', resolutionBasis: { adjustmentIds, supplementalRecordIds }, resolutionLimitations: supplementalRecordIds.length ? 'A source supplement has been recorded. This does not establish full broker reconciliation or recompute dependent return lines.' : finding.kind === 'confirmed_error' ? 'Reviewed correction or exception only; full tax-engine interactions have not been recomputed.' : null, ...common };
      }
      materialChange(state, `Finding ${p.issueId} disposition changed`); summary = `${action === 'issue.resolve' ? 'Resolved' : 'Reopened'} ${p.issueId}`; break;
    }
    case 'note.add': {
      role(actor, reviewingRoles); const noteText = text(p.text, 'Note');
      state.notes.push({ id: id('note'), targetId: String(p.targetId || 'engagement').slice(0, 160), text: noteText, blocking: p.blocking !== false, status: 'open', ...common });
      // New blockers invalidate authorization even when the financial snapshot is frozen.
      if (p.blocking !== false) materialChange(state, 'New blocking review note'); summary = 'Added a review note'; break;
    }
    case 'note.resolve': {
      role(actor, reviewingRoles); const note = find(state.notes, p.noteId, 'Note');
      if (note.status === 'resolved') throw new WorkflowError('Note is already resolved.');
      note.status = 'resolved'; note.resolution = { reason: requireReason(), ...common };
      if (note.blocking) materialChange(state, 'Blocking review note resolved'); summary = 'Resolved a review note'; break;
    }
    case 'question.ask': {
      role(actor, reviewingRoles); writable(state); const assigned = p.assignedTo || 'cu-01';
      const recipient = actorFor(packet, assigned); if (recipient.role !== 'client') throw new WorkflowError('A client question must be assigned to a client.');
      state.questions.push({ id: id('question'), text: text(p.text, 'Question'), targetId: String(p.targetId || 'engagement').slice(0, 160), assignedTo: assigned, status: 'open', replies: [], ...common });
      materialChange(state, 'New unanswered client question'); summary = 'Requested client information'; break;
    }
    case 'question.reply': {
      role(actor, [...reviewingRoles, 'client']); const q = find(state.questions, p.questionId, 'Question');
      if (actor.role === 'client' && q.assignedTo !== actor.id) throw new WorkflowError('This question is assigned to the other client.', 403);
      q.replies.push({ id: id('reply'), text: text(p.text, 'Reply'), ...common }); q.status = 'answered';
      materialChange(state, 'New client response awaiting evidence review'); summary = 'Replied to a client question'; break;
    }
    case 'question.evidence': {
      role(actor, reviewingRoles); writable(state); const q = find(state.questions, p.questionId, 'Question');
      if (!q.replies.length) throw new WorkflowError('A response is required before converting the question to evidence.');
      q.status = 'evidence'; q.evidenceReason = requireReason(); q.reviewedBy = actor.id; q.reviewedAt = at;
      materialChange(state, 'Client response promoted to evidence'); summary = 'Promoted client response to evidence'; break;
    }
    case 'decision.add': {
      role(actor, reviewingRoles); const targetId = String(p.targetId || 'engagement').slice(0, 160);
      if (!targetId.startsWith('notice:') && !targetId.startsWith('planning:')) writable(state);
      state.decisions.push({ id: id('decision'), targetId, text: text(p.text, 'Decision'), authority: text(p.authority, 'Authority relied upon'), ...common });
      if (!targetId.startsWith('notice:') && !targetId.startsWith('planning:')) materialChange(state, 'Professional judgment recorded'); summary = 'Recorded a judgment and authority'; break;
    }
    case 'signoff': {
      const level = text(p.level, 'Sign-off level', 20);
      if (!['preparer', 'reviewer', 'partner', 'client'].includes(level) || actor.role !== level) throw new WorkflowError('A persona may sign only its own review level.', 403, 'SIGNOFF_ROLE');
      if (isValidSignoff(state, level, level === 'client' ? actor.id : undefined)) throw new WorkflowError('This level is already signed for the current workpaper.', 409);
      if (state.notes.some(x => x.blocking && x.status === 'open')) throw new WorkflowError('Resolve blocking review notes before signing.', 409, 'SIGNOFF_BLOCKED');
      if (['reviewer', 'partner'].includes(level) && [...state.adjustments, ...state.supplementalRecords].some(x => x.status === 'active' && x.actorId === actor.id)) throw new WorkflowError('You cannot review or sign off on financial work you prepared.', 403, 'SELF_REVIEW');
      const preceding = level === 'reviewer' ? 'preparer' : level === 'partner' ? 'reviewer' : level === 'client' ? 'partner' : null;
      if (preceding && !isValidSignoff(state, preceding)) throw new WorkflowError(`Current ${preceding} sign-off is required first.`, 409, 'SIGNOFF_ORDER');
      state.signoffs.push({ id: id('signoff'), level, comment: String(p.comment || '').slice(0, 2000), contentRevision: state.contentRevision, status: 'valid', ...common });
      summary = `${actor.name} signed as ${level}`; break;
    }
    case 'task.add': {
      role(actor, staffRoles); actorFor(packet, text(p.assignedTo, 'Assignee', 30));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate || '')) throw new WorkflowError('A due date is required (YYYY-MM-DD).');
      state.tasks.push({ id: id('task'), title: text(p.title, 'Task title', 300), assignedTo: p.assignedTo, dueDate: p.dueDate, status: 'open', ...common }); summary = 'Assigned a task'; break;
    }
    case 'task.update': {
      role(actor, staffRoles); const task = find(state.tasks, p.taskId, 'Task');
      if (!['open', 'in_progress', 'done'].includes(p.status)) throw new WorkflowError('Unknown task status.');
      task.status = p.status; if (p.assignedTo) { actorFor(packet, p.assignedTo); task.assignedTo = p.assignedTo; }
      if (p.dueDate) { if (!/^\d{4}-\d{2}-\d{2}$/.test(p.dueDate)) throw new WorkflowError('Invalid due date.'); task.dueDate = p.dueDate; }
      task.updatedBy = actor.id; task.updatedAt = at; summary = `Task marked ${p.status}`; break;
    }
    case 'time.add': {
      role(actor, staffRoles); if (typeof p.hours !== 'number' || !Number.isFinite(p.hours) || p.hours <= 0 || p.hours > 24) throw new WorkflowError('Hours must be between 0 and 24.');
      const budgets = { ...packet.firm.budget_hours, ...(state.standards.budget_hours || {}) };
      if (!(p.category in budgets)) throw new WorkflowError('Unknown budget category.');
      state.timeEntries.push({ id: id('time'), category: p.category, hours: round(p.hours), description: text(p.description, 'Time description', 1000), ...common }); summary = `Logged ${p.hours} hours`; break;
    }
    case 'standards.update': {
      role(actor, ['firm_administrator']); writable(state);
      const s = p.standards;
      if (!s || !Array.isArray(s.verification_types) || !s.verification_types.length || !Array.isArray(s.required_steps) || !s.required_steps.length || !Array.isArray(s.rules)) throw new WorkflowError('Standards require verification_types, required_steps, and rules arrays.');
      if (s.budget_hours && Object.values(s.budget_hours).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000)) throw new WorkflowError('Budgets must be finite nonnegative hours.');
      if (s.variance_review && [s.variance_review.flag_if_change_over_percent, s.variance_review.and_over_amount].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new WorkflowError('Variance thresholds must be finite nonnegative numbers.');
      if (JSON.stringify(s).length > 20000 || [...s.verification_types, ...s.required_steps, ...s.rules].some(x => typeof x !== 'string' || x.length > 1000)) throw new WorkflowError('Invalid standards text.');
      // Platform invariants (self-review, audit, sensitive access, immutable filing) cannot be disabled here.
      state.standards = clone(s); materialChange(state, 'Firm standards changed'); summary = 'Updated firm standards'; break;
    }
    case 'document.disposition': {
      role(actor, editingRoles); writable(state); find(packet.documents, p.documentId, 'Document'); assertCurrentEvidence(packet, state, p.documentId);
      if (!['used', 'superseded', 'excluded'].includes(p.status)) throw new WorkflowError('Unknown document disposition.');
      state.documentDisposition[p.documentId] = { status: p.status, reason: requireReason(), ...common };
      materialChange(state, `Document ${p.documentId} disposition changed`); summary = `${p.documentId} marked ${p.status}`; break;
    }
    case 'checklist.set': {
      role(actor, editingRoles); writable(state);
      if (!state.standards.required_steps.includes(p.step)) throw new WorkflowError('Unknown checklist step.');
      if (/sign-off|client approval/i.test(p.step)) throw new WorkflowError('This step is derived from signed approvals; use the sign-off action.');
      state.checklist[p.step] = { complete: p.complete === true, evidence: text(p.evidence, 'Evidence / reason'), ...common };
      materialChange(state, 'Required checklist evidence changed'); summary = `Checklist: ${p.step}`; break;
    }
    case 'scenario.save': {
      role(actor, reviewingRoles); const scenario = p.scenarioId ? packet.what_if.alternatives.find((x: RecordValue) => x.id === p.scenarioId) : null;
      if (p.scenarioId && !scenario) throw new WorkflowError('Unknown supplied scenario.');
      if (!scenario && (!Number.isFinite(p.estimatedFederal) || !Number.isFinite(p.estimatedCalifornia))) throw new WorkflowError('A supplied scenario or finite custom federal/state estimates are required.');
      state.savedScenarios.push({ id: id('scenario'), scenarioId: scenario?.id || null, name: String(p.name || scenario?.description || 'Custom estimate').slice(0, 500), assumptions: String(p.assumptions || '').slice(0, 4000), estimatedFederal: scenario ? scenario.federal.total_tax_change : p.estimatedFederal, estimatedCalifornia: scenario ? scenario.california.total_tax_change : p.estimatedCalifornia, baseVersion: state.baseVersion, contentRevision: state.contentRevision, standalone: true, ...common }); summary = 'Saved a scenario comparison'; break;
    }
    case 'lifecycle': {
      const transition = text(p.transition, 'Transition', 20); const reason = requireReason();
      role(actor, transition === 'extension' ? editingRoles : transition === 'notice' ? ['reviewer', 'partner', 'quality_reviewer'] : ['partner']);
      const event = { id: id('filing'), transition, reason, reference: String(p.reference || '').slice(0, 300), simulated: true, ...common };
      if (transition === 'extension') {
        if (!['preparation', 'extended'].includes(state.filing.stage)) throw new WorkflowError('Extension is available only before the return is frozen.', 409);
        state.filing.extension = { ...event, dueDate: '2026-10-15', paymentDueDate: '2026-04-15', warning: 'Extension extends filing time only. Original payment deadline remains April 15, 2026.', calculation: clone(packet.what_if.extension) }; state.filing.stage = 'extended';
      } else if (transition === 'freeze') {
        if (!['preparation', 'extended', 'amendment'].includes(state.filing.stage)) throw new WorkflowError('Only a working return can be frozen.', 409);
        const gates = filingGates(packet, findings, state); if (!gates.canFreeze) throw new WorkflowError('Filing readiness gates are not complete.', 409, 'FILING_BLOCKED', gates.blockers);
        const snapshot = { id: id('snapshot'), cycle: state.filing.cycle, contentRevision: state.contentRevision, baseVersion: state.baseVersion, summary: financialSummary(packet, state), attachments: clone(state.attachments), adjustments: clone(state.adjustments), documentDisposition: clone(state.documentDisposition), signoffs: clone(state.signoffs), checklist: clone(state.checklist), issueResolutions: clone(state.issueResolutions), verifications: clone(state.verifications), verificationBatches: clone(state.verificationBatches), supplementalRecords: clone(state.supplementalRecords), decisions: clone(state.decisions), notes: clone(state.notes), questions: clone(state.questions), ...common };
        state.filing.snapshots.push(snapshot); state.filing.stage = 'frozen';
      } else if (transition === 'submit') {
        if (!['frozen', 'rejected'].includes(state.filing.stage)) throw new WorkflowError('Freeze the return before simulated submission.', 409);
        const snapshot = state.filing.snapshots.at(-1); if (!snapshot || snapshot.contentRevision !== state.contentRevision || !filingGates(packet, findings, state).canFreeze) throw new WorkflowError('The frozen approvals no longer match the current workpaper. Reopen through an amendment and review.', 409, 'STALE_FROZEN_VERSION');
        state.filing.stage = 'submitted';
      } else if (transition === 'reject' || transition === 'accept') {
        if (state.filing.stage !== 'submitted') throw new WorkflowError('A simulated agency response requires a submitted return.', 409);
        state.filing.stage = transition === 'reject' ? 'rejected' : 'accepted';
        if (transition === 'accept') { const year = new Date(at).getUTCFullYear() + 7; state.filing.retentionUntil = `${year}${at.slice(4, 10)}`; }
      } else if (transition === 'amend') {
        if (!frozenStages.includes(state.filing.stage)) throw new WorkflowError('An amendment requires a previously frozen return.', 409);
        state.filing.cycle++; state.filing.stage = 'amendment'; materialChange(state, `Started amendment cycle ${state.filing.cycle}`);
      } else if (transition === 'notice') {
        if (!state.filing.snapshots.length) throw new WorkflowError('A notice response requires a retained filing snapshot.', 409);
        state.filing.notices.push({ ...event, response: String(p.response || '').slice(0, 10000), snapshotId: state.filing.snapshots.at(-1)?.id });
      } else throw new WorkflowError('Unknown lifecycle transition.');
      state.filing.events.push(event); summary = `Simulated filing: ${transition}`; break;
    }
    case 'document.view': {
      if (p.documentId) find(packet.documents, p.documentId, 'Document'); summary = `Viewed masked evidence ${String(p.documentId || '').slice(0, 50)}`; break;
    }
    case 'sensitive.reveal': {
      if (!actor.sensitive_data_clearance || actor.role === 'client') throw new WorkflowError('This persona has no clearance to reveal sensitive data.', 403, 'SENSITIVE_FORBIDDEN');
      if (p.documentId) find(packet.documents, p.documentId, 'Document'); requireReason(); summary = `Revealed sensitive evidence ${String(p.documentId || 'engagement').slice(0, 50)}`; break;
    }
    case 'attachment.add': {
      role(actor, [...staffRoles, 'client']); writable(state);
      if (!p._serverValidated) throw new WorkflowError('Attachments must use the upload endpoint.', 400);
      state.attachments.push({ id: p.id, name: p.name, contentType: p.contentType, sha256: p.sha256 || null, size: p.size, description: String(p.description || '').slice(0, 2000), storageKey: p.storageKey, ...common });
      materialChange(state, 'New uploaded evidence'); summary = `Uploaded evidence: ${p.name}`; break;
    }
    case 'attachment.download': { summary = `Downloaded original attachment ${String(p.attachmentId || '').slice(0, 80)}`; break; }
    case 'export': { summary = 'Exported sanitized workpaper record'; break; }
    case 'activity.mark_read': { state.reviewCursors[actor.id] = { revision: previous.revision + 1, at }; summary = 'Marked engagement activity as reviewed'; break; }
    case 'presence': { state.lastSeen[actor.id] = { at, revision: state.revision }; break; }
    default: throw new WorkflowError('Unknown action.');
  }
  if (['adjust', 'adjustment.undo', 'supplemental.undo'].includes(action)) {
    for (const [findingId, resolution] of Object.entries(state.issueResolutions)) {
      if (resolution.status !== 'resolved' || resolution.resolutionType !== 'corrected') continue;
      const basis = resolution.resolutionBasis || {};
      const finding = findings.find(f => f.id === findingId);
      const adjustmentChanged = (basis.adjustmentIds || []).some((adjustmentId: string) => {
        const a = state.adjustments.find(x => x.id === adjustmentId);
        return !a || a.status !== 'active' || (finding?.suggestedAdjustment && finalValue(packet, state, a.targetId) !== finding.suggestedAdjustment.newValue);
      });
      const supplementChanged = (basis.supplementalRecordIds || []).some((recordId: string) => !state.supplementalRecords.some(r => r.id === recordId && r.status === 'active'));
      if (adjustmentChanged || supplementChanged) { resolution.status = 'open'; resolution.reopenedAt = at; resolution.reopenReason = 'Supporting correction or supplementary evidence changed; review this conclusion again.'; }
    }
  }
  state.revision = previous.revision + 1;
  state.lastSeen[actor.id] = { at, revision: state.revision };
  // Store intent and result; source data never overwritten. Append-only D1 journal is the authoritative audit.
  const auditPayload = clone(p); delete auditPayload._serverValidated; delete auditPayload.storageKey;
  state.audit.push({ id: eventId, action, actorId: actor.id, actorName: actor.name, at, revision: state.revision, contentRevision: state.contentRevision, summary, payload: auditPayload });
  return state;
}

// Known sensitive values are collected before masking, then replaced in all prose too.
// This protects printed_content, text_as_read, descriptions, and deeply nested histories.
export function maskSensitive<T>(value: T, packet: RecordValue): T {
  const secrets = new Set<string>();
  const keyPattern = /(^|_)(ssn|tin|ip_pin|ero_pin|routing_number|account_number|bank_account|identity_protection_pin|efin)(_|$)|^(account|routing)$/i;
  const sensitiveIds = new Set(packet.extracted_values.filter((e: RecordValue) => /ssn|ip_pin|account_number|routing_number/i.test(e.field)).map((e: RecordValue) => e.id));
  const collect = (v: any, parent = '') => {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(x => collect(x, parent)); return; }
    if (typeof v === 'object') {
      if (sensitiveIds.has(v.targetId)) for (const field of ['newValue', 'oldValue', 'originalValue']) if (v[field] != null) secrets.add(String(v[field]));
      if (typeof v.field === 'string' && /ssn|ip_pin|account_number|routing_number/i.test(v.field)) { if (v.value != null) secrets.add(String(v.value)); if (v.text_as_read != null) secrets.add(String(v.text_as_read)); }
      for (const [k, x] of Object.entries(v)) { if (keyPattern.test(k) && (typeof x === 'string' || typeof x === 'number') && String(x).length >= 4) secrets.add(String(x)); collect(x, k); }
    } else if (keyPattern.test(parent) && String(v).length >= 4) secrets.add(String(v));
  };
  collect(packet); collect(value);
  const ordered = [...secrets].filter(x => x.length >= 4).sort((a, b) => b.length - a.length);
  const maskString = (s: string) => {
    let result = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '•••-••-••••');
    for (const secret of ordered) result = result.split(secret).join('[MASKED]');
    // Labels in attached/freeform text: don't rely exclusively on structured key names.
    result = result.replace(/((?:account|routing|IP PIN|ERO PIN|SSN|TIN)\s*(?:number|no\.|#)?\s*[:=]?\s*)([A-Z]{0,2}[\d][\d -]{4,}\d)/gi, '$1[MASKED]');
    return result;
  };
  const walk = (v: any, key = ''): any => {
    if (v == null) return v;
    if (Array.isArray(v)) return v.map(x => walk(x, key));
    if (typeof v === 'object') {
      const output: RecordValue = {};
      const sensitiveField = typeof v.field === 'string' && /ssn|ip_pin|account_number|routing_number/i.test(v.field);
      for (const [k, x] of Object.entries(v)) output[k] = sensitiveField && ['value', 'text_as_read'].includes(k) ? '[MASKED]' : walk(x, k);
      return output;
    }
    if (keyPattern.test(key) && (typeof v === 'string' || typeof v === 'number')) return '[MASKED]';
    if (typeof v === 'string') return maskString(v);
    if (typeof v === 'number' && secrets.has(String(v))) return '[MASKED]';
    return v;
  };
  return walk(value);
}

export const MAX_EXPORT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export function attachmentExportPlan(attachments: RecordValue[], actor: Actor, mode: string = 'embedded') {
  if (!['embedded', 'metadata'].includes(mode)) throw new WorkflowError('Attachment mode must be embedded or metadata.');
  if (mode === 'metadata') return { mode: 'metadata_only', complete: attachments.length === 0, totalBytes: 0, reason: attachments.length ? 'Original attachment bytes deliberately excluded; this export is not a complete evidence archive.' : 'No uploaded attachments.' };
  let totalBytes = 0;
  for (const a of attachments) {
    if (!actor.sensitive_data_clearance && !(actor.role === 'client' && a.actorId === actor.id)) throw new WorkflowError('A complete export includes original unmasked attachments. This persona needs clearance or ownership of every attachment. Choose attachments=metadata for a clearly marked sanitized record.', 403, 'EXPORT_ATTACHMENT_CLEARANCE', { attachmentId: a.id });
    if (!['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'application/octet-stream'].includes(a.contentType)) throw new WorkflowError('An attachment has an unsupported type; complete export stopped.', 409, 'EXPORT_ATTACHMENT_TYPE', { attachmentId: a.id });
    if (!Number.isFinite(a.size) || a.size < 0) throw new WorkflowError('Attachment size metadata is invalid; complete export stopped.', 409, 'EXPORT_ATTACHMENT_SIZE', { attachmentId: a.id });
    totalBytes += a.size;
  }
  if (totalBytes > MAX_EXPORT_ATTACHMENT_BYTES) throw new WorkflowError('Original attachments exceed the 25 MB portable-export limit. Download originals individually or explicitly choose attachments=metadata; no attachment was silently omitted.', 409, 'EXPORT_SIZE_LIMIT', { totalBytes, limitBytes: MAX_EXPORT_ATTACHMENT_BYTES });
  return { mode: 'embedded', complete: true, totalBytes, reason: 'All original attachment bytes are embedded. These binaries are unredacted and may contain sensitive data.' };
}
