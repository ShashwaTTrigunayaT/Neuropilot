import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Layers,
  Link2,
  Plug,
  RefreshCw,
  Send,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { API_BASE, api } from '../api.js';
import AbdmPanel from './AbdmPanel.jsx';
import { MONO, SectionLabel } from './widgets.jsx';

/**
 * Interoperability — the HL7 FHIR R4 surface (FHIR_INTEGRATION.md Phases 1-4).
 *
 * This view exists to make the integration *inspectable* rather than claimed:
 * which phase is implemented, whether an outbound hospital server is reachable,
 * whether a SMART session is bound, what an order looks like as a real
 * ServiceRequest, and what the inbound ingestion path actually does with a
 * bundle — including refusing one.
 */

const PANEL =
  'rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard shadow-soft';

const PHASE_KEYS = ['1_export', '2_inbound', '3_bidirectional', '4_smart'];
const PHASE_TITLES = {
  '1_export': 'Export',
  '2_inbound': 'Inbound',
  '3_bidirectional': 'Bidirectional',
  '4_smart': 'SMART launch',
};

const SAMPLE_BUNDLE = (patientId) => ({
  resourceType: 'Bundle',
  type: 'transaction',
  entry: [
    {
      resource: {
        resourceType: 'Observation',
        id: 'demo-ptau217',
        status: 'final',
        code: { coding: [{ system: 'urn:neuropilot:codes', code: 'ptau217-plasma' }] },
        subject: { reference: `Patient/${patientId}` },
        effectiveDateTime: new Date().toISOString().slice(0, 10),
        valueQuantity: {
          value: 0.72,
          unit: 'pg/mL',
          system: 'http://unitsofmeasure.org',
          code: 'pg/mL',
        },
      },
    },
  ],
});

