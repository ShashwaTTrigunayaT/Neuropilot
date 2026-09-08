import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  LayoutDashboard,
  Moon,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Users,
} from 'lucide-react';
import AllPatients from './components/AllPatients.jsx';
import { NeuroPilotLogo } from './components/BrandLogo.jsx';
import Footer from './components/Footer.jsx';
import Overview from './components/Overview.jsx';
import PatientDetail from './components/PatientDetail.jsx';
import RiskSimulator from './components/RiskSimulator.jsx';
import { MONO, Toast } from './components/widgets.jsx';
import { API_BASE, api } from './api.js';

function Header({ theme, onToggleTheme, currentView, onViewChange, patientCount, isDetailOpen, autopilot, onToggleAutopilot, autoBusy }) {
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
        </nav>

        {/* Autonomous Triage + Theme Switcher */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={onToggleAutopilot}
            disabled={autoBusy && !autopilot}
            title="The model ranks the cohort and autonomously performs the next indicated test on the top-priority subject, re-scoring after every result"
            className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold shadow-soft transition active:scale-[0.97] ${
              autopilot
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
                Autonomous Triage ON
              </>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                Autonomous Triage
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
  const [globalImportance, setGlobalImportance] = useState([]);
  const [modelInfo, setModelInfo] = useState(null);
  const [dataSource, setDataSource] = useState('');
  const [status, setStatus] = useState('loading');
  const [loadError, setLoadError] = useState('');

  const [view, setView] = useState('overview'); // overview | all | simulator
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

  const showToast = (title, message = '', type = 'success') => {
    setToast({ title, message, type });
    setTimeout(() => {
      setToast((cur) => (cur?.title === title ? null : cur));
    }, 4000);
  };

  const loadAll = useCallback(async () => {
    setStatus('loading');
    setLoadError('');
    try {
      const [list, info, health] = await Promise.all([
        api.listAllPatients(),
        api.modelInfo(),
        api.health(),
      ]);
      setPatients(list);
      setGlobalImportance(info.available && info.global_importance ? info.global_importance : []);
      setModelInfo(info);
      setDataSource(health.data_source || '');
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message);
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

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
        // 12-month forecast loads alongside (non-blocking failure: the detail
        // view simply renders without the forecast card if unavailable)
        api.getProgression(id).then(setProgression).catch(() => setProgression(null));
      } catch (err) {
        setDetailError(err.message);
        setDetailStatus('error');
      }
    },
    []
  );

  const openPatient = (id) => {
    setSelectedId(id);
    loadDetail(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleBack = () => {
    setSelectedId(null);
    setDetail(null);
    setPipeline(null);
    setDetailStatus('idle');
    setAdvanceError('');
  };

  const handleAdvance = async (override = false, note = '') => {
    if (!selectedId) return;
    setAdvanceBusy(true);
    setAdvanceError('');
    const scoreBefore = detail?.score;
    try {
      const res = await api.advanceStage(selectedId, { override, note: note || null });
      await Promise.all([loadDetail(selectedId), loadAll()]);
      const scoreAfter = res?.new_score;
      const moved =
        typeof scoreBefore === 'number' && typeof scoreAfter === 'number' && Math.abs(scoreAfter - scoreBefore) >= 0.005;
      const resultInfo = res?.result ? ` ${res.result.slot.toUpperCase()} result: ${res.result.outcome}.` : '';
      const scoreInfo = moved ? ` Risk re-scored ${scoreBefore.toFixed(2)} → ${scoreAfter.toFixed(2)} (${res.new_tier} tier).` : '';
      showToast(
        override ? 'Clinician Override Recorded' : 'Test Ordered — Result Arrived',
        (override ? 'Bypassed stage gate with documented note.' : 'Result auto-derived and model re-ran on the new values.') +
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
      await loadAll();
      if (step.applied && step.subject) {
        const s = step.subject;
        const rankNote =
          s.rank_before && s.rank_after && s.rank_before !== s.rank_after
            ? s.rank_after < s.rank_before
              ? ` ↑ climbed #${s.rank_before} → #${s.rank_after}`
              : ` ↓ slipped #${s.rank_before} → #${s.rank_after}`
            : '';
        setAutoLog((log) =>
          [
            {
              id: `${s.id}-${s.stage_after}-${Date.now()}`,
              text: `${s.id} · ${s.slot.toUpperCase()} ${s.outcome} · ${s.score_before.toFixed(2)} → ${s.score_after.toFixed(2)} (${s.tier_after})${rankNote}`,
            },
            ...log,
          ].slice(0, 4)
        );
        return true; // more work likely remains
      }
      if (step.done) {
        setAutopilot(false);
        showToast('Autonomous Triage Complete', step.reason ?? 'All pathways complete.', 'success');
      } else {
        setAutopilot(false);
        showToast('Autonomous Triage Stopped', step.reason ?? 'No further test indicated.', 'error');
      }
      return false;
    } catch (err) {
      setAutopilot(false);
      showToast('Autonomous Triage Failed', err.message, 'error');
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
      await Promise.all([loadDetail(selectedId), loadAll()]);
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
      if (e.key === 'Escape' && selectedId) {
        handleBack();
      }
      if (selectedId) {
        if (e.key === 'ArrowLeft' && hasPrev) handlePrev();
        if (e.key === 'ArrowRight' && hasNext) handleNext();
      } else {
        if (e.key === 'd' || e.key === 'D') handleNavChange('overview');
        if (e.key === 'p' || e.key === 'P') handleNavChange('all');
        if (e.key === 's' || e.key === 'S') handleNavChange('simulator');
        if (e.key === 't' || e.key === 'T') toggleTheme();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedId, hasPrev, hasNext, currentIndex]);

  const handleNavChange = (targetView) => {
    setSelectedId(null);
    setView(targetView);
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
        onToggleAutopilot={() => {
          if (!autopilot) setAutoLog([]);
          setAutopilot((a) => !a);
        }}
        autoBusy={autoBusy}
      />

      <main className="mx-auto w-full max-w-6xl flex-1 px-6 py-8">
        {autopilot && (
          <div className="mb-6 rounded-2xl border border-accent/40 bg-accent/5 dark:bg-accent/10 px-5 py-3.5 animate-fade-up">
            <div className="flex items-center gap-2.5">
              <span className="relative flex h-2.5 w-2.5 shrink-0">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
              </span>
              <p className="text-xs font-bold text-accent">Autonomous Triage running — the model is working the priority queue</p>
              {autoBusy && <span className="text-[10.5px] font-medium text-muted dark:text-darkMuted">processing step…</span>}
            </div>
            {autoLog.length > 0 && (
              <ul className="mt-2.5 space-y-1">
                {autoLog.map((l) => (
                  <li key={l.id} style={MONO} className="text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                    {l.text}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
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
                  globalImportance={globalImportance}
                  modelInfo={modelInfo}
                  onSelect={openPatient}
                  onShowAll={() => setView('all')}
                  onOpenSimulator={() => setView('simulator')}
                />
              )}

              {view === 'all' && (
                <AllPatients
                  patients={patients}
                  onSelect={openPatient}
                  onSimulate={handleSimulate}
                />
              )}

              {view === 'simulator' && (
                <RiskSimulator
                  initialPatient={simulatedPatient}
                  onSelectPatient={openPatient}
                />
              )}
            </div>

            {/* Patient Detail View */}
            {selectedId && (
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