import { z } from 'zod';
import { mergeFindings, runChecks, type Finding } from './checks.ts';
import { actorFor, actorsFor, applyAction, filingGates, financialSummary, initialState, maskSensitive, WorkflowError, type RecordValue, type WorkpaperState } from './workflow.ts';

/** A masked, canonical seed; never use a client-persona response as this seed. */
export type PublicDemoSeed = { packet: RecordValue; findings: Finding[] };

function findingsFor(seed: PublicDemoSeed, state: WorkpaperState) {
  return mergeFindings(seed.findings, runChecks({ ...seed.packet, firm: { ...seed.packet.firm, starter_standards: state.standards } }));
}
function guestActor(seed: PublicDemoSeed, actorId: string) {
  return { ...actorFor(seed.packet, actorId), sensitive_data_clearance: false };
}

/** Derive a view without changing the canonical browser state or original packet. */
export function publicDemoRecord(seed: PublicDemoSeed, state: WorkpaperState, actorId: string) {
  const { packet } = seed;
  const actor = guestActor(seed, actorId);
  const findings = findingsFor(seed, state);
  const record = maskSensitive({ packet, findings, state, actors: actorsFor(packet).map(a => ({ ...a, sensitive_data_clearance: false })), actor, revision: state.revision, gates: filingGates(packet, findings, state), financials: financialSummary(packet, state), publicDemo: true }, packet);
  // Even a locally edited storage record must not expose server storage identifiers.
  const stripAttachmentKeys = (items: RecordValue[]) => items.map(({ storageKey: _key, ...metadata }) => metadata);
  record.state.attachments = stripAttachmentKeys(record.state.attachments);
  for (const snapshot of record.state.filing.snapshots) if (snapshot.attachments) snapshot.attachments = stripAttachmentKeys(snapshot.attachments);
  for (const entry of record.state.audit) delete entry.authenticatedUserId;
  record.packet.firm.staff = record.packet.firm.staff.map((a: RecordValue) => ({ ...a, sensitive_data_clearance: false }));
  record.packet.firm.client_users = record.packet.firm.client_users.map((a: RecordValue) => ({ ...a, sensitive_data_clearance: false }));
  if (actor.role === 'client') {
    record.state.notes = []; record.state.timeEntries = []; record.state.audit = [];
    record.state.questions = record.state.questions.filter(q => q.assignedTo === actor.id);
    record.state.tasks = []; record.state.lastSeen = {}; record.state.verificationBatches = [];
    record.state.reviewCursors = record.state.reviewCursors[actor.id] ? { [actor.id]: record.state.reviewCursors[actor.id] } : {};
    record.state.standards = { required_steps: [], verification_types: [], rules: [], budget_hours: {} };
    record.state.filing.snapshots = record.state.filing.snapshots.map(s => ({ id: s.id, cycle: s.cycle, contentRevision: s.contentRevision, baseVersion: s.baseVersion, summary: s.summary, attachments: s.attachments || [], signoffs: s.signoffs, at: s.at, hash: s.hash }));
    record.packet.firm = { name: packet.firm.name, client_users: record.packet.firm.client_users, staff: record.actors.filter(a => a.role !== 'client').map(({ id, name, role }) => ({ id, name, role })), deadlines: record.packet.firm.deadlines, starter_standards: { required_steps: [] }, budget_hours: {} };
  }
  return record;
}

/** Returns canonical local state, not the role-filtered UI response. No network/storage writes. */
export async function applyPublicDemoAction(seed: PublicDemoSeed, state: WorkpaperState, actorId: string, action: string, payload: RecordValue = {}): Promise<WorkpaperState> {
  if (['sensitive.reveal', 'attachment.add', 'attachment.download'].includes(action)) throw new WorkflowError('This action is unavailable in the public demo. Sensitive originals and server attachments are never included.', 403, 'PUBLIC_DEMO_FORBIDDEN');
  const next = applyAction(seed.packet, findingsFor(seed, state), state, guestActor(seed, actorId), action, payload);
  if (next.filing.snapshots.length > state.filing.snapshots.length) {
    const snapshot = next.filing.snapshots.at(-1)!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(snapshot)));
    snapshot.hash = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  return next;
}

