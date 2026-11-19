import type { RecordValue } from '../lib/workflow.ts';

export const packet: RecordValue = {
  firm: {
    staff: [{ id: 'reviewer', name: 'Demo Reviewer', role: 'reviewer' },
            { id: 'preparer', name: 'Demo Preparer', role: 'preparer' }],
    client_users: [],
    deadlines: [],
    budget_hours: [],
    starter_standards: { required_steps: ['Review source pages'], verification_types: ['source_checked'], rules: [] },
  },
  client: { questionnaire: [], messages: [], call_notes: [] },
  household: { people: [] },
  documents: [{
    id: 'D900', title: 'Travel log', document_type: 'Mileage log', page_count: 2,
    issuer: 'Demo preparer', file_name: 'synthetic-travel-log.txt', tax_year: 2025,
    extraction: { status: 'extracted' }, received_at: '2025-02-10T00:00:00Z',
    pages: [
      { page: 1, title: 'Travel log', printed_content: 'Service trip. Page total: 88 miles.' },
      { page: 2, title: 'Rescan', printed_content: '(Second scan of page 1) Service trip. Page total: 88 miles.' },
    ],
  }],
  extracted_values: [
    { id: 'VAL-A', document_id: 'D900', page: 1, field: 'page_total', label: 'Page total miles', confidence: 0.97, value: 88 },
    { id: 'VAL-B', document_id: 'D900', page: 2, field: 'page_total', label: 'Page total miles', confidence: 0.97, value: 88 },
  ],
  return_versions: [{
    version: 'v3', computed_at: '2025-03-01T00:00:00Z',
    tax_effect_rates: { schc_profit: { federal_per_dollar: 0.15, california_per_dollar: 0.04 } },
    documents_used: ['D900'], documents_superseded: [],
    lines: [
      { key: 'SchC.44a', label: 'Business mileage', value: 176, sources: ['VAL-A', 'VAL-B'] },
      { key: 'SchC.9', label: 'Vehicle expense', value: 88, sources: [], inputs: ['SchC.44a'] },
    ],
    summary: { federal: { agi: 3200, payments: 205, total_tax: 280, balance_due: 75 },
               california: { payments: 25, total_tax: 40, balance_due: 15 } },
  }],
  engine_reference: { rules: {}, parameters: { mileage_rate: 0.5 } },
  prior_years: {},
  tax_agency_records: { notices: [] },
  timeline: [],
};
