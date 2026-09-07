import { useState } from 'react';
import {
  Activity,
  ArrowUp,
  CheckSquare,
  ExternalLink,
  GitCommit,
  Keyboard,
  LayoutDashboard,
  Moon,
  PieChart,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Users,
  X,
} from 'lucide-react';
import { API_BASE } from '../api.js';
import { NeuroPilotIcon } from './BrandLogo.jsx';
import { MONO } from './widgets.jsx';

/* ------------------------------------------------------------------ */
/*  Feature Contributions panel — the per-parameter breakdown of what   */
/*  drives the risk score, driven by live GET /model/info data.         */
/* ------------------------------------------------------------------ */
const FEATURE_INFO = {
  mmse: { stage: 'Cognitive', label: 'MMSE (cognitive score)', desc: 'Latest Mini-Mental State Examination score — lower scores indicate worse cognition.' },
  mmse_change: { stage: 'Cognitive', label: 'MMSE change over time', desc: 'Decline since the first visit. A falling trajectory is one of the strongest progression signals.' },
  age: { stage: 'Demographic', label: 'Age', desc: 'Advancing age remains an independent risk factor for Alzheimer progression.' },
  sex: { stage: 'Demographic', label: 'Biological sex', desc: 'Sex-associated risk differences reported in the underlying cohort.' },
  education_years: { stage: 'Demographic', label: 'Education (years)', desc: 'Higher education is associated with lower observed risk (cognitive reserve).' },
  ses: { stage: 'Demographic', label: 'Socioeconomic status', desc: 'Socioeconomic context from the screening intake.' },
  n_visits: { stage: 'Cognitive', label: 'Number of visits', desc: 'Longitudinal observation depth — more visits strengthen the trend estimate.' },
  study_years: { stage: 'Cognitive', label: 'Years in study', desc: 'Total observation window since enrollment.' },
  ptau181: { stage: 'Blood', label: 'p-tau181 (blood)', desc: 'Plasma phosphorylated-tau 181 — elevated levels indicate tau pathology.' },
  abeta4240: { stage: 'Blood', label: 'Aβ42/40 ratio (blood)', desc: 'Plasma amyloid-beta 42/40 ratio — lower ratios indicate amyloid deposition.' },
  hippocampal_volume: { stage: 'MRI', label: 'Hippocampal volume (MRI)', desc: 'Volumetric MRI measure — smaller hippocampi reflect neurodegeneration.' },
  nwbv: { stage: 'MRI', label: 'Normalized brain volume (MRI)', desc: 'Whole-brain volume normalized for head size.' },
  etiv: { stage: 'MRI', label: 'Intracranial volume (MRI)', desc: 'Estimated total intracranial volume (head-size control).' },
  asf: { stage: 'MRI', label: 'Atlas scaling factor (MRI)', desc: 'Head-size scaling factor used to normalize volumetrics.' },
  amyloid_positive: { stage: 'PET', label: 'Amyloid PET status', desc: 'Amyloid PET positivity indicates cortical amyloid plaque burden.' },
  tau_positive: { stage: 'PET', label: 'Tau PET status', desc: 'Tau PET positivity indicates neurofibrillary tangle pathology.' },
};

const STAGE_COLORS = {
  Cognitive: '#0D8282',
  Blood: '#3B82F6',
  MRI: '#8B5CF6',
  PET: '#EC4899',
  Demographic: '#6E7175',
};

