import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UserCheck,
} from 'lucide-react';
import { api } from '../api.js';
import { Btn, CopyableRow, MONO, Pill, Row, SectionHeader, shortId } from './widgets.jsx';

/**
 * ABDM consent flow (India) — the HIU side, live (FHIR plan.md Phases 4-5).
 *
 * NeuroPilot asks a Consent Manager for permission to read a patient's records,
 * and the records arrive Fidelius-encrypted. This panel makes that exchange
 * inspectable rather than described: every step is a real HTTP call, the grant
 * arrives as a callback (not a return value), and the pull re-scores the patient
 * through the served model.
 *
 * The asynchrony is shown honestly: after a request the panel polls until the
 * session reaches a terminal state, because that is what a real CM looks like.
 */

// The same surface as the panels around it: hairline, radius, and a shadow with
// a 1px inner highlight along the top edge, so this component does not look like
// a slightly different product sitting on the same page.
const PANEL =
  'rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(19,21,26,0.03),0_10px_24px_-22px_rgba(19,21,26,0.14)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_10px_-6px_rgba(0,0,0,0.55)]';

const TERMINAL = ['GRANTED', 'DENIED', 'RECEIVED', 'FAILED'];

const STATUS_TONE = {
  REQUESTED: 'warn',
  RECORDS_REQUESTED: 'warn',
  GRANTED: 'accent',
  RECEIVED: 'ok',
  DENIED: 'bad',
  FAILED: 'bad',
};

const STEP_LABEL = {
  CONSENT_REQUESTED: 'Consent requested',
  GRANTED: 'Consent granted (callback)',
  DENIED: 'Consent denied',
  REVOKED: 'Consent revoked',
  EXPIRED: 'Consent expired',
  RECORDS_REQUESTED: 'Records requested',
  TRANSACTION_ACK: 'Transaction acknowledged',
  RECORDS_RECEIVED: 'Encrypted records received',
  TRANSFER_REJECTED: 'Transfer rejected',
  INGEST_REJECTED: 'Records did not map',
  FAILED: 'Failed',
};

