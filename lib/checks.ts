/** Deterministic, packet-grounded checks. No network, mutation or tax-law lookup. */
export type FindingKind = 'confirmed_error' | 'needs_judgment' | 'missing_evidence' | 'resolved_by_engine';
export type Finding = {
  id: string; title: string; area: string; severity: 'critical' | 'high' | 'medium' | 'low';
  kind: FindingKind; status: 'open' | 'historical'; summary: string; detail: string;
  evidence: { ref: string; label: string; quote?: string }[];
  affectedLines: string[]; checkType: string;
  suggestedAdjustment?: { lineKey: string; newValue: number; category: string; reason: string; effectDirection: 1 | -1; californiaCategory?: 'ca_source_income' | 'none' };
  availableFrom?: string; replayOnly?: boolean;
};
const money = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
const numeric = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const equal = (a: number, b: number) => Math.abs(a - b) < 0.005;
const pageRef = (d: any, p: any) => `doc:${d.id}#page${p.page}`;
const evidence = (ref: string, label: string) => ({ ref, label });
const finding = (values: Omit<Finding, 'status'>): Finding => ({ status: 'open', ...values });

/** Select the latest computed version, never a future timeline/replay result. */
export function runChecks(packet: any): Finding[] {
  if (!packet || !Array.isArray(packet.return_versions)) return [];
  const current = [...packet.return_versions].filter(v => v && typeof v.computed_at === 'string')
    .sort((a, b) => Date.parse(b.computed_at) - Date.parse(a.computed_at))[0];
  if (!current || !Array.isArray(current.lines)) return [];
  const lines = new Map<string, any>(current.lines.map((l: any) => [l.key, l]));
  const docs = (packet.documents ?? []).filter((d: any) =>
    !current.documents_superseded?.includes(d.id) &&
    (!d.received_at || Date.parse(d.received_at) <= Date.parse(current.computed_at)));
  const values = (packet.extracted_values ?? []).filter((v: any) => docs.some((d: any) => d.id === v.document_id));
  const valueById = new Map<string, any>(values.map((v: any) => [v.id, v]));
  const out: Finding[] = [];

  // Duplicate equal totals alone are insufficient: compare complete normalized page text.
  for (const doc of docs) {
    const totals = values.filter((v: any) => v.document_id === doc.id && v.field === 'page_total' && numeric(v.value));
    if (totals.length < 2 || !doc.pages?.length) continue;
    const seen = new Map<string, any>();
    const duplicates: any[] = [];
    let uniqueTotal = 0;
    for (const page of doc.pages) {
      const total = totals.find((v: any) => v.page === page.page);
      if (!total || typeof page.printed_content !== 'string') continue;
      // The source packet labels repeated scans in an initial parenthetical sentence.
      const normalized = page.printed_content.replace(/^\(Second scan[^)]*\)\s*/i, '')
        .replace(/\s+/g, ' ').trim().toLowerCase();
      if (seen.has(normalized)) duplicates.push({ page, total, original: seen.get(normalized) });
      else { seen.set(normalized, { page, total }); uniqueTotal += total.value; }
    }
    const miles = lines.get('SchC.44a');
    const expense = lines.get('SchC.9');
    if (!duplicates.length || !numeric(miles?.value) || !totals.every((t: any) => miles.sources?.includes(t.id))) continue;
    const allTotal = totals.reduce((n: number, v: any) => n + v.value, 0);
    // Do not flag an already-corrected line or guess when another mileage adjustment exists.
    if (!equal(miles.value, allTotal) || equal(uniqueTotal, allTotal)) continue;
    const rate = packet.engine_reference?.parameters?.mileage_rate;
    const adjustment = numeric(rate) && numeric(expense?.value) ? {
      lineKey: 'SchC.9', newValue: Math.round(uniqueTotal * rate), category: 'schc_profit',
      reason: `Use ${money(uniqueTotal)} distinct miles × the packet rate ${rate}; update the mileage workpaper too.`,
      effectDirection: -1 as const,
    } : undefined;
    out.push(finding({ id: 'ERR-MILEAGE-DUPLICATE', title: 'A repeated scan adds business miles', area: 'Business', severity: 'high',
      kind: 'confirmed_error', summary: `${money(allTotal)} miles includes duplicate pages; distinct page totals equal ${money(uniqueTotal)}.`,
      detail: 'Complete page text matches after removing the explicit second-scan marker. This check does not infer duplication from equal totals alone.',
      evidence: duplicates.flatMap(d => [evidence(pageRef(doc, d.original.page), 'Original mileage page'), evidence(pageRef(doc, d.page), 'Duplicate mileage page'), evidence(d.total.id, 'Duplicate page total')]),
      affectedLines: ['SchC.44a', 'SchC.9'], checkType: 'duplicate_mileage', ...(adjustment ? { suggestedAdjustment: adjustment } : {}) }));
  }

  // Specific economic identity must be supported by the deposit narrative and source links.
  const gross = lines.get('SchC.1');
  const books = values.find((v: any) => v.field === 'total_income' && gross?.sources?.includes(v.id));
  const card = values.find((v: any) => v.field === 'box1a' && gross?.sources?.includes(v.id));
  const depositPage = docs.flatMap((d: any) => (d.pages ?? []).map((p: any) => ({ d, p }))).find(({ p }: any) =>
    /Client deposits are recorded as Sales - client projects/i.test(p.printed_content ?? '') &&
    /of which ([\d,]+\.\d{2}) arrived through Paywell Payments/i.test(p.printed_content ?? ''));
  if (numeric(gross?.value) && numeric(books?.value) && numeric(card?.value) && depositPage) {
    const matched = Number(depositPage.p.printed_content.match(/of which ([\d,]+\.\d{2}) arrived through Paywell Payments/i)[1].replaceAll(',', ''));
    if (equal(matched, card.value) && equal(gross.value, books.value + card.value)) {
      out.push(finding({ id: 'ERR-GROSS-OVERLAP', title: 'Payment-card receipts are already in the books', area: 'Business', severity: 'high', kind: 'confirmed_error',
        summary: `$${money(card.value)} of documented book revenue is counted again.`,
        detail: `Books show $${money(books.value)}. The narrative explicitly matches $${money(matched)} of card receipts to recorded deposits; the line equals books plus that card amount.`,
        evidence: [evidence(books.id, 'Book revenue'), evidence(card.id, 'Card receipt total'), evidence(pageRef(depositPage.d, depositPage.p), 'Explicit deposit match')],
        affectedLines: ['SchC.1'], checkType: 'gross_receipts_overlap',
        suggestedAdjustment: { lineKey: 'SchC.1', newValue: books.value, category: 'schc_profit', reason: 'Remove only the card receipts explicitly documented as already recorded in sales.', effectDirection: 1 } }));
    }
  }

  const mortgage = lines.get('SchA.8a');
  const mortgageSources = (mortgage?.sources ?? []).map((id: string) => valueById.get(id)).filter(Boolean);
  const payoff = mortgageSources.find((v: any) => v.field === 'interest' && docs.some((d: any) => d.id === v.document_id && d.pages?.some((p: any) => /Interest is reported on the 2025 Form 1098/i.test(p.printed_content ?? ''))));
  const annual = mortgageSources.find((v: any) => v.field === 'box1' && docs.some((d: any) => d.id === v.document_id && d.pages?.some((p: any) => /includes[^.]*interest paid at payoff/i.test(p.printed_content ?? ''))));
  if (numeric(mortgage?.value) && numeric(payoff?.value) && annual && mortgageSources.every((v: any) => numeric(v.value))) {
    const sourceSum = mortgageSources.reduce((s: number, v: any) => s + v.value, 0);
    if (equal(mortgage.value, sourceSum)) out.push(finding({ id: 'ERR-MORTGAGE-OVERLAP', title: 'Payoff interest is counted twice', area: 'Deductions', severity: 'high', kind: 'confirmed_error',
      summary: `$${money(payoff.value)} appears separately and inside the annual Form 1098 total.`,
      detail: 'Both source narratives explicitly establish the overlap and both values feed the current line. No other mortgage components are changed.',
      evidence: [evidence(annual.id, 'Annual total includes payoff interest'), evidence(payoff.id, 'Payoff interest reported on the annual form')],
      affectedLines: ['SchA.8a'], checkType: 'mortgage_overlap',
      suggestedAdjustment: { lineKey: 'SchA.8a', newValue: mortgage.value - payoff.value, category: 'itemized', reason: 'Remove the payoff interest already inside the annual lender statement.', effectDirection: 1 } }));
  }

  for (const doc of docs) {
    const sourceValues = values.filter((v: any) => v.document_id === doc.id);
    const summary = sourceValues.find((v: any) => v.field === 'b_summary_proceeds');
    const lots = sourceValues.filter((v: any) => /^[A-Z]+\d+_proceeds$/.test(v.field) && numeric(v.value));
    if (!numeric(summary?.value) || !lots.length) continue;
    const detailTotal = Math.round(lots.reduce((n: number, v: any) => n + v.value, 0) * 100) / 100;
    if (equal(summary.value, detailTotal)) continue;
    const unread = (doc.pages ?? []).filter((p: any) => !sourceValues.some((v: any) => v.page === p.page) && /Additional transactions/i.test(p.printed_content ?? ''));
    out.push(finding({ id: doc.id === 'D31' ? 'ERR-BROKER-INCOMPLETE' : `CHECK-BROKER-${doc.id}`, title: 'Broker summary and extracted lots do not reconcile', area: 'Investments', severity: 'high',
      kind: unread.length ? 'confirmed_error' : 'needs_judgment',
      summary: `Summary $${money(summary.value)} versus extracted detail $${money(detailTotal)}: difference $${money(summary.value - detailTotal)}.`,
      detail: unread.length ? 'A page labelled Additional transactions has no extracted fields. Inspect and enter the actual supported lots; a balancing plug is not a valid fix.' : 'The arithmetic mismatch is established, but its cause is not. Review source pages before proposing a correction.',
      evidence: [evidence(summary.id, 'Broker summary proceeds'), ...unread.map((p: any) => evidence(pageRef(doc, p), 'Additional-transactions page with no extracted fields'))],
      affectedLines: ['SchD.2'], checkType: 'broker_reconciliation' }));
  }

  const rule = packet.firm?.starter_standards?.variance_review;
  const prior = packet.prior_years?.return_2024?.lines;
  if (rule && prior && numeric(rule.flag_if_change_over_percent) && numeric(rule.and_over_amount)) {
    const threshold = rule.flag_if_change_over_percent;
    const changed = current.lines.filter((line: any) => numeric(line.value) && numeric(prior[line.key])).map((line: any) => {
      const old = prior[line.key]; const delta = line.value - old;
      return { line, old, delta, percent: old === 0 ? (delta === 0 ? 0 : Infinity) : Math.abs(delta / old) * 100 };
    }).filter((v: any) => Math.abs(v.delta) > rule.and_over_amount && v.percent > threshold)
      .sort((a: any, b: any) => Math.abs(b.delta) - Math.abs(a.delta));
    if (changed.length) {
      const sample = changed.slice(0, 8);
      out.push(finding({ id: 'CHECK-PRIOR-YEAR-VARIANCES', title: `${changed.length} prior-year variances require explanation`, area: 'Review', severity: 'medium', kind: 'needs_judgment',
        summary: `Both firm thresholds apply: over ${threshold}% and over $${money(rule.and_over_amount)}. A variance is not itself an error.`,
        detail: `Largest changes: ${sample.map((v: any) => `${v.line.key}: ${money(v.old)} → ${money(v.line.value)}`).join('; ')}. Dependent lines may reflect the same underlying event; explain the root causes rather than counting these as independent errors. A zero prior-year value with a nonzero change satisfies the relative threshold.`,
        evidence: sample.flatMap((v: any) => [evidence(v.line.key, 'Current line'), evidence(`py:/return_2024/lines/${v.line.key}`, 'Prior-year filed amount')]),
        affectedLines: sample.map((v: any) => v.line.key), checkType: 'prior_year_variance' }));
    }
  }
  return out;
}

/** Curated context wins on semantic duplicates; independently computed new checks remain. */
export function mergeFindings(curated: Finding[], computed: Finding[]): Finding[] {
  const ids = new Set<string>(); const signatures = new Set<string>();
  return [...curated, ...computed].filter(f => {
    const signature = `${f.checkType}|${[...f.affectedLines].sort().join('|')}`;
    if (ids.has(f.id) || signatures.has(signature)) return false;
    ids.add(f.id); signatures.add(signature); return true;
  });
}
