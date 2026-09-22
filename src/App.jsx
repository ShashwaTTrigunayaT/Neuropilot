import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  LayoutDashboard,
  Moon,
  Plug,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Users,
  Workflow,
} from 'lucide-react';
import AllPatients from './components/AllPatients.jsx';
import AutonomousTriage from './components/AutonomousTriage.jsx';
import { NeuroPilotLogo } from './components/BrandLogo.jsx';
import CompareView from './components/CompareView.jsx';
import Footer from './components/Footer.jsx';
import Interoperability from './components/Interoperability.jsx';
import Overview from './components/Overview.jsx';
import PatientDetail from './components/PatientDetail.jsx';
import ProgressionView from './components/ProgressionView.jsx';
import RiskSimulator from './components/RiskSimulator.jsx';
import { MONO, Toast } from './components/widgets.jsx';
import { API_BASE, api } from './api.js';

function Header({ theme, onToggleTheme, currentView, onViewChange, patientCount, isDetailOpen, autopilot, onStopAutopilot }) {
  return (
    <header className="sticky top-0 z-30 border-b border-line dark:border-darkBorder bg-white/85 dark:bg-darkCard/85 backdrop-blur-xl shadow-soft transition-colors">
      <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3">
        {/* Brand & App Icon */}
        <NeuroPilotLogo onClick={() => onViewChange('overview')} />

        {/* Shifted Main Navigation Tabs */}
        <nav className="flex items-center gap-1 rounded-2xl border border-line dark:border-darkBorder bg-[#F7F5F1] dark:bg-darkBorderSubtle p-1 shadow-soft">
          <button
            onClick={() => onViewChange('overview')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] ${
              currentView === 'overview' && !isDetailOpen
                ? 'bg-white dark:bg-darkCard text-ink dark:text-darkText shadow-soft'
                : 'text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText'
            }`}
          >
            <LayoutDashboard className="h-3.5 w-3.5" />
            Dashboard
          </button>
          <button
            onClick={() => onViewChange('all')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] ${
              currentView === 'all' || isDetailOpen
                ? 'bg-white dark:bg-darkCard text-ink dark:text-darkText shadow-soft'
                : 'text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText'
            }`}
          >
            <Users className="h-3.5 w-3.5" />
            Patients
            <span
              style={MONO}
              className={`rounded-full px-1.5 py-0.2 text-[10px] ${
                currentView === 'all' || isDetailOpen
                  ? 'bg-accent/15 text-accent font-bold'
                  : 'bg-tint dark:bg-darkCard text-muted'
              }`}
            >
              {patientCount}
            </span>
          </button>
          <button
            onClick={() => onViewChange('simulator')}
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] ${
              currentView === 'simulator' && !isDetailOpen
                ? 'bg-white dark:bg-darkCard text-accent shadow-soft font-bold'
                : 'text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText'
            }`}
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Risk Simulator
          </button>
          <button
            onClick={() => onViewChange('interop')}
            title="HL7 FHIR R4 exchange — export, inbound ingestion, orders/results and SMART launch"
            className={`inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-xs font-semibold transition active:scale-[0.97] ${
              currentView === 'interop'
                ? 'bg-white dark:bg-darkCard text-accent shadow-soft font-bold'
                : 'text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText'
            }`}
          >
            <Plug className="h-3.5 w-3.5" />
            Interoperability
          </button>
        </nav>

        {/* Autonomous Neuro + Theme Switcher */}
        <div className="flex items-center gap-2.5">
          {/*
           * This button is the ONLY autonomous control that lives outside the
           * view tree, on purpose: the loop refreshes data underneath it, so a
           * stop control rendered inside a view can be unmounted mid-run. While
           * the loop is on it becomes Stop, in the sticky header, whatever view
           * you are on — and Esc does the same thing.
           */}
          <button
            onClick={() => (autopilot ? onStopAutopilot() : onViewChange('autonomous'))}
            title={
              autopilot
                ? 'Stop the supervised run (or press Esc)'
                : 'The model proposes the next batch of tests with its reasoning; a clinician approves what actually runs'
            }
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold shadow-soft transition active:scale-[0.97] ${
              autopilot
                ? 'bg-tierHigh text-white hover:opacity-90'
                : currentView === 'autonomous' && !isDetailOpen
                  ? 'bg-accent text-white'
                  : 'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText hover:border-accent'
            }`}
          >
            {autopilot ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                Stop
              </>
            ) : (
              <>
                <Workflow className="h-3 w-3" strokeWidth={2.4} />
                Autonomous Neuro
              </>
            )}
          </button>
          <button
            onClick={onToggleTheme}
            aria-label="Toggle theme"
            className="flex h-8 w-8 items-center justify-center rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText shadow-soft hover:border-accent transition"
            title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
          >
            {theme === 'dark' ? (
              <Sun className="h-4 w-4 text-amber-500" />
            ) : (
              <Moon className="h-4 w-4 text-slate-700" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}

function CohortSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="h-8 w-56 rounded-xl bg-line dark:bg-darkBorder" />
      <div className="grid gap-6 sm:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-2xl bg-line dark:bg-darkBorder" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="h-56 rounded-2xl bg-line dark:bg-darkBorder" />
        <div className="h-56 rounded-2xl bg-line dark:bg-darkBorder" />
      </div>
    </div>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="h-6 w-48 rounded-lg bg-line dark:bg-darkBorder" />
      <div className="grid gap-8 lg:grid-cols-5">
        <div className="space-y-6 lg:col-span-3">
          <div className="h-64 rounded-2xl bg-line dark:bg-darkBorder" />
          <div className="h-40 rounded-2xl bg-line dark:bg-darkBorder" />
        </div>
        <div className="h-80 rounded-2xl bg-line dark:bg-darkBorder lg:col-span-2" />
      </div>
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(() => {
    return localStorage.getItem('theme') || 'light';
  });

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'));

  const [patients, setPatients] = useState([]);
  const [modelInfo, setModelInfo] = useState(null);
  const [dataSource, setDataSource] = useState('');
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');

  // overview | all | simulator | interop | autonomous | progression | compare
  const [view, setView] = useState('overview');
  const [selectedId, setSelectedId] = useState(null);
  const [simulatedPatient, setSimulatedPatient] = useState(null);
  const [detail, setDetail] = useState(null);
  const [pipeline, setPipeline] = useState(null);
  const [progression, setProgression] = useState(null);
  const [detailStatus, setDetailStatus] = useState('idle');
  const [detailError, setDetailError] = useState('');
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [advanceError, setAdvanceError] = useState('');
  const [toast, setToast] = useState(null);
  // Autonomous triage ("autopilot"): the backend picks the subject and test
  const [autopilot, setAutopilot] = useState(false);
  const [autoLog, setAutoLog] = useState([]); // last autonomous steps for the live banner
  const [autoBusy, setAutoBusy] = useState(false);
  // Priority comparison (2..6 selected patients)
  const [compareIds, setCompareIds] = useState([]);
  const [compare, setCompare] = useState(null);
  const [compareStatus, setCompareStatus] = useState('idle');
  const [compareError, setCompareError] = useState('');

  const showToast = (title, message = '', type = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => {
      setToast((cur) => (cur?.title === title ? null : cur));
    }, 4000);
  };

  /*
   * `silent` separates a FIRST load from a BACKGROUND refresh.
   *
   * The loading branch below replaces the whole view tree with a skeleton, and
   * the ready branch re-mounts it with `animate-fade-up`. That is correct once,
   * on boot — but the autopilot tick refreshes the cohort every ~1.4 s, so a
   * non-silent refresh there collapsed and re-expanded the page on a loop and
   * destroyed whatever control the user was reaching for (including Stop).
   * A background refresh therefore updates the data in place and leaves the DOM
   * — and the scroll position — alone.
   */
  const loadAll = useCallback(async (opts) => {
    // `opts` can be a React click event (the Retry button passes it straight
    // through), so only an explicit object flag counts.
    const silent = typeof opts === 'object' && opts !== null && opts.silent === true;
    if (!silent) setStatus('loading');
    setLoadError('');
    try {
      const [list, info, health] = await Promise.all([
        api.listAllPatients(),
        api.modelInfo(),
        api.health(),
      ]);
      setPatients(list);
      // modelInfo carries the served model card plus the retained family under
      // `legacy`; the Overview radar reads the served card's attribution.
      setModelInfo(info);
      setDataSource(health.data_source || '');
      setStatus('ready');
    } catch (err) {
      // A failed background refresh must not tear down a view that is still
      // usable: the next explicit action reports the error instead.
      if (silent) return;
      setLoadError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // SMART on FHIR hand-off: after the backend exchanges the authorization code
  // it redirects the browser back here with ?smart=connected&patient=… — land
  // on the interoperability view and say what was bound.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('smart') !== 'connected') return;
    const patient = params.get('patient');
    setView('interop');
    setToast({
      title: 'SMART session connected',
      message: patient ? `Patient in context: ${patient}` : 'Launch complete.',
      type: 'success',
    });
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const loadDetail = useCallback(
    async (id) => {
      setDetailStatus('loading');
      setDetailError('');
      setAdvanceError('');
      try {
        const [d, p] = await Promise.all([api.getPatient(id), api.getPipeline(id)]);
        setDetail(d);
        setPipeline(p);
        setDetailStatus('ready');
        // outlook loads alongside (non-blocking failure: the detail
        // view simply renders without the forecast card if unavailable)
        api.getOutlook(id).then(setProgression).catch(() => setProgression(null));
      } catch (err) {
        setDetailError(err.message);
        setDetailStatus('error');
      }
    },
    []
  );

  const openPatient = (id) => {
    if (view === 'compare') setView('all'); // leaving comparison — open the record underneath
    setSelectedId(id);
    loadDetail(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    setSelectedId(null);
    setDetail(null);
    setPipeline(null);
    setProgression(null);
    setDetailStatus('idle');
    setAdvanceError('');
  };

  const handleAdvance = async (override = false, note = '') => {
    if (!selectedId) return;
    setAdvanceBusy(true);
    setAdvanceError('');
    const scoreBefore = detail?.score;
    const priorityBefore = detail?.final_score ?? detail?.score;
    try {
      const res = await api.advanceStage(selectedId, { override, note: note || null });
      await Promise.all([loadDetail(selectedId), loadAll({ silent: true })]);
      const scoreAfter = res?.new_score;
      const priorityAfter = res?.new_priority_score ?? scoreAfter;
      const officialMoved =
        typeof scoreBefore === 'number' && typeof scoreAfter === 'number' && Math.abs(scoreAfter - scoreBefore) >= 0.005;
      const priorityMoved =
        typeof priorityBefore === 'number' && typeof priorityAfter === 'number' && Math.abs(priorityAfter - priorityBefore) >= 0.005;
      // A real measurement on file is incorporated; a slot with nothing on file
      // is simply ordered and the score deliberately stays put.
      const r = res?.result;
      const onFile = r?.status === 'completed';
      const resultInfo = !r
        ? ''
        : onFile
          ? ` ${r.slot.toUpperCase()} result on file (${r.outcome}) incorporated.`
          : ` ${r.slot.toUpperCase()} ordered — no result available in this cohort yet.`;
      const scoreInfo = onFile
        ? officialMoved
          ? ` Official score ${scoreBefore.toFixed(2)} → ${scoreAfter.toFixed(2)}; priority ${priorityBefore.toFixed(2)} → ${priorityAfter.toFixed(2)} (${res.new_tier} tier).`
          : ` Official score remains ${scoreBefore.toFixed(2)}; priority remains ${priorityBefore.toFixed(2)} (${res.new_tier} tier).`
        : ` Official score remains ${scoreBefore.toFixed(2)}; predicted stage is not official evidence; priority ${priorityBefore.toFixed(2)} → ${priorityAfter.toFixed(2)}${priorityMoved ? ' (changed)' : ' (unchanged)'} (${res.new_tier} tier).`;
      showToast(
        override ? 'Clinician Override Recorded' : onFile ? 'Result On File — Incorporated' : 'Test Ordered',
        (override
          ? 'Bypassed stage gate with documented note.'
          : onFile
            ? 'An existing measurement entered the pathway and the model re-ran on it.'
            : 'No result to return, so the official score is unchanged; the priority score may use the predicted stage — nothing was invented to fill the gap.') +
          resultInfo +
          scoreInfo,
        'success'
      );
    } catch (err) {
      setAdvanceError(err.message);
      showToast('Action Failed', err.message, 'error');
    } finally {
      setAdvanceBusy(false);
    }
  };

  // One autonomous tick: backend picks the subject, runs one test, rescores.
  const runAutoTick = useCallback(async () => {
    setAutoBusy(true);
    try {
      const step = await api.workupNext();
      // Silent: the loop must not remount the page (and its own Stop button).
      await loadAll({ silent: true });
      if (step.applied && step.subject) {
        const s = step.subject;
        const rankNote =
          s.rank_before && s.rank_after && s.rank_before !== s.rank_after
            ? s.rank_after < s.rank_before
              ? ` ↑ climbed #${s.rank_before} → #${s.rank_after}`
              : ` ↓ slipped #${s.rank_before} → #${s.rank_after}`
            : '';
        // Keep the WHOLE step, not just a formatted line: the console renders
        // the same reasoning the approvable batch shows, so the loop is not a
        // black box. `text` stays for the one-line global indicator strip.
        // 60 entries is cheap now that the log lives in its own fixed-height
        // scroll region instead of extending the page.
        setAutoLog((log) =>
          [
            {
              id: `${s.id}-${s.stage_after}-${Date.now()}`,
              step: s,
              text: `${s.id} · ${s.slot.toUpperCase()} ${
                s.result_on_file ? `${s.outcome} · real result incorporated` : 'no result · predicted stage used for priority only'
              } · priority ${s.priority_score_before?.toFixed(2) ?? s.score_before.toFixed(2)} → ${s.priority_score_after?.toFixed(2) ?? s.score_after.toFixed(2)}${
                !s.result_on_file && s.official_score_before != null
                  ? ` · official remains ${s.official_score_before.toFixed(2)}`
                  : s.result_on_file && s.official_score_after != null
                    ? ` · official ${s.official_score_after.toFixed(2)}`
                    : ''
              } · ${s.tier_after}${rankNote}`,
            },
            ...log,
          ].slice(0, 60)
        );
        return true; // more work likely remains
      }
      if (step.done) {
        setAutopilot(false);
        showToast('Autonomous Neuro Complete', step.reason ?? 'All pathways complete.', 'success');
      } else {
        setAutopilot(false);
        showToast('Autonomous Neuro Stopped', step.reason ?? 'No further test indicated.', 'error');
      }
      return false;
    } catch (err) {
      setAutopilot(false);
      showToast('Autonomous Neuro Failed', err.message, 'error');
      return false;
    } finally {
      setAutoBusy(false);
    }
  }, [loadAll]);

  // Autopilot loop: step every ~1.4s while enabled
  useEffect(() => {
    if (!autopilot) return;
    let cancelled = false;
    let timer;
    const loop = async () => {
      const more = await runAutoTick();
      if (cancelled) return;
      timer = setTimeout(loop, more ? 1400 : 100);
    };
    loop();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [autopilot, runAutoTick]);

  const handleRecordResult = async (slot, body) => {
    if (!selectedId) return;
    const scoreBefore = detail?.score;
    try {
      const res = await api.recordResult(selectedId, {
        slot,
        outcome: body.outcome,
        values: body.values || {},
        note: body.note || null,
      });
      await Promise.all([loadDetail(selectedId), loadAll({ silent: true })]);
      const scoreAfter = res?.new_score;
      const moved =
        typeof scoreBefore === 'number' && typeof scoreAfter === 'number' && Math.abs(scoreAfter - scoreBefore) >= 0.005;
      const slotLabel = { blood: 'Blood panel', imaging: 'MRI', pet: 'PET' }[slot] ?? slot;
      showToast(
        'Result Recorded — Model Re-scored',
        `${slotLabel} ${body.outcome}.` +
          (moved ? ` Risk ${scoreBefore.toFixed(2)} → ${scoreAfter.toFixed(2)} (${res.new_tier} tier).` : ' Score unchanged — cognition remains the dominant driver.'),
        'success'
      );
    } catch (err) {
      showToast('Recording Failed', err.message, 'error');
      throw err;
    }
  };

  const handleSimulate = (patientRecord) => {
    setSimulatedPatient(patientRecord);
    setSelectedId(null);
    setView('simulator');
  };

  // Priority comparison: fetch the explicit tiebreak ranking for the selection
  const handleCompare = useCallback(
    async (ids) => {
      if (!ids || ids.length < 2) return;
      setCompareIds(ids);
      setCompareStatus('loading');
      setCompareError('');
      setView('compare');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      try {
        const payload = await api.comparePatients(ids);
        setCompare(payload);
        setCompareStatus('ready');
      } catch (err) {
        setCompareError(err.message);
        setCompareStatus('error');
      }
    },
    []
  );

  // Previous & Next navigation for patient detail
  const currentIndex = patients.findIndex((p) => p.id === selectedId);
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < patients.length - 1;
  const handlePrev = () => {
    if (hasPrev) openPatient(patients[currentIndex - 1].id);
  };
  const handleNext = () => {
    if (hasNext) openPatient(patients[currentIndex + 1].id);
  };

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      // Escape stops a running loop FIRST: the surest way out of a page that is
      // updating underneath you is a key that cannot be scrolled away from.
      if (e.key === 'Escape' && autopilot) {
        setAutopilot(false);
        return;
      }
      if (e.key === 'Escape' && view === 'compare') {
        setView('all');
        return;
      }
      if (e.key === 'Escape' && selectedId) {
        if (view === 'progression') {
          closeProgression(); // Esc: back to the patient record
        } else {
          handleBack();
        }
      }
      if (selectedId) {
        if (e.key === 'ArrowLeft' && hasPrev) handlePrev();
        if (e.key === 'ArrowRight' && hasNext) handleNext();
      } else {
        if (e.key === 'd' || e.key === 'D') handleNavChange('overview');
        if (e.key === 'p' || e.key === 'P') handleNavChange('all');
        if (e.key === 's' || e.key === 'S') handleNavChange('simulator');
        if (e.key === 'f' || e.key === 'F') handleNavChange('interop');
        if (e.key === 'a' || e.key === 'A') handleNavChange('autonomous');
        if (e.key === 't' || e.key === 'T') toggleTheme();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, view, hasPrev, hasNext, currentIndex, autopilot]);

  const handleNavChange = (targetView) => {
    if (targetView !== 'progression') setSelectedId(null);
    setView(targetView);
  };

  const openProgression = () => setView('progression');
  // Return from the progression view to the patient record underneath it
  const closeProgression = () => setView('overview');
  // Leave the progression view entirely (back to the cohort list)
  const handleBackFromProgression = () => {
    handleBack();
    setView('overview');
  };

  return (
    <div className="flex min-h-screen flex-col bg-paper dark:bg-darkBg text-ink dark:text-darkText transition-colors duration-300">
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        currentView={view}
        onViewChange={handleNavChange}
        patientCount={patients.length}
        isDetailOpen={Boolean(selectedId)}
        autopilot={autopilot}
        onStopAutopilot={() => setAutopilot(false)}
      />

      {/*
       * Global loop indicator. The console owns the full step log, but a loop
       * that is mutating the cohort must be visible from every view. Height is
       * fixed to one line, so it never reflows the page while running — the
       * whole point of the silent refresh underneath it.
       */}
      {autopilot && view !== 'autonomous' && (
        <div className="border-b border-accent/30 bg-accent/[0.06] dark:bg-accent/10">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2.5 px-6 py-2">
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            <p className="shrink-0 text-[11.5px] font-bold text-accent">Autonomous Neuro running</p>
            {autoLog[0] && (
              <p
                style={MONO}
                className="min-w-0 flex-1 truncate text-[10.5px] text-muted dark:text-darkMuted"
              >
                {autoLog[0].text}
              </p>
            )}
            <button
              onClick={() => setAutopilot(false)}
              className="ml-auto shrink-0 rounded-lg bg-tierHigh px-2.5 py-1 text-[10.5px] font-bold text-white transition hover:opacity-90"
            >
              Stop (Esc)
            </button>
          </div>
        </div>
      )}

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {status === 'loading' && !selectedId && <CohortSkeleton />}
        {status === 'loading' && selectedId && <DetailSkeleton />}

        {status === 'error' && (
          <div className="mx-auto max-w-sm flex flex-col items-center py-28 text-center animate-fade-up">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard shadow-float text-tierHigh">
              <AlertCircle className="h-7 w-7" />
            </div>
            <h2 className="mt-5 text-base font-bold text-ink dark:text-darkText">
              Cannot Reach Decision API
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-muted dark:text-darkMuted">{loadError}</p>
            <button
              onClick={loadAll}
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-accent px-5 py-2.5 text-xs font-semibold text-white shadow-soft transition hover:bg-accentHover"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Retry Connection
            </button>
            <p style={MONO} className="mt-3 text-[10px] text-dust dark:text-darkMuted">{API_BASE}</p>
          </div>
        )}

        {status === 'ready' && (
          <>
            <div className={selectedId ? 'hidden' : 'animate-fade-up'}>
              {view === 'overview' && (
                <Overview
                  patients={patients}
                  modelInfo={modelInfo}
                  onSelect={openPatient}
                  onShowAll={() => setView('all')}
                  onOpenSimulator={() => setView('simulator')}
                  onViewChange={setView}
                />
              )}

              {view === 'all' && (
                <AllPatients
                  patients={patients}
                  onSelect={openPatient}
                  onSimulate={handleSimulate}
                  onCompare={handleCompare}
                />
              )}

              {view === 'simulator' && (
                <RiskSimulator
                  initialPatient={simulatedPatient}
                  onSelectPatient={openPatient}
                />
              )}

              {view === 'interop' && (
                <Interoperability
                  patients={patients}
                  initialPatientId={selectedId}
                  onToast={showToast}
                />
              )}

              {view === 'autonomous' && (
                <AutonomousTriage
                  onOpenPatient={openPatient}
                  onToast={showToast}
                  onRefresh={() => loadAll({ silent: true })}
                  autopilot={autopilot}
                  onToggleAutopilot={() => {
                    if (!autopilot) setAutoLog([]);
                    setAutopilot((a) => !a);
                  }}
                  autoBusy={autoBusy}
                  autoLog={autoLog}
                />
              )}
            </div>

            {/* Full-page priority comparison view */}
            {view === 'compare' && (
              <CompareView
                compare={compare}
                loading={compareStatus === 'loading'}
                error={compareError}
                onExit={() => setView('all')}
                onOpenPatient={openPatient}
              />
            )}

            {/* Full-page progression forecast view */}
            {view === 'progression' && selectedId && (
              <ProgressionView
                patient={detail}
                progression={progression}
                onExit={handleBackFromProgression}
                onOpenDetail={closeProgression}
              />
            )}

            {/* Patient Detail View */}
            {selectedId && view !== 'progression' && (
              <PatientDetail
                patient={detail}
                pipeline={pipeline}
                loading={detailStatus === 'loading'}
                error={detailStatus === 'error' ? detailError : ''}
                onBack={handleBack}
                onAdvance={handleAdvance}
                advanceBusy={advanceBusy}
                advanceError={advanceError}
                onRecordResult={handleRecordResult}
                progression={progression}
                onOpenProgression={openProgression}
                onPrev={handlePrev}
                onNext={handleNext}
                hasPrev={hasPrev}
                hasNext={hasNext}
              />
            )}
          </>
        )}
      </main>

      <Toast toast={toast} onClose={() => setToast(null)} />

      <Footer
        currentView={view}
        onViewChange={handleNavChange}
        theme={theme}
        onToggleTheme={toggleTheme}
        modelInfo={modelInfo}
        dataSource={dataSource}
        patientCount={patients.length}
        onRefresh={loadAll}
      />
    </div>
  );
}