export default function AbdmPanel({ patients = [], initialPatientId, onToast }) {
  const [status, setStatus] = useState(null);
  const [session, setSession] = useState(null);
  const [abha, setAbha] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setAbha(initialPatientId ? `${initialPatientId}@sbx` : '');
  }, [initialPatientId]);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.abdmStatus());
    } catch (err) {
      setError(err.message);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  /** Consent is asynchronous: poll until the CM has got us somewhere terminal. */
  const settle = async (sessionId, terminal = TERMINAL, timeoutMs = 15000) => {
    const deadline = Date.now() + timeoutMs;
    let latest = null;
    while (Date.now() < deadline) {
      latest = await api.abdmSession(sessionId);
      setSession(latest);
      if (terminal.includes(latest.status)) return latest;
      await new Promise((r) => setTimeout(r, 400));
    }
    return latest;
  };

  const run = async (key, fn) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  };

  const requestConsent = () =>
    run('consent', async () => {
      const started = await api.abdmConsent({ abha_address: abha.trim() });
      setSession(started);
      if (started.status === 'FAILED') {
        onToast?.('Consent request failed', started.error || '', 'error');
        return;
      }
      const settled = await settle(started.session_id, ['GRANTED', 'DENIED', 'FAILED']);
      onToast?.(
        settled?.status === 'GRANTED' ? 'Consent granted' : `Consent ${settled?.status?.toLowerCase()}`,
        settled?.status === 'GRANTED'
          ? 'The patient approved the request. Records can now be pulled.'
          : settled?.error || 'The patient did not approve this request.',
        settled?.status === 'GRANTED' ? 'success' : 'error',
      );
    });

  const requestRecords = () =>
    run('records', async () => {
      const requested = await api.abdmRequestRecords(session.session_id);
      setSession(requested);
      const settled = await settle(requested.session_id, ['RECEIVED', 'FAILED']);
      onToast?.(
        settled?.status === 'RECEIVED' ? 'Encrypted records ingested' : 'Pull failed',
        settled?.pull?.summary || settled?.error || 'Fidelius decryption or mapping did not complete.',
        settled?.status === 'RECEIVED' ? 'success' : 'error',
      );
      // A pull writes real measurements, so the cohort's ranking has moved.
      onToast?.('Cohort re-scored', 'The ingested records went through the served model.', 'info');
    });

  const reset = () =>
    run('reset', async () => {
      await api.abdmReset();
      await api.abdmMockReset();
      setSession(null);
      onToast?.('Consent sessions cleared');
    });

  const pull = session?.pull;
  const canRequestRecords = session?.status === 'GRANTED';
  const fidelius = status?.fidelius;

  return (
    <div className={`${PANEL} p-6`}>
      {/* The same header idiom as every other panel on the interoperability view. */}
      <SectionHeader
        icon={KeyRound}
        title="ABDM consent flow (India)"
        right={
          status?.mock_gateway ? (
            <Pill tone="warn">Mock gateway</Pill>
          ) : status?.configured ? (
            <Pill tone="ok">Consent Manager</Pill>
          ) : (
            <Pill tone="muted">Not configured</Pill>
          )
        }
      />

      <p className="mt-2 max-w-3xl text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
        NeuroPilot is the <span className="font-semibold text-ink dark:text-darkText">HIU</span>: it asks a
        Consent Manager for a purpose-bound, time-bounded read, then asks for the records that consent
        covers. Records arrive <span className="font-semibold text-ink dark:text-darkText">Fidelius</span>-encrypted
        (ECDH on BouncyCastle Curve25519 → HKDF-SHA256 → AES-256-GCM), are decrypted server-side, and are
        scored by the same path as a result typed into the UI. Exactly one credential leaves this system when
        asking for consent: the patient&apos;s ABHA address.
      </p>

      <div className="mt-4 grid gap-5 lg:grid-cols-2">
        {/* Gateway + Fidelius parameters */}
        <div className="rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/40 dark:bg-darkBorderSubtle/60 p-4">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
            <ShieldCheck className="h-3.5 w-3.5 text-accent" /> Consent Manager &amp; crypto
          </p>
          <div className="mt-2">
            {status?.cm_base_url ? (
              <CopyableRow
                label="CM base URL"
                value={status.cm_base_url}
              />
            ) : (
              <Row label="CM base URL" value="not configured" />
            )}
            <Row label="CM id" value={status?.hiu_id} mono />
            <Row
              label="Reachable"
              value={
                status?.cm_reachable ? (
                  <Pill tone="ok">Reachable</Pill>
                ) : (
                  <Pill tone="warn">Unreachable</Pill>
                )
              }
            />
            {status?.data_push_url ? (
              <CopyableRow label="Data push URL" value={status.data_push_url} />
            ) : (
              <Row label="Data push URL" value="not configured" />
            )}
            <Row label="Curve" value={fidelius?.curve} />
            <Row label="KDF / cipher" value={`${fidelius?.kdf} · ${fidelius?.cipher}`} />
            <Row label="Reference vectors" value={fidelius?.reference_vectors} />
          </div>
          <p className="mt-2 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            The curve is BouncyCastle&apos;s <span className="font-semibold">short-Weierstrass</span> Curve25519 —
            not TLS X25519. Encryption is verified byte-for-byte against the published{' '}
            <code style={MONO}>fidelius-cli</code> test vectors; a standard X25519 implementation would fail
            against a real HIP with <code style={MONO}>ABDM-9999</code>.
          </p>
        </div>

        {/* Consent request */}
        <div className="rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/40 dark:bg-darkBorderSubtle/60 p-4">
          <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
            <UserCheck className="h-3.5 w-3.5 text-accent" /> 1. Ask for consent
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              value={abha}
              onChange={(e) => setAbha(e.target.value)}
              placeholder="ADNI-0006@sbx"
              style={MONO}
              list="abdm-abha-options"
              className="min-w-[10rem] flex-1 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-ink dark:text-darkText"
            />
            <datalist id="abdm-abha-options">
              {patients.slice(0, 120).map((p) => (
                <option key={p.id} value={`${p.id}@sbx`} />
              ))}
            </datalist>
            <Btn
              tone="primary"
              icon={UserCheck}
              onClick={requestConsent}
              disabled={busy === 'consent' || !abha.trim()}
            >
              {busy === 'consent' ? 'Waiting for the patient…' : 'Request consent'}
            </Btn>
          </div>

          {session && (
            <div className="mt-3">
              <CopyableRow
                label="Session"
                value={session.session_id}
                display={session.session_id ? shortId(session.session_id) : null}
              />
              <Row
                label="Status"
                value={<Pill tone={STATUS_TONE[session.status] || 'muted'}>{session.status}</Pill>}
              />
              <CopyableRow
                label="Consent artefact"
                value={session.consent_id}
                display={session.consent_id ? shortId(session.consent_id) : null}
              />
              <CopyableRow
                label="Transaction"
                value={session.transaction_id}
                display={session.transaction_id ? shortId(session.transaction_id) : null}
              />
              {session.key_material?.public_key ? (
                <CopyableRow
                  label="HIU key (public)"
                  value={session.key_material.public_key}
                  display={shortId(session.key_material.public_key)}
                />
              ) : (
                <Row
                  label="HIU key (public)"
                  value={session.key_material_retired ? 'retired after the pull' : '—'}
                />
              )}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn
              icon={KeyRound}
              onClick={requestRecords}
              disabled={!canRequestRecords || busy === 'records'}
              className={busy === 'records' ? '[&_svg]:animate-pulse' : ''}
            >
              2. Pull encrypted records
            </Btn>
            {session && (
              <Btn tone="quiet" icon={RotateCcw} onClick={reset} disabled={busy === 'reset'}>
                Reset
              </Btn>
            )}
            <span className="text-[10.5px] text-muted dark:text-darkMuted">
              {canRequestRecords
                ? 'Consent is granted — the pull sends only the public half of a fresh ephemeral key.'
                : 'Records cannot be pulled until the Consent Manager reports a grant.'}
            </span>
          </div>

          {error && (
            <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {error}
            </p>
          )}
        </div>
      </div>

      {/* Timeline */}
      {session?.events?.length > 0 && (
        <div className="mt-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
            Exchange timeline (callbacks driven by the Consent Manager)
          </p>
          <ol className="mt-2 space-y-1.5">
            {session.events.map((event, i) => (
              <li key={`${event.at}-${i}`} className="flex items-start gap-2">
                <span
                  style={MONO}
                  className="mt-0.5 shrink-0 text-[9.5px] tabular-nums text-dust dark:text-darkMuted"
                >
                  {event.at.slice(11, 19)}
                </span>
                <span className="text-[10.5px] leading-relaxed text-ink dark:text-darkText">
                  <span className="font-semibold">{STEP_LABEL[event.event] || event.event}</span>
                  {event.detail ? (
                    <span className="text-muted dark:text-darkMuted"> — {event.detail}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* What the pull did */}
      {pull && (
        <div className="mt-5 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4">
          <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5" /> {pull.summary}
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-emerald-500/25">
                  {['Patient', 'Stage', 'Tier', 'Official score', 'Priority score'].map((h) => (
                    <th
                      key={h}
                      className="pb-1 pr-4 text-[9.5px] font-bold uppercase tracking-[0.1em] text-emerald-800/80 dark:text-emerald-300/80"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(pull.patients || []).map((p) => (
                  <tr key={p.id} className="border-b border-emerald-500/15 last:border-b-0">
                    <td style={MONO} className="py-1.5 pr-4 text-[10.5px] font-semibold text-emerald-900 dark:text-emerald-200">
                      {p.id}
                    </td>
                    <td className="py-1.5 pr-4 text-[10.5px] text-emerald-900 dark:text-emerald-200">
                      {p.stage} · {p.stage_name}
                    </td>
                    <td className="py-1.5 pr-4 text-[10.5px] uppercase text-emerald-900 dark:text-emerald-200">
                      {p.risk_tier}
                    </td>
                    <td style={MONO} className="py-1.5 pr-4 text-[10.5px] text-emerald-900 dark:text-emerald-200">
                      {Number(p.official_score).toFixed(3)}
                    </td>
                    <td style={MONO} className="py-1.5 text-[10.5px] text-emerald-900 dark:text-emerald-200">
                      {Number(p.final_score).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-emerald-800 dark:text-emerald-300">
            These scores come from the served model after ingestion — the same path a result entered in the
            UI takes. A High tier still requires measured biomarker evidence under the ordered pathway; an
            arriving record cannot bypass that gate. The mock HIP labels any value it synthesised from the
            empirical cohort as simulator output, in the bundle itself.
          </p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <span className="flex items-center gap-1.5 text-[10.5px] text-muted dark:text-darkMuted">
          <RefreshCw className="h-3.5 w-3.5" />
          {status?.sessions
            ? `${status.sessions.total} session(s) · ${status.sessions.granted} granted · ${status.sessions.received} received · ${status.sessions.failed} failed`
            : '—'}
        </span>
      </div>

      <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">{status?.note}</p>
    </div>
  );
}
