import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  DownloadCloud,
  ExternalLink,
  Layers,
  Link2,
  ListChecks,
  Plug,
  RefreshCw,
  Server,
  Send,
  ShieldCheck,
  Target,
  Upload,
  Users,
  XCircle,
} from 'lucide-react';
import { API_BASE, api } from '../api.js';
import AbdmPanel from './AbdmPanel.jsx';
import {
  ACCENT,
  Btn,
  CopyableRow,
  MONO,
  PANEL,
  Pill,
  RibbonStat,
  Row,
  FoldHeader,
  SectionHeader,
  shortId,
} from './widgets.jsx';

/**
 * The page's card surface, in one place.
 *
 * `PANEL` supplies the hairline and the radius. On top of that this adds the
 * interior padding and a shadow carrying a 1px inner highlight along the top
 * edge — that highlight is the difference between a white card sitting *on* a
 * tinted page and a flat white rectangle cut *out* of it. Every panel on this
 * view uses one of these two constants, so no card drifts a shade from another.
 */
const CARD_DEPTH =
  'shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_1px_2px_rgba(19,21,26,0.03),0_10px_24px_-22px_rgba(19,21,26,0.14)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_2px_10px_-6px_rgba(0,0,0,0.55)] card-wash';
const CARD = `${PANEL} ${CARD_DEPTH} p-4 sm:p-6`;
const CARD_RIBBON = `${PANEL} ${CARD_DEPTH}`;

/** Two letters for a chart row's monogram — a name reads as a person, not a row. */
const initials = (name) => {
  const words = (name || '').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  if (!words.length) return '?\u2009';
  return (words[0][0] + (words[1]?.[0] || '')).toUpperCase();
};

/**
 * Interoperability — the HL7 FHIR R4 surface (FHIR_INTEGRATION.md Phases 1-4).
 *
 * This view exists to make the integration *inspectable* rather than claimed:
 * which phase is implemented, whether an outbound hospital server is reachable,
 * whether a SMART session is bound, what an order looks like as a real
 * ServiceRequest, and what the inbound ingestion path actually does with a
 * bundle — including refusing one.
 */

const PHASE_KEYS = ['1_export', '2_inbound', '3_bidirectional', '4_smart'];
const PHASE_TITLES = {
  '1_export': 'Export',
  '2_inbound': 'Inbound',
  '3_bidirectional': 'Bidirectional',
  '4_smart': 'SMART launch',
};

// One icon per phase, so the rail reads the same way the status ribbon does.
const PHASE_ICONS = [Upload, DownloadCloud, Link2, Plug];

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

const score = (value) => (typeof value === 'number' ? value.toFixed(2) : '—');