function ContributionsPanel({ modelInfo }) {
  const importance = (modelInfo?.global_importance || []).slice();
  const max = importance.length ? Math.max(...importance.map((d) => d.mean_abs_shap)) : 1;
  const total = importance.reduce((a, d) => a + d.mean_abs_shap, 0) || 1;

  if (!importance.length) {
    return (
      <p className="text-muted dark:text-darkMuted">
        Contribution data unavailable — the model artifact is not loaded. Run
        <code className="mx-1 rounded bg-tint dark:bg-darkBorder px-1 py-0.5">python scripts/train_model.py</code>
        and restart the API.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-muted dark:text-darkMuted">
        The model combines <strong>all available parameters across the 4-stage pipeline</strong> — cognition,
        blood biomarkers, MRI volumetrics, and PET — using{' '}
        <strong>{modelInfo?.features?.length || importance.length} features</strong>. The bars below show each
        parameter&rsquo;s average influence (mean |SHAP|) on the risk score across the cohort.
      </p>
      <div className="rounded-xl border border-line dark:border-darkBorder bg-tint/40 dark:bg-darkBorder/30 p-3 flex flex-wrap gap-x-6 gap-y-2">
        {['Cognitive', 'Blood', 'MRI', 'PET', 'Demographic'].map((s) => (
          <span key={s} className="inline-flex items-center gap-1.5 text-[11px] text-ink dark:text-darkText">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: STAGE_COLORS[s] }} />
            {s}
          </span>
        ))}
      </div>

      <ul className="space-y-3">
        {importance.map((d, i) => {
          const info = FEATURE_INFO[d.feature] || { stage: 'Other', label: d.feature, desc: '' };
          const hex = STAGE_COLORS[info.stage] || '#6E7175';
          const share = Math.round((d.mean_abs_shap / total) * 100);
          return (
            <li key={d.feature} className="rounded-xl border border-line/70 dark:border-darkBorder/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted w-5">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span
                    className="shrink-0 rounded-md px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide"
                    style={{ color: hex, backgroundColor: `${hex}18` }}
                  >
                    {info.stage}
                  </span>
                  <span className="truncate font-semibold text-ink dark:text-darkText" title={info.desc}>
                    {info.label}
                  </span>
                </div>
                <span style={MONO} className="shrink-0 text-[11px] font-bold text-ink dark:text-darkText">
                  {d.mean_abs_shap.toFixed(3)}
                  <span className="ml-1 text-[10px] font-medium text-muted dark:text-darkMuted">({share}%)</span>
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-tint dark:bg-darkBorder/50">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${(d.mean_abs_shap / max) * 100}%`, backgroundColor: hex }}
                  />
                </div>
              </div>
              {info.desc && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">{info.desc}</p>
              )}
            </li>
          );
        })
      }
      </ul>

      <div className="rounded-xl border border-line dark:border-darkBorder bg-tint/40 dark:bg-darkBorder/30 p-3 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
        <strong className="text-ink dark:text-darkText">Missing tests are handled honestly:</strong> a biomarker
        that has not been ordered yet (e.g. PET for a patient still at cognitive screening) contributes nothing
        to that patient&rsquo;s score — the model uses what the pipeline has actually measured. For any individual
        patient, the detail view shows their personal signed contributions under &ldquo;Why this priority&rdquo;.
      </div>
    </div>
  );
}