function Pill({ tone = 'muted', children }) {
  const tones = {
    ok: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    warn: 'border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    bad: 'border-red-500/35 bg-red-500/10 text-red-600 dark:text-red-400',
    muted: 'border-line dark:border-darkBorder bg-tint dark:bg-darkBorderSubtle text-muted dark:text-darkMuted',
    accent: 'border-accent/35 bg-accent/10 text-accent',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

function Row({ label, value, mono = true }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line/60 dark:border-darkBorder/60 py-2 last:border-b-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
        {label}
      </span>
      <span
        style={mono ? MONO : undefined}
        className="max-w-[62%] break-words text-right text-[11px] leading-relaxed text-ink dark:text-darkText"
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

export default function Interoperability({ patients = [], initialPatientId, onToast }) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState(null);
  const [smart, setSmart] = useState(null);
  const [busy, setBusy] = useState('');

  const [patientId, setPatientId] = useState(initialPatientId || patients[0]?.id || '');
  const [exported, setExported] = useState(null);
  const [orders, setOrders] = useState(null);
  const [pushResult, setPushResult] = useState(null);

  const [bundleText, setBundleText] = useState('');
  const [ingestResult, setIngestResult] = useState(null);
  const [ingestIssues, setIngestIssues] = useState([]);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [fhir, smartStatus] = await Promise.all([api.fhirStatus(), api.smartStatus()]);
      setOverview(fhir);
      setSmart(smartStatus);
      setStatus('ready');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!patientId) return;
    setBundleText(JSON.stringify(SAMPLE_BUNDLE(patientId), null, 2));
    setExported(null);
    setOrders(null);
    setPushResult(null);
    setIngestResult(null);
    setIngestIssues([]);
  }, [patientId]);

  const patientOptions = useMemo(() => patients.slice(0, 400), [patients]);

  const run = async (key, fn) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      onToast?.('Request failed', err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const doExport = () =>
    run('export', async () => {
      const [bundle, orderBundle] = await Promise.all([
        api.fhirEverything(patientId),
        api.fhirServiceRequests(patientId),
      ]);
      const counts = {};
      bundle.entry.forEach((e) => {
        counts[e.resource.resourceType] = (counts[e.resource.resourceType] || 0) + 1;
      });
      setExported({ counts, total: bundle.entry.length });
      setOrders(orderBundle.entry.map((e) => e.resource));
    });

  const doPush = () =>
    run('push', async () => {
      const receipt = await api.fhirPush(patientId);
      const accepted = receipt.resourceType === 'Bundle' ? receipt.entry || [] : [];
      const base = (overview.outbound_server?.base_url || '').replace(/\\/$/, '');
      setPushResult({
        ok: receipt.resourceType === 'Bundle',
        detail:
          receipt.resourceType === 'Bundle'
            ? `${accepted.length} resource(s) accepted by the hospital server`
            : (receipt.issue || [{}])[0].diagnostics,
        server: base,
        resources: accepted.map((entry) => ({
          status: entry.response?.status || 'accepted',
          location: entry.response?.location || '',
          url: entry.response?.location && base
            ? `${base}/${entry.response.location.replace(/^\\//, '')}`
            : '',
        })),
      });
    });

  const doIngest = () =>
    run('ingest', async () => {
      setIngestResult(null);
      setIngestIssues([]);
      let parsed;
      try {
        parsed = JSON.parse(bundleText);
      } catch (err) {
        setIngestIssues([`Request body is not valid JSON: ${err.message}`]);
        return;
      }
      try {
        const receipt = await api.fhirIngest(parsed);
        setIngestResult(receipt);
        onToast?.('Bundle accepted', 'The served model re-scored the patient.');
      } catch (err) {
        setIngestIssues(err.message.split('\n').filter(Boolean));
      }
    });

  const doRefreshSmart = () =>
    run('smart-refresh', async () => {
      const next = await api.smartRefresh();
      setSmart((s) => ({ ...s, ...next }));
      onToast?.('SMART token renewed');
    });

  const doLogout = () =>
    run('smart-logout', async () => {
      await api.smartLogout();
      const next = await api.smartStatus();
      setSmart(next);
      onToast?.('SMART session disconnected', 'Relaunch from the EHR to bind a new context.', 'info');
    });

  if (status === 'loading') {
    return (
      <div className="animate-pulse space-y-4">
        <div className="h-24 rounded-2xl bg-tint dark:bg-darkCard" />
        <div className="h-64 rounded-2xl bg-tint dark:bg-darkCard" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={`${PANEL} p-8 text-center`}>
        <AlertTriangle className="mx-auto h-6 w-6 text-tierHigh" />
        <p className="mt-3 text-xs text-muted dark:text-darkMuted">{error}</p>
        <button
          onClick={load}
          className="mt-4 inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Retry
        </button>
      </div>
    );
  }

  const outbound = overview.outbound_server || {};
  const surface = overview.surface || {};

  return (
    <div className="animate-fade-up space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>Interoperability</SectionLabel>
          <h1 className="mt-1 text-lg font-black tracking-tight text-ink dark:text-darkText">
            HL7 FHIR R4 Exchange
          </h1>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted dark:text-darkMuted">
            NeuroPilot is a system of engagement layered on the hospital&apos;s system of record. Model
            output travels as <span className="font-semibold text-ink dark:text-darkText">RiskAssessment</span> —
            decision support by definition — never as a <code style={MONO}>Condition</code>. This instance
            serves a synthetic cohort, not real PHI.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${API_BASE}/fhir/metadata`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-[11px] font-semibold text-ink dark:text-darkText"
          >
            <Layers className="h-3.5 w-3.5" /> CapabilityStatement
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
          <a
            href={`${API_BASE}/docs`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-[11px] font-semibold text-ink dark:text-darkText"
          >
            OpenAPI <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        </div>
      </div>

      {/* Phase strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {PHASE_KEYS.map((key, i) => {
          const phase = overview.phases?.[key] || {};
          return (
            <div key={key} className={`${PANEL} p-4`}>
              <div className="flex items-center justify-between">
                <span style={MONO} className="text-[10px] font-bold text-dust dark:text-darkMuted">
                  PHASE {i + 1}
                </span>
                {phase.implemented ? (
                  <Pill tone="ok">
                    <CheckCircle2 className="h-3 w-3" /> Live
                  </Pill>
                ) : (
                  <Pill tone="muted">Planned</Pill>
                )}
              </div>
              <p className="mt-2 text-sm font-bold text-ink dark:text-darkText">{PHASE_TITLES[key]}</p>
              <p className="mt-1 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                {phase.detail}
              </p>
            </div>
          );
        })}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Outbound server */}
        <div className={`${PANEL} p-5`}>
          <SectionLabel
            right={
              outbound.reachable ? <Pill tone="ok">Reachable</Pill> : <Pill tone="warn">Offline</Pill>
            }
          >
            Outbound hospital server
          </SectionLabel>
          <div className="mt-3">
            <Row label="Base URL" value={outbound.base_url || 'not configured'} />
            <Row label="FHIR version" value={outbound.fhir_version} />
            <Row label="Server" value={outbound.software} />
            <Row label="Detail" value={outbound.detail} mono={false} />
            <Row
              label="Push on order"
              value={overview.push_orders_on_order ? 'enabled (FHIR_PUSH_ORDERS)' : 'disabled'}
            />
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            Set <code style={MONO}>FHIR_BASE_URL</code> (e.g. a local HAPI server at
            <code style={MONO}> http://localhost:8090/fhir</code>) to enable live order and result
            exchange. Pushing is a deliberate act, never a default.
          </p>
        </div>

        {/* SMART on FHIR */}
        <div className={`${PANEL} p-5`}>
          <SectionLabel
            right={
              smart?.connected ? (
                <Pill tone="ok">Session bound</Pill>
              ) : (
                <Pill tone="muted">No session</Pill>
              )
            }
          >
            SMART on FHIR
          </SectionLabel>
          <div className="mt-3">
            <Row label="Client ID" value={smart?.client_id} />
            <Row label="Redirect URI" value={smart?.redirect_uri} />
            <Row label="Patient in context" value={smart?.patient} />
            <Row label="Issuer (iss)" value={smart?.iss} />
            <Row label="Token expires" value={smart?.expires_at} />
            <Row label="Scopes" value={(smart?.scopes || []).join(' · ')} mono={false} />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <a
              href={api.smartLaunchUrl({ format: 'redirect' })}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[11px] font-bold text-white shadow-soft transition hover:bg-accentHover"
            >
              <Plug className="h-3.5 w-3.5" />
              {smart?.connected ? 'Relaunch from EHR' : 'Launch (standalone)'}
            </a>
            {smart?.connected && (
              <>
                <button
                  onClick={doRefreshSmart}
                  disabled={busy === 'smart-refresh'}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-ink dark:text-darkText disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${busy === 'smart-refresh' ? 'animate-spin' : ''}`} />
                  Renew token
                </button>
                <button
                  onClick={doLogout}
                  disabled={busy === 'smart-logout'}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-muted dark:text-darkMuted disabled:opacity-50"
                >
                  <XCircle className="h-3.5 w-3.5" /> Disconnect
                </button>
              </>
            )}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            Tokens are held server-side and never handed to the browser. A real launch needs a client
            id registered with the EHR sandbox — an unregistered client is rejected by the EHR, not here.
          </p>
        </div>

        {/* Surface */}
        <div className={`${PANEL} p-5`}>
          <SectionLabel>Exchange surface</SectionLabel>
          <div className="mt-3 grid grid-cols-2 gap-3">
            {[
              ['Patients (resources)', surface.patients],
              ['RiskAssessments', surface.risk_assessments],
              ['Observations', surface.observations],
              ['Orders open', surface.open_orders],
              ['Orders completed', surface.completed_orders],
            ].map(([label, value]) => (
              <div
                key={label}
                className="rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/50 dark:bg-darkBorderSubtle px-3 py-2"
              >
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
                  {label}
                </p>
                <p style={MONO} className="mt-1 text-lg font-bold text-ink dark:text-darkText">
                  {value ?? '—'}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            {overview.note}
          </p>
        </div>

        {/* Export / push */}
        <div className={`${PANEL} p-5`}>
          <SectionLabel>Export &amp; push a patient</SectionLabel>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              className="min-w-[9rem] flex-1 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-ink dark:text-darkText"
            >
              {patientOptions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.id}
                </option>
              ))}
            </select>
            <button
              onClick={doExport}
              disabled={!patientId || busy === 'export'}
              className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-ink dark:text-darkText disabled:opacity-50"
            >
              <Layers className={`h-3.5 w-3.5 ${busy === 'export' ? 'animate-pulse' : ''}`} />
              Preview $everything
            </button>
            <button
              onClick={doPush}
              disabled={!patientId || busy === 'push'}
              className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" /> Push to hospital
            </button>
          </div>

          {exported && (
            <div className="mt-3 rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/40 dark:bg-darkBorderSubtle p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
                Bundle shapes ({exported.total} resources)
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {Object.entries(exported.counts).map(([type, n]) => (
                  <span
                    key={type}
                    style={MONO}
                    className="rounded-lg border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-2 py-0.5 text-[10px] text-ink dark:text-darkText"
                  >
                    {type} × {n}
                  </span>
                ))}
              </div>
            </div>
          )}

          {orders && (
            <div className="mt-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
                Orders as ServiceRequest
              </p>
              {orders.length === 0 ? (
                <p className="mt-1 text-[10.5px] text-muted dark:text-darkMuted">
                  No order has been placed for this patient yet.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {orders.map((o) => (
                    <li
                      key={o.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-line/70 dark:border-darkBorder/70 px-3 py-2"
                    >
                      <span className="flex items-center gap-2">
                        <Link2 className="h-3.5 w-3.5 text-accent" />
                        <span style={MONO} className="text-[10.5px] text-ink dark:text-darkText">
                          {o.code?.text || o.code?.coding?.[0]?.code}
                        </span>
                      </span>
                      <Pill tone={o.status === 'completed' ? 'ok' : 'warn'}>{o.status}</Pill>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {pushResult && (
            <div
              className={`mt-3 rounded-xl border p-3 text-[10.5px] leading-relaxed ${
                pushResult.ok
                  ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-400'
              }`}
            >
              <p>{pushResult.detail}</p>
              {pushResult.ok && pushResult.resources?.length > 0 && (
                <details className="mt-3">
                  <summary className="cursor-pointer font-semibold">
                    Remote FHIR receipt ({pushResult.resources.length} resources)
                  </summary>
                  <div className="mt-2 max-h-52 space-y-1 overflow-auto rounded-lg border border-emerald-500/20 bg-white/50 p-2 dark:bg-black/10">
                    {pushResult.resources.map((resource, index) => (
                      <div key={`${resource.location}-${index}`} className="flex items-center justify-between gap-2 text-[10px]">
                        <span style={MONO} className="truncate">
                          {resource.location || `resource-${index + 1}`}
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span>{resource.status}</span>
                          {resource.url && (
                            <a
                              href={resource.url}
                              target="_blank"
                              rel="noreferrer"
                              className="font-bold underline"
                            >
                              Open
                            </a>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Inbound bundle tester */}
      <div className={`${PANEL} p-5`}>
        <SectionLabel
          right={<Pill tone="accent">atomic — all or nothing</Pill>}
        >
          Inbound ingestion — POST /fhir/Bundle
        </SectionLabel>
        <p className="mt-2 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
          Paste any FHIR R4 transaction/collection Bundle. A recognised result is mapped, the served
          model re-scores the patient, and unknown codes are reported rather than dropped. A wrong UCUM
          unit or an unmappable resource rejects the <span className="font-semibold">whole</span> bundle
          with an OperationOutcome naming every offender — no partial writes.
        </p>

        <textarea
          value={bundleText}
          onChange={(e) => setBundleText(e.target.value)}
          spellCheck={false}
          rows={12}
          style={MONO}
          className="mt-3 w-full rounded-xl border border-line dark:border-darkBorder bg-tint/30 dark:bg-darkBorderSubtle p-3 text-[10.5px] leading-relaxed text-ink dark:text-darkText focus:outline-none focus:ring-2 focus:ring-accent/40"
        />

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={doIngest}
            disabled={busy === 'ingest'}
            className="inline-flex items-center gap-1.5 rounded-xl bg-accent px-3.5 py-2 text-[11px] font-bold text-white disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" /> Send bundle
          </button>
          <button
            onClick={() => {
              setBundleText(JSON.stringify(SAMPLE_BUNDLE(patientId), null, 2));
              setIngestResult(null);
              setIngestIssues([]);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-2 text-[11px] font-semibold text-ink dark:text-darkText"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Reset sample
          </button>
        </div>

        {ingestIssues.length > 0 && (
          <div className="mt-3 rounded-xl border border-red-500/35 bg-red-500/10 p-3">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-red-600 dark:text-red-400">
              <XCircle className="h-3.5 w-3.5" /> Bundle rejected (422)
            </p>
            <ul className="mt-2 space-y-1">
              {ingestIssues.map((issue) => (
                <li key={issue} style={MONO} className="text-[10.5px] leading-relaxed text-red-700 dark:text-red-300">
                  {issue}
                </li>
              ))}
            </ul>
          </div>
        )}

        {ingestResult && (
          <div className="mt-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" /> {ingestResult.type} received
            </p>
            <ul className="mt-2 space-y-1">
              {(ingestResult.extension || []).map((ext) => (
                <li key={ext.url + ext.valueString} style={MONO} className="text-[10.5px] leading-relaxed text-emerald-800 dark:text-emerald-300">
                  {ext.valueString}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ABDM (India) — a different national gateway, not FHIR phase 5. */}
      <AbdmPanel patients={patients} initialPatientId={patientId} onToast={onToast} />
    </div>
  );
}