// Local storage is untrusted. Validate every collection and nested shape used by
// domain transitions or UI rendering; reject the entire record instead of merging
// partial broken state. This is resilience, not an identity/security boundary.
const text = z.string().max(20000);
const id = z.string().min(1).max(300);
const finite = z.number().finite();
const revision = finite.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const scalar = z.union([text, finite, z.boolean()]);
const strings = z.array(text).max(10000);
const common = { actorId: id, at: text };
const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const undoFields = { undoReason: text.optional(), undoneReason: text.optional(), undo: object({ reason: text }).optional() };
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).max(10000);
const effect = object({ federal: finite, california: finite, category: text, estimated: z.boolean(), effectType: z.enum(['tax', 'payment']), basis: text });
const adjustment = object({ id, targetId: id, originalValue: scalar, oldValue: scalar, newValue: scalar, reason: text, category: text, batchId: id, taxEffect: effect, status: z.enum(['active', 'undone']), ...undoFields, ...common });
const verification = object({ verificationType: text, comment: text, contentRevision: revision, batchId: id.optional(), ...common });
const verificationBatch = object({ id, batchId: id, targetIds: strings, previous: z.record(verification.nullable()), status: z.enum(['active', 'undone']), ...common });
const supplement = object({ id, kind: z.enum(['sale', 'source_field']), documentId: id, page: finite.int().positive(), sourceRef: text, label: text, field: text.optional(), relatedLine: text.optional(), reason: text, status: z.enum(['active', 'undone']), downstreamRecomputed: z.literal(false), ...undoFields, ...common,
  proceeds: finite.optional(), basis: finite.optional(), gain: finite.optional(), holdingPeriod: z.enum(['short_term', 'long_term', 'unknown']).optional(), value: scalar.optional(),
}).superRefine((v, ctx) => { if (v.kind === 'sale' ? ![v.proceeds, v.basis, v.gain].every(n => typeof n === 'number') : !v.field || v.value === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Incomplete supplemental record' }); });
const resolution = object({ status: z.enum(['open', 'resolved']), reason: text, ...common,
  resolutionType: z.enum(['corrected', 'documented_exception']).optional(), evidenceRefs: strings.optional(),
  resolutionLimitations: text.nullable().optional(),
  resolutionBasis: object({ adjustmentIds: strings, supplementalRecordIds: strings }).optional(),
});
const note = object({ id, targetId: text, text, blocking: z.boolean(), status: z.enum(['open', 'resolved']), ...common, resolution: object({ reason: text, ...common }).optional() });
const question = object({ id, text, targetId: text, assignedTo: id, status: z.enum(['open', 'answered', 'evidence']), replies: list(object({ id, text, ...common })), evidenceReason: text.optional(), ...common });
const decision = object({ id, targetId: text, text, authority: text, ...common });
const signoff = object({ id, level: z.enum(['preparer', 'reviewer', 'partner', 'client']), comment: text, contentRevision: revision, status: z.enum(['valid', 'invalidated']), ...common });
const disposition = object({ status: z.enum(['pending', 'used', 'superseded', 'excluded']), reason: text, replayOnly: z.boolean().optional(), ...common });
const checklistItem = object({ complete: z.boolean(), evidence: text, ...common });
const jurisdiction = z.record(finite);
const summary = object({ base: object({ federal: jurisdiction, california: jurisdiction }), estimated: object({ federal: jurisdiction, california: jurisdiction }), delta: object({ federal: finite, california: finite }), disclaimer: text });
const snapshot = object({ id, cycle: revision.min(1), contentRevision: revision, baseVersion: id, hash: z.string().regex(/^[a-f0-9]{64}$/), summary, attachments: z.array(z.never()), adjustments: list(adjustment), documentDisposition: z.record(disposition), signoffs: list(signoff), checklist: z.record(checklistItem), issueResolutions: z.record(resolution), verifications: z.record(verification), verificationBatches: list(verificationBatch), supplementalRecords: list(supplement), decisions: list(decision), notes: list(note), questions: list(question), ...common });
const filingEvent = object({ id, transition: text, reason: text, reference: text, simulated: z.literal(true), ...common });
const cursor = object({ revision, at: text });
const stateSchema = object({
  revision, contentRevision: revision, baseVersion: id, adjustments: list(adjustment), issueResolutions: z.record(resolution), verifications: z.record(verification), verificationBatches: list(verificationBatch), supplementalRecords: list(supplement), notes: list(note), questions: list(question), decisions: list(decision), signoffs: list(signoff),
  tasks: list(object({ id, title: text, assignedTo: id, dueDate: text, status: z.enum(['open', 'in_progress', 'done']) })),
  timeEntries: list(object({ id, category: text, hours: finite.positive().max(24), description: text, ...common })),
  documentDisposition: z.record(disposition), checklist: z.record(checklistItem),
  standards: object({ verification_types: strings.min(1), required_steps: strings.min(1), rules: strings, review_levels: strings.optional(), budget_hours: z.record(finite.nonnegative().max(10000)).optional(), variance_review: object({ flag_if_change_over_percent: finite.nonnegative(), and_over_amount: finite.nonnegative() }).optional() }),
  filing: object({ stage: z.enum(['preparation', 'extended', 'frozen', 'submitted', 'rejected', 'accepted', 'amendment']), cycle: revision.min(1), snapshots: list(snapshot), events: list(filingEvent), notices: list(filingEvent.extend({ response: text, snapshotId: id })), extension: filingEvent.nullable(), retentionUntil: text.optional() }),
  attachments: z.array(z.never()),
  audit: list(object({ id, action: text, actorId: id, actorName: text, at: text, revision, contentRevision: revision, summary: text, payload: z.record(z.unknown()) })),
  savedScenarios: list(object({ id, scenarioId: id.nullable(), name: text, assumptions: text, estimatedFederal: finite, estimatedCalifornia: finite, baseVersion: id, contentRevision: revision, standalone: z.literal(true), ...common })),
  lastSeen: z.record(cursor), reviewCursors: z.record(cursor),
});
const MAX_STORED_LENGTH = 4_000_000;
function safeJsonTree(value: unknown): boolean {
  let count = 0;
  const visit = (v: unknown, depth: number): boolean => {
    if (++count > 150000 || depth > 40) return false;
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (Array.isArray(v)) return v.length <= 10000 && v.every(x => visit(x, depth + 1));
    if (!v || typeof v !== 'object') return false;
    return Object.entries(v).every(([key, item]) => !['__proto__', 'prototype', 'constructor'].includes(key) && visit(item, depth + 1));
  };
  return visit(value, 0);
}

export function restorePublicDemoState(raw: unknown, seed: PublicDemoSeed): WorkpaperState {
  const fresh = () => initialState(seed.packet);
  if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return fresh();
  try {
    const envelope = JSON.parse(raw);
    if (!safeJsonTree(envelope) || envelope?.version !== 1) return fresh();
    const parsed = stateSchema.safeParse(envelope.state);
    if (!parsed.success) return fresh();
    const state = parsed.data as WorkpaperState;
    const baseline = fresh();
    if (state.baseVersion !== baseline.baseVersion || state.contentRevision > state.revision) return fresh();
    const targets = new Set([...seed.packet.extracted_values.map((v: RecordValue) => v.id), ...seed.packet.return_versions.find((v: RecordValue) => v.version === state.baseVersion).lines.map((v: RecordValue) => v.key)]);
    if (state.adjustments.some(a => !targets.has(a.targetId))) return fresh();
    if (state.verificationBatches.some(b => b.targetIds.some((target: string) => !Object.hasOwn(b.previous, target)))) return fresh();
    if (state.supplementalRecords.some(r => !seed.packet.documents.some((d: RecordValue) => d.id === r.documentId && d.pages.some((p: RecordValue) => p.page === r.page)))) return fresh();
    if (state.filing.snapshots.some(s => s.baseVersion !== state.baseVersion)) return fresh();
    // Exercise the derived views too, before accepting storage for later rendering.
    filingGates(seed.packet, findingsFor(seed, state), state); financialSummary(seed.packet, state);
    return state;
  } catch { return fresh(); }
}

export function serializePublicDemoState(state: WorkpaperState): string {
  return JSON.stringify({ version: 1, state });
}