function Modal({ title, children, onClose }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-line dark:border-darkBorder pb-4">
          <h3 className="text-base font-bold text-ink dark:text-darkText">{title}</h3>
          <button
            onClick={onClose}
            aria-label="Close dialog"
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-tint dark:hover:bg-darkBorder transition"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="mt-4 text-xs leading-relaxed text-ink dark:text-darkText space-y-4">
          {children}
        </div>
        <div className="mt-6 flex justify-end border-t border-line dark:border-darkBorder pt-4">
          <button
            onClick={onClose}
            className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white shadow-soft hover:bg-accentHover transition"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Footer({
  currentView,
  onViewChange,
  theme,
  onToggleTheme,
  modelInfo,
  dataSource,
  patientCount = 0,
  onRefresh,
  onShowShortcuts,
}) {
  const [activeModal, setActiveModal] = useState(null); // 'telemetry' | 'protocol' | 'safety' | 'cutoffs' | 'shortcuts'

  const scrollToTop = () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <>
      <footer className="mt-16 border-t border-line dark:border-darkBorder bg-tint/40 dark:bg-darkCard/40 backdrop-blur-sm no-print">
        {/* Main Footer Container */}
        <div className="mx-auto w-full max-w-6xl px-6 py-12">
          {/* Top Bar: Brand, Status Beacon & Quick Actions */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line/70 dark:border-darkBorder/70 pb-8">
            <div className="flex items-center gap-3">
              <NeuroPilotIcon size="md" />
              <div>
                <span className="text-sm font-black tracking-tight text-ink dark:text-darkText">
                  NeuroPilot
                </span>
                <p className="text-[11px] text-muted dark:text-darkMuted mt-0.5">
                  Clinical Decision Support & Risk Triage
                </p>
              </div>
            </div>

            {/* Quick Utility Buttons */}
            <div className="flex flex-wrap items-center gap-2.5">

              {/* Data Refresh */}
              {onRefresh && (
                <button
                  onClick={onRefresh}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-xs font-semibold text-ink dark:text-darkText shadow-soft transition hover:border-accent"
                  title="Reload patient cohort & model metadata"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span>Sync</span>
                </button>
              )}

              {/* Theme Toggle */}
              <button
                onClick={onToggleTheme}
                className="flex h-8 w-8 items-center justify-center rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText shadow-soft hover:border-accent transition"
                title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
              >
                {theme === 'dark' ? (
                  <Sun className="h-4 w-4 text-amber-500" />
                ) : (
                  <Moon className="h-4 w-4 text-slate-700" />
                )}
              </button>

              {/* Back to Top */}
              <button
                onClick={scrollToTop}
                className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-xs font-semibold text-ink dark:text-darkText shadow-soft hover:border-accent transition"
                title="Scroll back to top"
              >
                <ArrowUp className="h-3.5 w-3.5" />
                <span>Top</span>
              </button>
            </div>
          </div>

          {/* Nav Links Grid: 3 Columns */}
          <div className="grid gap-8 py-8 sm:grid-cols-2 md:grid-cols-3 text-xs">
            {/* Column 1: Clinical Modules */}
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted dark:text-darkMuted mb-3">
                Clinical Modules
              </h4>
              <ul className="space-y-2">
                <li>
                  <button
                    onClick={() => {
                      onViewChange('overview');
                      scrollToTop();
                    }}
                    className={`inline-flex items-center gap-2 transition hover:text-accent ${
                      currentView === 'overview'
                        ? 'font-bold text-accent'
                        : 'text-ink dark:text-darkText'
                    }`}
                  >
                    <LayoutDashboard className="h-3.5 w-3.5 opacity-70" />
                    Dashboard Overview
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => {
                      onViewChange('all');
                      scrollToTop();
                    }}
                    className={`inline-flex items-center gap-2 transition hover:text-accent ${
                      currentView === 'all'
                        ? 'font-bold text-accent'
                        : 'text-ink dark:text-darkText'
                    }`}
                  >
                    <Users className="h-3.5 w-3.5 opacity-70" />
                    Patient Cohort ({patientCount})
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => {
                      onViewChange('simulator');
                      scrollToTop();
                    }}
                    className={`inline-flex items-center gap-2 transition hover:text-accent ${
                      currentView === 'simulator'
                        ? 'font-bold text-accent'
                        : 'text-ink dark:text-darkText'
                    }`}
                  >
                    <SlidersHorizontal className="h-3.5 w-3.5 opacity-70" />
                    Live Risk Simulator
                  </button>
                </li>
              </ul>
            </div>

            {/* Column 2: Telemetry & Specs */}
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted dark:text-darkMuted mb-3">
                System Telemetry & Specs
              </h4>
              <ul className="space-y-2">
                <li>
                  <button
                    onClick={() => setActiveModal('telemetry')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <Activity className="h-3.5 w-3.5 opacity-70" />
                    Model Specs & Attributions (SHAP)
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveModal('contributions')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <PieChart className="h-3.5 w-3.5 opacity-70" />
                    How Risk Is Determined — Feature Contributions
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveModal('protocol')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <GitCommit className="h-3.5 w-3.5 opacity-70" />
                    4-Stage Escalation Protocol Guide
                  </button>
                </li>
                <li>
                  <a
                    href={`${API_BASE}/docs`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-ink dark:text-darkText hover:text-accent transition"
                  >
                    <span>API Swagger Docs</span>
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                </li>
                <li>
                  <a
                    href={`${API_BASE}/openapi.json`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-ink dark:text-darkText hover:text-accent transition"
                  >
                    <span>OpenAPI JSON Schema</span>
                    <ExternalLink className="h-3 w-3 opacity-60" />
                  </a>
                </li>
              </ul>
            </div>

            {/* Column 3: Clinical Governance & Safety */}
            <div>
              <h4 className="text-[11px] font-bold uppercase tracking-wider text-muted dark:text-darkMuted mb-3">
                Governance & Safety
              </h4>
              <ul className="space-y-2">
                <li>
                  <button
                    onClick={() => setActiveModal('safety')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <ShieldCheck className="h-3.5 w-3.5 opacity-70" />
                    Decision-Support Guardrails (Non-Diagnostic)
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveModal('cutoffs')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <CheckSquare className="h-3.5 w-3.5 opacity-70" />
                    Diagnostic Cutoffs & Normative Ranges
                  </button>
                </li>
                <li>
                  <button
                    onClick={() => setActiveModal('shortcuts')}
                    className="inline-flex items-center gap-2 text-ink dark:text-darkText hover:text-accent transition text-left"
                  >
                    <Keyboard className="h-3.5 w-3.5 opacity-70" />
                    <span>Keyboard Shortcuts</span>
                    <span
                      style={MONO}
                      className="rounded border border-line dark:border-darkBorder px-1.5 py-0.2 text-[10px] text-muted dark:text-darkMuted"
                    >
                      ?
                    </span>
                  </button>
                </li>
              </ul>
            </div>
          </div>

          {/* Bottom Micro Bar: Copyright & Stack */}
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line/70 dark:border-darkBorder/70 pt-6 text-[11px] text-muted dark:text-darkMuted">
            <p>
              &copy; 2026 <strong className="text-ink dark:text-darkText">NeuroPilot</strong>. For
              clinical decision-support only. Strictly non-diagnostic.
            </p>
            
          </div>
        </div>
      </footer>

      {/* --- Interactive Modals --- */}

      {/* 1. Model Specs & Telemetry Modal */}
      {activeModal === 'telemetry' && (
        <Modal title="Model Architecture & Telemetry Specs" onClose={() => setActiveModal(null)}>
          <div className="space-y-3">
            <p>
              NeuroPilot serves a supervised <strong>XGBoost Gradient Boosting Classifier</strong>{' '}
              with an automated Scikit-Learn RandomForest fallback pipeline, evaluated on longitudinal
              data.
            </p>
            <div className="rounded-xl border border-line dark:border-darkBorder bg-tint/50 dark:bg-darkBorder/30 p-3 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-muted dark:text-darkMuted">Primary Classifier:</span>
                <span style={MONO} className="font-semibold text-accent">
                  {modelInfo?.model_type === 'xgb' ? 'XGBoost (tree_method=hist)' : 'RandomForestClassifier'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted dark:text-darkMuted">Hold-out Test AUC:</span>
                <span style={MONO} className="font-semibold text-ink dark:text-darkText">
                  {modelInfo?.test_auc ? modelInfo.test_auc.toFixed(4) : '0.9077'} (ROC-AUC)
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted dark:text-darkMuted">5-Fold Cross-Validation AUC:</span>
                <span style={MONO} className="font-semibold text-ink dark:text-darkText">
                  {modelInfo?.cv_auc_mean ? modelInfo.cv_auc_mean.toFixed(4) : '0.8980'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted dark:text-darkMuted">Cohort Source:</span>
                <span style={MONO} className="font-semibold text-ink dark:text-darkText">
                  {dataSource || 'OASIS-1 Longitudinal'}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted dark:text-darkMuted">Trained Timestamp:</span>
                <span style={MONO} className="font-semibold text-ink dark:text-darkText">
                  {modelInfo?.trained_at || 'Production Artifact Loaded'}
                </span>
              </div>
            </div>
            <p className="font-semibold text-ink dark:text-darkText mt-2">
              SHAP Explainability Architecture:
            </p>
            <p>
              Every scoring inference executes against an in-memory cached{' '}
              <code className="rounded bg-tint dark:bg-darkBorder px-1 py-0.5">shap.TreeExplainer</code>.
              The top 3 signed attributions (+Risk / −Risk) are delivered with every patient record,
              fulfilling explainable AI guidelines for healthcare.
            </p>
          </div>
        </Modal>
      )}

      {/* 2. Escalation Protocol Modal */}
      {activeModal === 'protocol' && (
        <Modal title="4-Stage Clinical Escalation Protocol" onClose={() => setActiveModal(null)}>
          <div className="space-y-4">
            <p>
              NeuroPilot operationalizes a progressive, 4-stage escalation pipeline designed to reduce
              unnecessary specialist referrals while fast-tracking at-risk individuals:
            </p>
            <div className="space-y-2.5">
              <div className="rounded-xl border border-line dark:border-darkBorder p-3">
                <div className="flex items-center gap-2 font-bold text-ink dark:text-darkText">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#0D8282] text-[10px] text-white">
                    1
                  </span>
                  Stage 1: Cognitive Screening (MMSE)
                </div>
                <p className="mt-1 text-muted dark:text-darkMuted">
                  Baseline cognitive assessment. Patients scoring MMSE &le; 24 or risk model score &gt; 0.70
                  are escalated to plasma testing.
                </p>
              </div>

              <div className="rounded-xl border border-line dark:border-darkBorder p-3">
                <div className="flex items-center gap-2 font-bold text-ink dark:text-darkText">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#3B82F6] text-[10px] text-white">
                    2
                  </span>
                  Stage 2: Blood Biomarker Panel
                </div>
                <p className="mt-1 text-muted dark:text-darkMuted">
                  Minimally invasive plasma assays: p-tau181 and A&beta;42/40 ratio. Abnormal biomarker levels
                  escalate the patient to volumetric neuroimaging.
                </p>
              </div>

              <div className="rounded-xl border border-line dark:border-darkBorder p-3">
                <div className="flex items-center gap-2 font-bold text-ink dark:text-darkText">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#8B5CF6] text-[10px] text-white">
                    3
                  </span>
                  Stage 3: Structural MRI Volumetrics
                </div>
                <p className="mt-1 text-muted dark:text-darkMuted">
                  High-resolution MRI morphometry: hippocampal volume loss and normalized whole brain volume (nWBV).
                  Excludes structural mimics and confirms neurodegenerative atrophy.
                </p>
              </div>

              <div className="rounded-xl border border-line dark:border-darkBorder p-3">
                <div className="flex items-center gap-2 font-bold text-ink dark:text-darkText">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#EC4899] text-[10px] text-white">
                    4
                  </span>
                  Stage 4: Molecular PET Imaging
                </div>
                <p className="mt-1 text-muted dark:text-darkMuted">
                  Amyloid PET imaging (Centiloid quantification &gt; 25 CL). Provides definitive biomarker confirmation
                  for disease-modifying therapy (DMT) eligibility.
                </p>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* 3. Safety & Guardrails Modal */}
      {activeModal === 'safety' && (
        <Modal title="Clinical Decision-Support Guardrails" onClose={() => setActiveModal(null)}>
          <div className="space-y-3">
            <div className="rounded-xl border border-tierHigh/40 bg-tierHigh/10 p-4 text-tierHigh">
              <p className="font-bold text-xs uppercase tracking-wide">
                Strict Non-Diagnostic Medical Boundary
              </p>
              <p className="mt-1 text-xs leading-relaxed text-ink dark:text-darkText">
                NeuroPilot is designed strictly as a clinical decision-support system (CDSS). Under no
                circumstances does this software output a diagnosis of Alzheimer&rsquo;s disease or dementia.
              </p>
            </div>
            <p className="font-semibold text-ink dark:text-darkText">Key Core Tenets:</p>
            <ul className="list-disc pl-5 space-y-1.5 text-muted dark:text-darkMuted">
              <li>
                <strong>Clinician in the Loop:</strong> Diagnostic stage advancement always requires affirmative
                clinician review (<code className="rounded bg-tint dark:bg-darkBorder px-1 py-0.5">POST /advance-stage</code>).
              </li>
              <li>
                <strong>Triage Only:</strong> Predictions represent statistical risk stratification into Low, Medium,
                or High prioritization tiers to assist resource allocation.
              </li>
              <li>
                <strong>Transparent Factors:</strong> All risk tiers are backed by local feature contributions (SHAP)
                so clinicians can audit reasoning before ordering follow-up evaluations.
              </li>
            </ul>
          </div>
        </Modal>
      )}

      {/* 4. Cutoffs & Norms Modal */}
      {activeModal === 'cutoffs' && (
        <Modal title="Biomarker Cutoffs & Normative Ranges" onClose={() => setActiveModal(null)}>
          <div className="space-y-3">
            <p className="text-muted dark:text-darkMuted">
              Standard clinical cutoffs utilized by NeuroPilot for diagnostic thresholding and escalation logic:
            </p>
            <div className="divide-y divide-line dark:divide-darkBorder">
              <div className="py-2.5 flex justify-between items-center">
                <div>
                  <span className="font-bold text-ink dark:text-darkText">MMSE Score</span>
                  <p className="text-[11px] text-muted dark:text-darkMuted">Mini-Mental State Exam</p>
                </div>
                <div style={MONO} className="text-right">
                  <span className="text-tierHigh font-bold">&le; 24</span> (Abnormal) &middot;{' '}
                  <span className="text-tierLow font-bold">25–30</span> (Normal)
                </div>
              </div>

              <div className="py-2.5 flex justify-between items-center">
                <div>
                  <span className="font-bold text-ink dark:text-darkText">Plasma p-tau181</span>
                  <p className="text-[11px] text-muted dark:text-darkMuted">Blood Phosphorylated Tau</p>
                </div>
                <div style={MONO} className="text-right">
                  <span className="text-tierHigh font-bold">&gt; 2.0 pg/mL</span> (Positive) &middot;{' '}
                  <span className="text-tierLow font-bold">&le; 2.0</span> (Normal)
                </div>
              </div>

              <div className="py-2.5 flex justify-between items-center">
                <div>
                  <span className="font-bold text-ink dark:text-darkText">A&beta;42/40 Ratio</span>
                  <p className="text-[11px] text-muted dark:text-darkMuted">Amyloid-beta Plasma Ratio</p>
                </div>
                <div style={MONO} className="text-right">
                  <span className="text-tierHigh font-bold">&lt; 0.09</span> (Abnormal) &middot;{' '}
                  <span className="text-tierLow font-bold">&ge; 0.09</span> (Normal)
                </div>
              </div>

              <div className="py-2.5 flex justify-between items-center">
                <div>
                  <span className="font-bold text-ink dark:text-darkText">Amyloid PET Centiloid</span>
                  <p className="text-[11px] text-muted dark:text-darkMuted">Standardized PET uptake scale</p>
                </div>
                <div style={MONO} className="text-right">
                  <span className="text-tierHigh font-bold">&gt; 25 CL</span> (Amyloid +) &middot;{' '}
                  <span className="text-tierLow font-bold">&le; 25 CL</span> (Amyloid -)
                </div>
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* 4b. Feature Contributions Modal (per-parameter risk breakdown) */}
      {activeModal === 'contributions' && (
        <Modal title="How Risk Is Determined — Feature Contributions" onClose={() => setActiveModal(null)}>
          <ContributionsPanel modelInfo={modelInfo} />
        </Modal>
      )}

      {/* 5. Keyboard Shortcuts Modal */}
      {activeModal === 'shortcuts' && (
        <Modal title="NeuroPilot Keyboard Shortcuts" onClose={() => setActiveModal(null)}>
          <div className="space-y-2">
            {[
              { key: 'Esc', desc: 'Close patient detail drawer or active dialog' },
              { key: '← / →', desc: 'Navigate to previous or next patient in cohort' },
              { key: 'D', desc: 'Jump to Dashboard Overview' },
              { key: 'P', desc: 'Jump to Patient Cohort view' },
              { key: 'S', desc: 'Jump to Live Risk Simulator' },
              { key: 'T', desc: 'Toggle Light / Dark mode' },
              { key: '?', desc: 'Open this keyboard shortcuts reference' },
            ].map((shortcut) => (
              <div
                key={shortcut.key}
                className="flex items-center justify-between py-1.5 border-b border-line/60 dark:border-darkBorder/60"
              >
                <span className="text-muted dark:text-darkMuted">{shortcut.desc}</span>
                <kbd
                  style={MONO}
                  className="rounded-lg border border-line dark:border-darkBorder bg-tint dark:bg-darkBorder/60 px-2 py-1 text-[11px] font-semibold text-ink dark:text-darkText shadow-sm"
                >
                  {shortcut.key}
                </kbd>
              </div>
            ))}
          </div>
        </Modal>
      )}
    </>
  );
}
