import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Layers,
  Link2,
  Plug,
  RefreshCw,
  Server,
  Send,
  ShieldCheck,
  Upload,
  XCircle,
} from 'lucide-react';
import { API_BASE, api } from '../api.js';
import AbdmPanel from './AbdmPanel.jsx';
import { CopyableRow, MONO, Pill, Row, SectionLabel, shortId } from './widgets.jsx';

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

const PANEL_PAD = `${PANEL} p-5`;

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

/** One cell of the top status ribbon. */
function Stat({ icon: Icon, label, value, tone = 'muted', hint }) {
  const toneRing = {
    ok: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    warn: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    muted: 'text-muted dark:text-darkMuted bg-tint dark:bg-darkBorderSubtle',
    accent: 'text-accent bg-accent/10',
  };
  return (
    <div className="flex items-start gap-3 px-4 py-3.5">
      <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${toneRing[tone]}`}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
          {label}
        </p>
        <p className="mt-0.5 truncate text-[12px] font-bold text-ink dark:text-darkText">{value}</p>
        {hint && <p className="mt-0.5 truncate text-[10px] text-muted dark:text-darkMuted">{hint}</p>}
      </div>
    </div>
  );
}

function Btn({ tone = 'ghost', icon: Icon, children, ...rest }) {
  const tones = {
    primary:
      'bg-accent text-white shadow-soft hover:bg-accentHover border border-transparent',
    ghost:
      'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText hover:border-accent/40',
    quiet:
      'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText',
  };
  return (
    <button
      {...rest}
      className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold disabled:opacity-50 ${tones[tone]}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
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
      const base = (overview.outbound_server?.base_url || '').replace(/\/$/, '');
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
          url:
            entry.response?.location && base
              ? `${base}/${entry.response.location.replace(/^\//, '')}`
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
        <div className="h-20 rounded-2xl bg-tint dark:bg-darkCard" />
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
  const phasesLive = PHASE_KEYS.filter((k) => overview.phases?.[k]?.implemented).length;

  // A raw server-local timestamp forces the viewer to do timezone maths. Prefer a
  // scannable state, built from the authoritative `expires_in` duration.
  const tokenExpiry = (() => {
    if (!smart?.connected) return null;
    if (smart.expired) return <Pill tone="bad">Token expired</Pill>;
    const seconds = smart.expires_in;
    if (seconds == null) return null;
    const minutes = Math.floor(seconds / 60);
    const label =
      minutes < 1 ? '<1m left' : minutes < 60 ? `${minutes}m left` : `${Math.round(minutes / 60)}h left`;
    return (
      <Pill tone={minutes < 10 ? 'warn' : 'ok'}>
        <span title={smart.expires_at || ''}>{label}</span>
      </Pill>
    );
  })();

  return (
    <div className="animate-fade-up space-y-6">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>Interoperability</SectionLabel>
          <h1 className="mt-1 text-lg font-black tracking-tight text-ink dark:text-darkText">
            HL7 FHIR R4 Exchange
          </h1>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted dark:text-darkMuted">
            NeuroPilot is a system of engagement layered on the hospital&apos;s system of record. Model
            output travels as{' '}
            <span className="font-semibold text-ink dark:text-darkText">RiskAssessment</span> — decision
            support by definition — never as a <code style={MONO}>Condition</code>.
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

      {/* ── Status ribbon: one panel instead of four competing cards ── */}
      <div className={`${PANEL} divide-y divide-line dark:divide-darkBorder sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4`}>
        <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
          <Stat
            icon={Server}
            label="Hospital server"
            value={outbound.reachable ? outbound.software || 'Reachable' : 'Not connected'}
            tone={outbound.reachable ? 'ok' : 'warn'}
            hint={outbound.reachable ? `FHIR ${outbound.fhir_version || 'R4'}` : 'No hospital server connected'}
          />
        </div>
        <div className="lg:border-r lg:border-line dark:lg:border-darkBorder">
          <Stat
            icon={Plug}
            label="SMART session"
            value={smart?.connected ? 'Bound' : 'No session'}
            tone={smart?.connected ? 'ok' : 'muted'}
            hint={smart?.patient || 'launch from the EHR'}
          />
        </div>
        <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
          <Stat
            icon={Upload}
            label="Outbound push"
            value={overview.push_orders_on_order ? 'Enabled' : 'Disabled'}
            tone={overview.push_orders_on_order ? 'accent' : 'muted'}
            hint="on order placement"
          />
        </div>
        <div>
          <Stat
            icon={Activity}
            label="Exchange surface"
            value={`${(surface.patients ?? 0).toLocaleString()} patients`}
            tone="accent"
            hint={`${(surface.observations ?? 0).toLocaleString()} observations`}
          />
        </div>
      </div>

      {/* ── Phases: a compact rail, not four full cards ─────────── */}
      <div className={`${PANEL} px-5 py-4`}>
        <div className="flex items-baseline justify-between gap-4">
          <SectionLabel size="sm">FHIR R4 capability phases</SectionLabel>
          <Pill tone={phasesLive === PHASE_KEYS.length ? 'ok' : 'warn'}>
            {phasesLive}/{PHASE_KEYS.length} live
          </Pill>
        </div>
        <div className="mt-3 grid gap-px overflow-hidden rounded-xl border border-line/70 dark:border-darkBorder/70 bg-line/60 dark:bg-darkBorder/60 sm:grid-cols-2 lg:grid-cols-4">
          {PHASE_KEYS.map((key, i) => {
            const phase = overview.phases?.[key] || {};
            return (
              <div key={key} className="bg-white p-3.5 dark:bg-darkCard">
                <div className="flex items-center justify-between gap-2">
                  <span style={MONO} className="text-[10px] font-bold text-dust dark:text-darkMuted">
                    0{i + 1}
                  </span>
                  {phase.implemented ? (
                    <Pill tone="ok">
                      <CheckCircle2 className="h-3 w-3" /> Live
                    </Pill>
                  ) : (
                    <Pill tone="muted">Planned</Pill>
                  )}
                </div>
                <p className="mt-2 text-[12px] font-bold text-ink dark:text-darkText">
                  {PHASE_TITLES[key]}
                </p>
                <p className="mt-1 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                  {phase.detail}
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Connection detail ──────────────────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className={PANEL_PAD}>
          <SectionLabel
            right={outbound.reachable ? <Pill tone="ok">Reachable</Pill> : <Pill tone="warn">Offline</Pill>}
          >
            Outbound hospital server
          </SectionLabel>
          <div className="mt-3">
            {outbound.base_url ? (
              <CopyableRow label="Base URL" value={outbound.base_url} />
            ) : (
              <Row label="Base URL" value="not configured" />
            )}
            <Row label="FHIR version" value={outbound.fhir_version} mono />
            <Row label="Server" value={outbound.software} />
            {/* Only meaningful once something is configured — otherwise the row, the
                Base URL row and the paragraph all restate "nothing connected". */}
            {outbound.configured && <Row label="Detail" value={outbound.detail} />}
            <Row
              label="Push on order"
              value={overview.push_orders_on_order ? 'Enabled' : 'Disabled'}
            />
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            {outbound.reachable
              ? 'Connected to the configured FHIR server. Push is a deliberate act, never a default.'
              : 'Not yet connected to a hospital system. Once connected, orders and results can flow automatically.'}
          </p>
        </div>

        <div className={PANEL_PAD}>
          <SectionLabel
            right={
              <span className="flex items-center gap-1.5">
                {smart?.connected ? (
                  <Pill tone="ok">Session bound</Pill>
                ) : (
                  <Pill tone="muted">No session</Pill>
                )}
                {tokenExpiry}
              </span>
            }
          >
            SMART on FHIR
          </SectionLabel>
          <div className="mt-3">
            <CopyableRow label="Client ID" value={smart?.client_id} display={smart?.client_id} />
            <CopyableRow label="Redirect URI" value={smart?.redirect_uri} />
            <CopyableRow
              label="Patient in context"
              value={smart?.patient}
              display={smart?.patient ? shortId(smart.patient) : null}
            />
            <CopyableRow label="Issuer (iss)" value={smart?.iss} />
            <Row
              label="Scopes"
              value={
                <span className="flex flex-wrap justify-end gap-1">
                  {(smart?.scopes || []).map((scope) => (
                    <span
                      key={scope}
                      style={MONO}
                      className="rounded-md border border-line dark:border-darkBorder bg-tint/60 dark:bg-darkBorderSubtle px-1.5 py-0.5 text-[10px] text-ink dark:text-darkText"
                    >
                      {scope}
                    </span>
                  ))}
                </span>
              }
            />
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
                <Btn icon={RefreshCw} onClick={doRefreshSmart} disabled={busy === 'smart-refresh'}>
                  Renew token
                </Btn>
                <Btn icon={XCircle} tone="quiet" onClick={doLogout} disabled={busy === 'smart-logout'}>
                  Disconnect
                </Btn>
              </>
            )}
          </div>
          <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            Tokens are held server-side and never handed to the browser. A real launch needs a client id
            registered with the EHR sandbox — an unregistered client is rejected by the EHR, not here.
          </p>
        </div>
      </div>

      {/* ── Exchange surface + export/push ─────────────────────── */}
      <div className="grid gap-6 lg:grid-cols-2">
        <div className={PANEL_PAD}>
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
            Live resource counts from the NeuroPilot store. FHIR is the exchange boundary; triage remains
            internal.
          </p>
        </div>

        <div className={PANEL_PAD}>
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
            <Btn icon={Layers} onClick={doExport} disabled={!patientId || busy === 'export'}>
              Preview full record
            </Btn>
            <Btn tone="primary" icon={Upload} onClick={doPush} disabled={!patientId || busy === 'push'}>
              Push to hospital
            </Btn>
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
                      <div
                        key={`${resource.location}-${index}`}
                        className="flex items-center justify-between gap-2 text-[10px]"
                      >
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

      {/* ── Inbound bundle tester ──────────────────────────────── */}
      <div className={PANEL_PAD}>
        <SectionLabel right={<Pill tone="accent">atomic — all or nothing</Pill>}>
          Inbound ingestion
          <span
            style={MONO}
            className="ml-1.5 rounded-md border border-line dark:border-darkBorder bg-tint/70 dark:bg-darkBorderSubtle px-1.5 py-0.5 text-[10px] font-medium tracking-normal text-muted dark:text-darkMuted"
          >
            POST /fhir/Bundle
          </span>
        </SectionLabel>
        <p className="mt-2 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
          Paste any FHIR R4 transaction/collection Bundle. A recognised result is mapped, the served model
          re-scores the patient, and unknown codes are reported rather than dropped. A wrong UCUM unit or an
          unmappable resource rejects the <span className="font-semibold">whole</span> bundle with an
          OperationOutcome naming every offender — no partial writes.
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
          <Btn tone="primary" icon={Send} onClick={doIngest} disabled={busy === 'ingest'}>
            Send bundle
          </Btn>
          <Btn
            icon={RefreshCw}
            onClick={() => {
              setBundleText(JSON.stringify(SAMPLE_BUNDLE(patientId), null, 2));
              setIngestResult(null);
              setIngestIssues([]);
            }}
          >
            Reset sample
          </Btn>
        </div>

        {ingestIssues.length > 0 && (
          <div className="mt-3 rounded-xl border border-red-500/35 bg-red-500/10 p-3">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-red-600 dark:text-red-400">
              <XCircle className="h-3.5 w-3.5" /> Bundle rejected (422)
            </p>
            <ul className="mt-2 space-y-1">
              {ingestIssues.map((issue) => (
                <li
                  key={issue}
                  style={MONO}
                  className="text-[10.5px] leading-relaxed text-red-700 dark:text-red-300"
                >
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
                <li
                  key={ext.url + ext.valueString}
                  style={MONO}
                  className="text-[10.5px] leading-relaxed text-emerald-800 dark:text-emerald-300"
                >
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
