import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { packet } from '../examples/packet';
import {
  applyPublicDemoAction,
  publicDemoRecord,
  restorePublicDemoState,
  serializePublicDemoState,
} from '../lib/public-demo';
import type { RecordValue } from '../lib/workflow';
import EvidenceDrawer from './evidence-drawer';
import { ReviewQueue } from './review-queue';
import './globals.css';

const seed = { packet, findings: [] };
const storageKey = 'proofwork-portfolio-review';

function loadState() {
  try {
    return restorePublicDemoState(localStorage.getItem(storageKey), seed);
  } catch {
    return restorePublicDemoState(null, seed);
  }
}

function ReviewDemo() {
  const [state, setState] = useState(loadState);
  const [actorId, setActorId] = useState('preparer');
  const [reference, setReference] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const { actor, findings, packet: visiblePacket } = publicDemoRecord(seed, state, actorId);

  async function mutate(action: string, payload: RecordValue) {
    try {
      const next = await applyPublicDemoAction(seed, state, actorId, action, payload);
      setState(next);
      try {
        localStorage.setItem(storageKey, serializePublicDemoState(next));
        setMessage('Review saved in this browser.');
      } catch {
        setMessage('Review saved for this tab.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Unable to record the change.');
    }
  }

  return (
    <main className="workspace-main" style={{ maxWidth: 1280, margin: '0 auto' }}>
      <header className="row spread" style={{ marginBottom: 24, flexWrap: 'wrap' }}>
        <div>
          <p className="section-label">Proofwork</p>
          <p className="muted">Synthetic travel-log review · local browser demo</p>
        </div>
        <label className="row">
          Review role
          <select value={actorId} onChange={event => {
            setActorId(event.target.value);
            setReference(null);
            setMessage('');
          }}>
            <option value="preparer">Preparer</option>
            <option value="reviewer">Reviewer</option>
          </select>
        </label>
      </header>
      {message && <p className="callout" role="status">{message}</p>}
      <ReviewQueue packet={visiblePacket} state={state} findings={findings}
        actor={actor} mutate={mutate} openRef={setReference} />
      {reference && (
        <EvidenceDrawer reference={reference} packet={visiblePacket} state={state}
          actor={actor} mutate={mutate} onClose={() => setReference(null)} />
      )}
    </main>
  );
}

createRoot(document.querySelector('#root')!).render(<ReviewDemo />);