export default function Interoperability({
  patients = [],
  initialPatientId,
  onToast,
  onRefresh,
  onOpenPatient,
}) {
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');
  const [overview, setOverview] = useState(null);
  const [smart, setSmart] = useState(null);
  const [busy, setBusy] = useState('');
  // What a STANDALONE launch should open. These are per-launch choices, not
  // configuration: a SMART session binds exactly one patient in context, so a
  // launch that names none inherits the server's SMART_LAUNCH_PATIENT_ID env
  // default -- which is how every standalone launch ends up on the same chart.
  const [launchPatient, setLaunchPatient] = useState('');
  const [launchIss, setLaunchIss] = useState('');
  // `launch` is opaque by spec: the EHR (or a simulator's launch page) supplies
  // it and the app must echo it back unread. Servers that ignore a bare
  // `patient` -- launch.smarthealthit.org needs base64'd JSON launch options,
  // for instance -- are driven through this field with the value they handed out.
  const [launchContext, setLaunchContext] = useState('');
  // The chart list comes from the EHR, never from the served cohort: a launch's
  // patient-in-context must exist on that server, and `ADNI-0016` is
  // NeuroPilot's own key — unknown to any EHR.
  const [charts, setCharts] = useState(null);
  const [chartError, setChartError] = useState('');
  const [chartName, setChartName] = useState('');

  const [patientId, setPatientId] = useState(initialPatientId || patients[0]?.id || '');
  const [exported, setExported] = useState(null);
  const [orders, setOrders] = useState(null);
  const [pushResult, setPushResult] = useState(null);

  const [bundleText, setBundleText] = useState('');
  const [ingestResult, setIngestResult] = useState(null);
  const [ingestIssues, setIngestIssues] = useState([]);
  // SMART-session import: the chart read straight from the EHR, as opposed to a
  // Bundle pasted into the textarea below.
  const [importResult, setImportResult] = useState(null);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      const [fhir, smartStatus] = await Promise.all([api.fhirStatus(), api.smartStatus()]);
      setOverview(fhir);
      setSmart(smartStatus);
      // Seed the standalone fields from the server's own defaults without ever
      // overwriting something the viewer has typed.
      const defaults = smartStatus?.launch_defaults || {};
      setLaunchPatient((current) => current || defaults.patient || '');
      setLaunchIss((current) => current || defaults.iss || '');
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
    setImportResult(null);
  }, [patientId]);

  // A chart list belongs to the server it was read from. Switching servers
  // invalidates it — stale ids would aim a launch at a server that has no such
  // patient, and the EHR would reject the launch for the wrong reason.
  useEffect(() => {
    setCharts(null);
    setChartError('');
  }, [launchIss]);

  const patientOptions = useMemo(() => patients.slice(0, 400), [patients]);

  /** The standalone launch URL, carrying the chosen chart and server.
   *
   * Omitted parameters are omitted on purpose: `iss` then falls back to the
   * server's FHIR_BASE_URL and `patient` to SMART_LAUNCH_PATIENT_ID, so this
   * link behaves exactly as before for anyone who does not touch the fields.
   */
  const standaloneLaunchUrl = useMemo(() => {
    const params = { format: 'redirect' };
    if (launchIss.trim()) params.iss = launchIss.trim();
    if (launchPatient.trim()) params.patient = launchPatient.trim();
    if (launchContext.trim()) params.launch = launchContext.trim();
    return api.smartLaunchUrl(params);
  }, [launchIss, launchPatient, launchContext]);

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

  /** Pull the patient in context from the EHR over the SMART session.
   *
   * Rejections land in the SAME `ingestIssues` state the paste flow uses, so a
   * 422 OperationOutcome renders once, in one place, for both paths.
   */
  const doImportFromEhr = () =>
    run('smart-import', async () => {
      setImportResult(null);
      setIngestIssues([]);
      try {
        const result = await api.smartImportPatient();
        setImportResult(result);
        // The cohort list is the app's own copy of the store, taken before this
        // patient existed; refresh it in the background so the imported chart is
        // actually reachable from the worklist.
        onRefresh?.();
        onToast?.(
          result.duplicate ? 'Chart already imported' : 'Patient imported from the EHR',
          `${result.subject_id} · risk ${score(result.score)}${result.risk_tier ? ` · ${result.risk_tier} tier` : ''}`,
          'success',
        );
      } catch (err) {
        setIngestIssues(err.message.split('\n').filter(Boolean));
      }
    });

  const doBrowseCharts = () =>
    run('smart-charts', async () => {
      setChartError('');
      try {
        setCharts(await api.smartCharts({ iss: launchIss.trim(), name: chartName.trim() }));
      } catch (err) {
        setCharts(null);
        setChartError(err.message);
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
      <div className={`${CARD} p-8 text-center`}>
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

  // The five counts as ONE composition. The bar and the row dots share these
  // colours, so the mix reads before any individual number is read. The
  // proportions are of the listed counts only — which is all the bar claims.
  const surfaceMix = [
    { label: 'Patients (resources)', value: surface.patients ?? 0, hex: ACCENT },
    { label: 'RiskAssessments', value: surface.risk_assessments ?? 0, hex: '#3B82F6' },
    { label: 'Observations', value: surface.observations ?? 0, hex: '#8B5CF6' },
    { label: 'Orders open', value: surface.open_orders ?? 0, hex: '#EC4899' },
    { label: 'Orders completed', value: surface.completed_orders ?? 0, hex: '#D9822B' },
  ];
  const surfaceTotal = surfaceMix.reduce((sum, row) => sum + row.value, 0) || 1;
  // The import reads over the session's own token, so it needs a bound session
  // with a live token AND a patient in context — a session without one has no
  // chart to read, and the API says exactly that in a 401.
  const canImport = Boolean(smart?.connected && !smart?.expired && smart?.patient);

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
      {/* ── Masthead — type, not another card. The page is long enough.
       * The counts live here as one line of type, which is what the four summary
       * tiles were saying with a great deal more ink. */}
      <div className="dot-grid animate-fade-up rounded-2xl border-b border-line/80 px-4 pb-5 pt-3 dark:border-darkBorder/80">
        <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4">
          <div className="flex min-w-0 items-start gap-4">
            <div
              className="relative flex h-11 w-11 sm:h-[52px] sm:w-[52px] shrink-0 items-center justify-center rounded-[18px] border border-white/60 shadow-soft dark:border-white/10"
              style={{
                background:
                  'linear-gradient(135deg, rgb(var(--accent-rgb) / 0.15), rgb(var(--accent-rgb) / 0.04) 62%, transparent)',
              }}
            >
              <Plug className="h-[22px] w-[22px]" style={{ color: ACCENT }} />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-[18px] ring-1 ring-inset ring-white/50 dark:ring-white/10"
              />
            </div>

            {/* Quoted by a full-height accent rule on its leading edge. */}
            <div className="relative min-w-0 pl-[18px]">
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 h-full w-px bg-gradient-to-b from-accent via-accent/35 to-transparent"
              />
              <div className="flex items-center gap-2.5">
                <span className="h-[3px] w-[3px] rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">
                  Interoperability
                </p>
                <span aria-hidden="true" className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent" />
              </div>

              <h1
                style={MONO}
                className="mt-2 text-[23px] font-black leading-[1.05] tracking-[-0.03em] text-ink dark:text-darkText sm:text-[36px]"
              >
                HL7 FHIR R4
              </h1>

              {/* Hidden on phones: on a narrow screen this sentence sits directly
                  under the heading and pushes the integration surface, which is
                  the point of the page, below the fold. */}
              <p className="mt-2 hidden max-w-3xl text-[12.5px] leading-relaxed text-muted sm:block dark:text-darkMuted">
                A system of engagement layered on the hospital&apos;s system of record. Model output travels as{' '}
                <span className="font-semibold text-ink dark:text-darkText">RiskAssessment</span> — decision
                support by definition — and never as a <span style={MONO}>Condition</span>.
              </p>

            </div>
          </div>

          {/* Plain text links: these are references, not actions worth a box each.
              Desktop only — a row of three external links under a masthead is
              the first thing a phone shows and the last thing it needs there. */}
          <div className="hidden shrink-0 flex-wrap items-center gap-x-4 gap-y-2 pt-1 md:flex">
            <a
              href={`${API_BASE}/fhir/metadata`}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted transition hover:text-accent dark:text-darkMuted"
            >
              <Layers className="h-3.5 w-3.5" /> CapabilityStatement
              <ExternalLink className="h-3 w-3 opacity-60 transition group-hover:translate-x-0.5" />
            </a>
            <a
              href={`${API_BASE}/docs`}
              target="_blank"
              rel="noreferrer"
              className="group inline-flex items-center gap-1.5 text-[11px] font-semibold text-muted transition hover:text-accent dark:text-darkMuted"
            >
              OpenAPI <ExternalLink className="h-3 w-3 opacity-60 transition group-hover:translate-x-0.5" />
            </a>
          </div>
        </div>
      </div>

      {/* ── Status ribbon: one panel instead of four competing cards ── */}
      <div className={`${CARD_RIBBON} divide-y divide-line dark:divide-darkBorder sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4`}>
        <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
          <RibbonStat
            icon={Server}
            label="Hospital server"
            value={outbound.reachable ? outbound.software || 'Reachable' : 'Not connected'}
            tone={outbound.reachable ? 'ok' : 'warn'}
            hint={outbound.reachable ? `FHIR ${outbound.fhir_version || 'R4'}` : 'No hospital server connected'}
          />
        </div>
        <div className="lg:border-r lg:border-line dark:lg:border-darkBorder">
          <RibbonStat
            icon={Plug}
            label="SMART session"
            value={smart?.connected ? 'Bound' : 'No session'}
            tone={smart?.connected ? 'ok' : 'muted'}
            hint={smart?.patient || 'launch from the EHR'}
          />
        </div>
        <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
          <RibbonStat
            icon={Upload}
            label="Outbound push"
            value={overview.push_orders_on_order ? 'Enabled' : 'Disabled'}
            tone={overview.push_orders_on_order ? 'accent' : 'muted'}
            hint="on order placement"
          />
        </div>
        <div>
          <RibbonStat
            icon={Activity}
            label="Exchange surface"
            value={`${(surface.patients ?? 0).toLocaleString()} patients`}
            tone="accent"
            hint={`${(surface.observations ?? 0).toLocaleString()} observations`}
          />
        </div>
      </div>

      {/* ── One board, two bands: the system's live state on top, the four
       * capability phases under it, fused because they answer the same question
       * ("what is wired up right now?"). Stacked as two cards they read as two
       * products saying overlapping things — this card has already been through
       * a round of that, so the counts live once, in the band above. */}
      {/*
       * Desktop only: the four FHIR capability phases and the detail boards
       * below are reference material — what each phase IS, which endpoints
       * exist, what the server reports. On a phone they are four screens of
       * reading before anything can be done, so they are dropped and the live
       * status ribbon and the working panels above and below them remain.
       */}
      <div className={`${CARD_RIBBON} hidden overflow-hidden md:block`}>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-line bg-tint/40 px-5 py-2.5 dark:border-darkBorder dark:bg-darkBorderSubtle/40">
          <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.16em] text-muted dark:text-darkMuted">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
            FHIR R4 capability phases
          </p>
          <p style={MONO} className="text-[10.5px] font-bold text-ink dark:text-darkText">
            {PHASE_KEYS.filter((key) => overview.phases?.[key]?.implemented).length}/{PHASE_KEYS.length} live
          </p>
        </div>

        <div className="divide-y divide-line dark:divide-darkBorder sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4">
        {PHASE_KEYS.map((key, i) => {
          const phase = overview.phases?.[key] || {};
          const PhaseIcon = PHASE_ICONS[i];
          return (
            <div
              key={key}
              className={
                (i % 2 === 0 ? 'sm:border-r sm:border-line dark:sm:border-darkBorder ' : '') +
                (i < PHASE_KEYS.length - 1 ? 'lg:border-r lg:border-line dark:lg:border-darkBorder' : '')
              }
            >
              <RibbonStat
                icon={PhaseIcon}
                label={`0${i + 1} · ${PHASE_TITLES[key]}`}
                value={phase.implemented ? 'Live' : 'Planned'}
                tone={phase.implemented ? 'ok' : 'muted'}
                hint={phase.detail}
                // A live phase pulses where a planned one shows its icon: the
                // glyph itself carries the state, so the card is not static.
                dot={phase.implemented}
              />
            </div>
          );
        })}
        </div>
      </div>

      {/* ── Connection detail — one surface split by a hairline ────── */}
      <div className={`${CARD_RIBBON} hidden divide-y divide-line md:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-darkBorder`}>
        <div className="p-4 sm:p-6">
          <SectionHeader
            icon={Server}
            title="Outbound hospital server"
            right={outbound.reachable ? <Pill tone="ok">Reachable</Pill> : <Pill tone="warn">Offline</Pill>}
          />
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
            {/* Where a push actually lands. The session outranks the static config
                on the server, so the dashboard has to say so rather than imply
                the configured base URL is always the destination. */}
            {outbound.source === 'smart-session' && (
              <Row label="Push target" value="the session's hospital (outranks FHIR_BASE_URL)" />
            )}
          </div>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            {outbound.reachable
              ? 'Connected to the configured FHIR server. Push is a deliberate act, never a default.'
              : 'Not yet connected to a hospital system. Once connected, orders and results can flow automatically.'}
          </p>
        </div>

        <div className="p-4 sm:p-6">
          <SectionHeader
            icon={Plug}
            title="SMART on FHIR"
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
          />
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
                <span className="flex flex-wrap justify-end gap-x-2.5 gap-y-0.5">
                  {(smart?.scopes || []).map((scope) => (
                    <span key={scope} style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                      {scope}
                    </span>
                  ))}
                </span>
              }
            />
          </div>

          {/* Session lifecycle sits with the session's own facts. The launch
              controls moved to their own full-width panel below: picking a chart
              needs real width, and cramming it in here is what squashed this
              column into a wall of wrapped input boxes. */}
          {smart?.connected && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Btn icon={RefreshCw} onClick={doRefreshSmart} disabled={busy === 'smart-refresh'}>
                Renew token
              </Btn>
              <Btn icon={XCircle} tone="quiet" onClick={doLogout} disabled={busy === 'smart-logout'}>
                Disconnect
              </Btn>
            </div>
          )}
          <p className="mt-3 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
            Tokens are held server-side and never handed to the browser. A real launch needs a client id
            registered with the EHR sandbox — an unregistered client is rejected by the EHR, not here.
          </p>
        </div>
      </div>

      {/* ── Standalone launch ──────────────────────────────────────
       * Full width on purpose. A SMART launch has to name a patient that exists
       * ON THE EHR, so choosing one means browsing the server's own charts — and
       * that list needs room to be readable. This used to live inside the
       * half-width session column, where it read as a pile of cramped boxes. */}
      <div className={`${CARD} transition-shadow duration-300 hover:shadow-lift`}>
        <FoldHeader
          icon={Target}
          title="Standalone launch"
          right={
            <Pill tone={launchPatient.trim() ? 'accent' : 'muted'}>
              {launchPatient.trim() ? `targets ${shortId(launchPatient.trim())}` : 'no chart chosen'}
            </Pill>
          }
        />
        <p className="mt-2 max-w-4xl text-[11px] leading-relaxed text-muted dark:text-darkMuted">
          A session binds <span className="font-semibold">one</span> chart, and the id has to exist on that server
          — so browse the EHR and pick, rather than naming a NeuroPilot key it has never heard of. Left blank, the
          launch falls back to the server's <span style={MONO}>SMART_LAUNCH_PATIENT_ID</span>, which is why every
          standalone launch otherwise opens the same patient.
        </p>

        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,23rem)_minmax(0,1fr)]">
          {/* ── what to launch. No nested card: the panel is already the surface. ── */}
          <div className="space-y-3.5">
            <div className="flex items-center gap-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-lg"
                style={{ backgroundColor: 'rgb(var(--accent-rgb) / 0.1)', color: ACCENT }}
              >
                <Target className="h-3.5 w-3.5" />
              </span>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-ink dark:text-darkText">
                Launch target
              </p>
            </div>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted dark:text-darkMuted">
                Patient in context
              </span>
              <input
                value={launchPatient}
                onChange={(event) => setLaunchPatient(event.target.value)}
                placeholder="blank = server default"
                spellCheck={false}
                style={MONO}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[11px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted dark:text-darkMuted">
                FHIR server (iss)
              </span>
              <input
                value={launchIss}
                onChange={(event) => setLaunchIss(event.target.value)}
                placeholder="https://host/fhir"
                spellCheck={false}
                style={MONO}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[11px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
              />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted dark:text-darkMuted">
                Launch context <span className="font-normal normal-case tracking-normal">(optional, opaque)</span>
              </span>
              <input
                value={launchContext}
                onChange={(event) => setLaunchContext(event.target.value)}
                placeholder="only if the server demands it"
                spellCheck={false}
                style={MONO}
                className="mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[11px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
              />
            </label>

            <a
              href={standaloneLaunchUrl}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-accent px-3.5 py-2.5 text-[11px] font-bold text-white shadow-soft transition hover:bg-accentHover"
            >
              <Plug className="h-3.5 w-3.5" />
              {smart?.connected
                ? 'Relaunch from EHR'
                : launchPatient.trim()
                  ? `Launch as ${shortId(launchPatient.trim())}`
                  : 'Launch (standalone)'}
            </a>

            <p className="text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
              Some servers also demand their own launch context — the open SMART sandbox issues base64'd options
              from its simulator page. If a launch returns{' '}
              <span style={MONO}>Invalid launch options</span>, paste that value above.
              {smart?.connected && (
                <>
                  {' '}Relaunching replaces the current session
                  {smart?.patient ? ` (${shortId(smart.patient)})` : ''}.
                </>
              )}
            </p>
          </div>

          {/* ── the EHR's own charts ── */}
          <div className="flex min-w-0 flex-col">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={chartName}
                onChange={(event) => setChartName(event.target.value)}
                placeholder="Filter the server's patients by name…"
                spellCheck={false}
                className="min-w-[12rem] flex-1 rounded-lg border border-line bg-white px-2.5 py-2 text-[11px] text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
              />
              <Btn icon={ListChecks} onClick={doBrowseCharts} disabled={busy === 'smart-charts'}>
                {busy === 'smart-charts' ? 'Reading server…' : 'Browse charts on this server'}
              </Btn>
            </div>

            {chartError && (
              <p className="mt-3 flex items-start gap-1.5 rounded-xl border border-tierHigh/35 bg-tierHigh/[0.08] px-3 py-2 text-[10.5px] leading-relaxed text-tierHigh">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-pre-line">{chartError}</span>
              </p>
            )}

            {charts ? (
              <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-line/70 dark:border-darkBorder/70">
                <p className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-tint/50 px-3 py-2 dark:border-darkBorder/60 dark:bg-darkBorderSubtle">
                  <span className="text-[10.5px] font-bold text-ink dark:text-darkText">
                    {charts.count} chart{charts.count === 1 ? '' : 's'}
                  </span>
                  <Pill tone={charts.authenticated ? 'ok' : 'muted'}>
                    {charts.authenticated ? 'session token' : 'no token'}
                  </Pill>
                  <span style={MONO} className="min-w-0 flex-1 truncate text-[10px] text-muted dark:text-darkMuted">
                    {charts.iss}
                  </span>
                  {charts.capped && <Pill tone="warn">truncated — narrow by name</Pill>}
                </p>
                {charts.count === 0 ? (
                  <p className="px-3 py-4 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                    The server returned no patients{chartName.trim() ? ` matching “${chartName.trim()}”` : ''}. A
                    server that wants credentials answers 401 instead of an empty list, so an empty result really
                    means it holds none for this search.
                  </p>
                ) : (
                  <ul className="max-h-80 divide-y divide-line/60 overflow-y-auto dark:divide-darkBorder/60">
                    {charts.charts.map((chart) => {
                      const selected = launchPatient.trim() === chart.patient_id;
                      return (
                        <li key={chart.patient_id}>
                          <button
                            type="button"
                            onClick={() => setLaunchPatient(chart.patient_id)}
                            className={`flex w-full items-center justify-between gap-3 border-l-2 px-3 py-2 text-left transition ${
                              selected
                                ? 'border-accent bg-accent/[0.07]'
                                : 'border-transparent hover:bg-tint dark:hover:bg-darkBorderSubtle'
                            }`}
                          >
                            <span className="flex min-w-0 items-center gap-2.5">
                              <span
                                aria-hidden="true"
                                style={MONO}
                                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold ${
                                  selected
                                    ? 'bg-accent text-white'
                                    : 'bg-tint text-muted dark:bg-darkBorderSubtle dark:text-darkMuted'
                                }`}
                              >
                                {initials(chart.name)}
                              </span>
                              <span className="min-w-0">
                                <span className="block truncate text-[11.5px] font-semibold text-ink dark:text-darkText">
                                  {chart.name || '(no name on record)'}
                                </span>
                                <span style={MONO} className="block truncate text-[10px] text-muted dark:text-darkMuted">
                                  {chart.patient_id}
                                </span>
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-2">
                              {chart.subject_id && <Pill tone="accent">imported · {chart.subject_id}</Pill>}
                              {[chart.gender, chart.birthDate].filter(Boolean).length > 0 && (
                                <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                                  {[chart.gender, chart.birthDate].filter(Boolean).join(' · ')}
                                </span>
                              )}
                              {selected && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-accent" />}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            ) : (
              !chartError && (
                <p className="mt-3 flex flex-1 items-center rounded-xl border border-dashed border-line px-3 py-6 text-[10.5px] leading-relaxed text-muted dark:border-darkBorder dark:text-darkMuted">
                  The list comes from the FHIR server itself — these are the only patient ids a launch can name. On
                  an open test server it reads with no credentials; a real EHR needs a bound session first.
                </p>
              )
            )}
          </div>
        </div>
      </div>

      {/* ── Fused: what the exchange surface holds, and what leaves it. One
       * subject read two ways, so it is one card split by a hairline rather
       * than two cards implying two separate things. ── */}
      <div className={`${CARD_RIBBON} hidden divide-y divide-line md:grid lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-darkBorder`}>
        <div className="p-4 sm:p-6">
          <SectionHeader icon={Activity} title="Exchange surface" />

          {/* The composition, as one bar. It is the shape of the exchange before
              it is the count of it, and the row dots below key into it. */}
          <div className="mt-4 flex h-2.5 w-full overflow-hidden rounded-full bg-line/50 dark:bg-darkBorder">
            {surfaceMix.map((row) => (
              <span
                key={row.label}
                className="h-full transition-all duration-700 ease-out"
                style={{ width: `${(row.value / surfaceTotal) * 100}%`, backgroundColor: row.hex }}
              />
            ))}
          </div>

          <dl className="mt-3 divide-y divide-line/70 dark:divide-darkBorder/70">
            {surfaceMix.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-3 py-2.5 transition-colors hover:bg-tint/40 dark:hover:bg-darkBorderSubtle/50"
              >
                <dt className="flex min-w-0 items-center gap-2 text-[11px] text-muted dark:text-darkMuted">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: row.hex }}
                  />
                  <span className="truncate">{row.label}</span>
                  <span style={MONO} className="shrink-0 text-[9.5px] text-dust dark:text-darkMuted">
                    {Math.round((row.value / surfaceTotal) * 100)}%
                  </span>
                </dt>
                <dd
                  style={MONO}
                  className="shrink-0 text-[15px] font-bold text-ink tabular-nums dark:text-darkText"
                >
                  {row.value.toLocaleString()}
                </dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            Live resource counts from the NeuroPilot store — the share is of these five, not of the cohort.
            FHIR is the exchange boundary; triage remains internal.
          </p>
        </div>

        <div className="p-4 sm:p-6">
          <SectionHeader icon={Send} title="Export & push a patient" />
          {/* A labelled field, then the two actions on their own line: the old
              single row wrapped unpredictably and read as three equal things. */}
          <div className="mt-3.5">
            <label className="block">
              <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-dust dark:text-darkMuted">
                Patient to export
              </span>
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                style={MONO}
                className="mt-1.5 w-full rounded-xl border border-line bg-white px-3 py-2 text-[11px] font-semibold text-ink outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
              >
                {patientOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </label>

            {/* Two actions that are NOT equals — one reads, one leaves the
                building — so they get a tile each and say what they do. */}
            <div className="mt-3.5 grid gap-3 sm:grid-cols-2">
              <button
                type="button"
                onClick={doExport}
                disabled={!patientId || busy === 'export'}
                className="group rounded-xl border border-line bg-white p-3.5 text-left transition hover:border-accent/45 hover:bg-accent/[0.035] disabled:cursor-not-allowed disabled:opacity-50 dark:border-darkBorder dark:bg-darkCard"
              >
                <span className="flex items-center gap-2 text-[11.5px] font-bold text-ink dark:text-darkText">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/10 text-accent">
                    <Layers className="h-3.5 w-3.5" />
                  </span>
                  Preview full record
                </span>
                <span className="mt-2 block text-[10px] leading-relaxed text-muted dark:text-darkMuted">
                  Reads the patient out as a FHIR Bundle — Patient, Observation, RiskAssessment, AuditEvent.
                  Nothing leaves this page.
                </span>
              </button>

              <button
                type="button"
                onClick={doPush}
                disabled={!patientId || busy === 'push'}
                className="group rounded-xl border border-accent/35 bg-gradient-to-br from-accent/[0.07] to-transparent p-3.5 text-left transition hover:border-accent/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex items-center gap-2 text-[11.5px] font-bold text-ink dark:text-darkText">
                  <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent text-white">
                    <Upload className="h-3.5 w-3.5" />
                  </span>
                  Push to hospital
                </span>
                <span className="mt-2 block text-[10px] leading-relaxed text-muted dark:text-darkMuted">
                  POSTs one transaction Bundle to the target below. A deliberate act, and never automatic on
                  a decision-support read.
                </span>
              </button>
            </div>

            {/* Where a push actually lands is not obvious from the button, and
                the session outranks the static config on the server. */}
            <p className="mt-3 flex items-start gap-2 rounded-lg border border-line/70 bg-tint/40 px-2.5 py-2 text-[10px] leading-relaxed text-muted dark:border-darkBorder/70 dark:bg-darkBorderSubtle/50 dark:text-darkMuted">
              <Server className="mt-0.5 h-3 w-3 shrink-0 text-accent" />
              <span className="min-w-0">
                {outbound.source === 'smart-session' && outbound.base_url ? (
                  <>
                    Target: the session's hospital —{' '}
                    <span style={MONO} className="break-all text-ink dark:text-darkText">
                      {outbound.base_url}
                    </span>{' '}
                    (a bound session outranks FHIR_BASE_URL).
                  </>
                ) : outbound.configured && outbound.base_url ? (
                  <>
                    Target:{' '}
                    <span style={MONO} className="break-all text-ink dark:text-darkText">
                      {outbound.base_url}
                    </span>{' '}
                    from <span style={MONO}>FHIR_BASE_URL</span>.
                  </>
                ) : (
                  <>
                    No push target yet — set <span style={MONO}>FHIR_BASE_URL</span> or bind a SMART session, and
                    the destination appears here.
                  </>
                )}
              </span>
            </p>
          </div>

          {exported && (
            <div className="mt-3 rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/40 dark:bg-darkBorderSubtle p-3">
              <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
                Bundle shapes ({exported.total} resources)
              </p>
              <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {Object.entries(exported.counts).map(([type, n]) => (
                  <span key={type} style={MONO} className="text-[10.5px] text-ink dark:text-darkText">
                    {type} <span className="text-muted dark:text-darkMuted">×&hairsp;{n}</span>
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
      <div className={CARD}>
        <FoldHeader
          icon={DownloadCloud}
          title="Inbound ingestion"
          right={<Pill tone="accent">atomic — all or nothing</Pill>}
        />
        <p className="mt-2 max-w-4xl text-[11px] leading-relaxed text-muted dark:text-darkMuted">
          Ingestion is atomic: a wrong UCUM unit or an unmappable resource rejects the{' '}
          <span className="font-semibold text-ink dark:text-darkText">whole</span> bundle with an
          OperationOutcome naming every offender, rather than half-writing a record and scoring the fragment.
        </p>

        {/* The primary way in, so it gets the accent — a tinted surface with an
            accent rule on its leading edge rather than another neutral box. */}
        <div className="relative mt-3.5 overflow-hidden rounded-xl border border-accent/30 bg-gradient-to-br from-accent/[0.07] via-accent/[0.03] to-transparent p-4">
          <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px] bg-accent" />
          <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3 pl-1.5">
            <div className="min-w-[14rem] flex-1">
              <p className="flex flex-wrap items-center gap-2 text-[11.5px] font-bold text-ink dark:text-darkText">
                <DownloadCloud className="h-4 w-4 text-accent" />
                Import from the EHR session
                <span style={MONO} className="text-[10px] font-medium text-accent/80">
                  POST /fhir/smart/import-patient
                </span>
              </p>
              <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                {canImport ? (
                  <>
                    Reads <span style={MONO}>Patient</span>,{' '}
                    <span style={MONO}>Observation</span> and{' '}
                    <span style={MONO}>DiagnosticReport</span> for{' '}
                    <span style={MONO}>{shortId(smart.patient)}</span> over the session token — three real
                    reads — then runs them through the same ingestion and re-scoring as a pasted bundle. The
                    server is named once, under{' '}
                    <span className="font-semibold">Issuer (iss)</span> in the session panel.
                  </>
                ) : (
                  <>
                    Needs an active SMART session with a patient in context: launch NeuroPilot from the EHR. For a
                    standalone launch, name the chart under{' '}
                    <span className="font-semibold">Standalone launch</span> above and launch again.
                  </>
                )}
              </p>
            </div>
            <Btn
              tone="primary"
              icon={DownloadCloud}
              onClick={doImportFromEhr}
              disabled={!canImport || busy === 'smart-import'}
            >
              Import patient from EHR
            </Btn>
          </div>
        </div>

        {importResult && (
          <div className="mt-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />{' '}
              {importResult.duplicate
                ? 'Chart already imported — nothing re-scored'
                : importResult.created
                  ? 'Patient imported and scored'
                  : 'Patient refreshed and re-scored'}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {[
                ['Subject', importResult.subject_id],
                // The record is FILED under a NeuroPilot number, but the EHR's own
                // id is the real-world handle: it is shown, never hidden behind
                // the rename.
                ['EHR record', importResult.ehr_patient_id],
                ['Risk score', score(importResult.score)],
                ['Tier', importResult.risk_tier || '—'],
                ['Stage', importResult.stage_name || importResult.stage || '—'],
                ['Observations read', importResult.fetched?.Observation],
                ['Reports read', importResult.fetched?.DiagnosticReport],
                ['Mapped', importResult.mapped?.observations],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-lg border border-emerald-500/20 bg-white/60 px-2.5 py-1.5 dark:bg-black/10"
                >
                  <p className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-emerald-800/70 dark:text-emerald-300/70">
                    {label}
                  </p>
                  <p style={MONO} className="mt-0.5 truncate text-[11px] font-bold text-emerald-900 dark:text-emerald-200">
                    {value ?? '—'}
                  </p>
                </div>
              ))}
            </div>
            {importResult.ehr_iss && (
              <p className="mt-2 truncate text-[10px] text-emerald-800/80 dark:text-emerald-300/70">
                Read from <span style={MONO}>{importResult.ehr_iss}</span>
              </p>
            )}
            {importResult.summary && (
              <p style={MONO} className="mt-2 text-[10.5px] leading-relaxed text-emerald-800 dark:text-emerald-300">
                {importResult.summary}
              </p>
            )}
            {importResult.identity_note && (
              <p className="mt-2 rounded-lg border border-amber-500/35 bg-amber-500/10 p-2 text-[10.5px] leading-relaxed text-amber-700 dark:text-amber-400">
                Identity note: {importResult.identity_note}.
              </p>
            )}
            {importResult.ignored?.length > 0 && (
              <details className="mt-2">
                <summary className="cursor-pointer text-[10.5px] font-semibold text-emerald-800 dark:text-emerald-300">
                  {importResult.ignored.length} resource(s) read but not part of the mapped feature set
                </summary>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto">
                  {importResult.ignored.map((line) => (
                    <li key={line} style={MONO} className="text-[10px] leading-relaxed text-emerald-900/80 dark:text-emerald-200/80">
                      {line}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {onOpenPatient && importResult.subject_id && (
              <button
                onClick={() => onOpenPatient(importResult.subject_id)}
                className="mt-3 inline-flex items-center gap-1.5 rounded-xl border border-emerald-600/40 bg-white px-3 py-1.5 text-[10.5px] font-bold text-emerald-800 transition hover:bg-emerald-50 dark:border-emerald-400/35 dark:bg-transparent dark:text-emerald-300"
              >
                Open the imported record <ExternalLink className="h-3 w-3 opacity-60" />
              </button>
            )}
          </div>
        )}

        {/*
         * A rejection is rendered OUTSIDE the tester below, because both routes
         * end here: the import reports its own 401/422 through the same state, and
         * an error that only appears inside a collapsed disclosure is an error
         * nobody sees.
         */}
        {ingestIssues.length > 0 && (
          <div className="mt-3 rounded-xl border border-red-500/35 bg-red-500/10 p-3">
            <p className="flex items-center gap-1.5 text-[10.5px] font-bold uppercase tracking-[0.1em] text-red-600 dark:text-red-400">
              <XCircle className="h-3.5 w-3.5" /> Rejected — nothing was written
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

        {/*
         * The manual tester for POST /fhir/Bundle, collapsed by default. Importing
         * the patient in context is the clinician's path; posting a Bundle by hand
         * is the integrator's and the demo's. Collapsed rather than deleted, because
         * the endpoint is the real server-to-server route a hospital pushes to, and
         * this is the only surface that exercises it with no EHR in the room.
         */}
        <details className="group mt-4 border-t border-line pt-3 dark:border-darkBorder">
          <summary className="flex cursor-pointer flex-wrap items-center gap-2 text-[10.5px] font-semibold text-muted dark:text-darkMuted">
            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
            Manual bundle tester
            <span style={MONO} className="text-[10px] font-medium text-muted dark:text-darkMuted">
              POST /fhir/Bundle
            </span>
            <span className="font-normal">— paste what a hospital integration would push</span>
          </summary>

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
        </details>
      </div>

      {/* ABDM (India) — a different national gateway, not FHIR phase 5. */}
      <AbdmPanel patients={patients} initialPatientId={patientId} onToast={onToast} />
    </div>
  );
}
