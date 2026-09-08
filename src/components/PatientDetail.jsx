import { useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, Printer, TrendingUp, Info } from 'lucide-react';
import { STAGES_SHORT, STAGES_FULL, fmtScore, fmtPercent } from '../lib.js';
import TierTag from './TierTag.jsx';
import TrajectoryChart from './TrajectoryChart.jsx';
import {
  BiomarkerRangeIndicator,
  HeroPanel,
  MONO,
  Panel,
  RiskGauge,
  SectionLabel,
  TIER_HEX,
} from './widgets.jsx';

const DRIVER_LABELS = {
  mmse: 'MMSE (latest)',
  mmse_change: 'MMSE decline rate',
  age: 'Age',
  sex: 'Sex',
  education_years: 'Education',
  ptau181: 'p-tau181 (blood)',
  abeta4240: 'Aβ42/40 (blood)',
  hippocampal_volume: 'Hippocampal volume (MRI)',
  amyloid_positive: 'Amyloid PET',
  tau_positive: 'Tau PET',
};

/* 12-month progression forecast: trajectory chart + conversion probability +
   projected risk tier. Rendered only when the progression model is available. */
function ForecastSection({ progression }) {
  if (!progression || !progression.model_available) return null;
  const { current, projected, drivers } = progression;
  const pPct = Math.round(projected.conversion_probability * 100);
  const convColor =
    projected.conversion_probability >= 0.6
      ? TIER_HEX.high
      : projected.conversion_probability >= 0.3
        ? TIER_HEX.medium
        : TIER_HEX.low;

  return (
    <section>
      <SectionLabel
        size="sm"
        right={
          <span style={MONO} className="text-[10px] font-bold uppercase tracking-wide text-accent">
            12-month forecast
          </span>
        }
      >
        <span className="inline-flex items-center gap-2">
          <TrendingUp className="h-3.5 w-3.5 text-accent" />
          Progression Outlook
        </span>
      </SectionLabel>

      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <div>
          <TrajectoryChart trajectory={progression.trajectory} />
        </div>
        <div className="flex flex-col justify-between gap-4">
          {/* Conversion probability */}
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-ink dark:text-darkText">Probability of clinical progression</span>
              <span style={MONO} className="text-lg font-black" style={{ color: convColor }}>
                {pPct}%
              </span>
            </div>
            <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-line/50 dark:bg-darkBorder/60">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{ width: `${Math.max(3, pPct)}%`, backgroundColor: convColor }}
              />
            </div>
            {projected.tier_shift && (
              <p className="mt-2 text-[11px] font-semibold" style={{ color: TIER_HEX.high }}>
                Projected tier change: {current.risk_tier} → {projected.risk_tier} within 12 months
              </p>
            )}
          </div>

          {/* Projected metrics */}
          <div className="grid grid-cols-2 gap-2.5">
            <div className="rounded-xl border border-line/60 dark:border-darkBorder/60 bg-surface/40 dark:bg-darkBg/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted dark:text-darkMuted">Projected MMSE</p>
              <p style={MONO} className="mt-1 text-base font-bold text-ink dark:text-darkText">
                {current.mmse} → {projected.mmse}
                <span className="ml-1 text-[11px] font-semibold" style={{ color: projected.mmse_delta < 0 ? TIER_HEX.high : TIER_HEX.low }}>
                  ({projected.mmse_delta > 0 ? '+' : ''}{projected.mmse_delta})
                </span>
              </p>
            </div>
            <div className="rounded-xl border border-line/60 dark:border-darkBorder/60 bg-surface/40 dark:bg-darkBg/30 p-3">
              <p className="text-[10px] uppercase tracking-wide text-muted dark:text-darkMuted">Projected risk score</p>
              <p style={MONO} className="mt-1 text-base font-bold text-ink dark:text-darkText">
                {current.score?.toFixed(2)} → {projected.score?.toFixed(2)}
              </p>
            </div>
          </div>

          {/* Top drivers */}
          {drivers?.length > 0 && (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted dark:text-darkMuted">Forecast drivers</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {drivers.map((d) => (
                  <span
                    key={d.feature}
                    style={MONO}
                    className="rounded-md border border-line/70 dark:border-darkBorder/70 bg-surface/50 dark:bg-darkBg/30 px-1.5 py-0.5 text-[10px] text-ink dark:text-darkText"
                  >
                    {DRIVER_LABELS[d.feature] || d.feature}
                    <span className={d.contribution > 0 ? 'ml-1 font-bold text-tierHigh' : 'ml-1 font-bold text-tierLow'}>
                      {d.contribution > 0 ? '+' : '−'}{Math.abs(d.contribution).toFixed(2)}
                    </span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="mt-4 flex items-start gap-1.5 border-t border-line/50 dark:border-darkBorder/50 pt-3 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        {progression.disclaimer}
      </p>
    </section>
  );
}

const SLOT_STAGE = { blood: 2, imaging: 3, pet: 4 };
const SLOT_LABEL = { blood: 'Blood biomarkers', imaging: 'MRI volumetrics', pet: 'PET imaging' };

function ScoreSection({ patient }) {
  const tier = patient.risk_tier;
  return (
    <section>
      <div className="flex flex-col sm:flex-row items-center sm:items-start justify-between gap-6">
        <div className="flex flex-col items-center">
          <RiskGauge score={patient.score} tier={tier} />
          <div className="-mt-3 flex items-center gap-2">
            <TierTag tier={tier} size="lg" />
            <span style={MONO} className="text-xs font-semibold text-muted dark:text-darkMuted">
              {fmtPercent(patient.score)}
            </span>
          </div>
        </div>
        <div className="flex-1 pt-1 text-center sm:text-left">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-sm font-bold text-ink dark:text-darkText tracking-tight">Predicted Probability</p>
            <span style={MONO} className="text-[11px] text-muted dark:text-darkMuted">
              updated {patient.updated_at?.substring(5, 16) ?? '—'}
            </span>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-muted dark:text-darkMuted">
            Longitudinal risk estimation for progression along the early diagnostic pathway.
            Operates as decision support for triage prioritization — never a diagnosis.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center sm:justify-start gap-4 text-[11px]">
            {[
              ['low', 'Low', '< 0.40'],
              ['medium', 'Medium', '0.40–0.70'],
              ['high', 'High', '> 0.70'],
            ].map(([key, label, range]) => (
              <div key={key} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_HEX[key] }} />
                <span className={tier === key ? 'font-bold text-ink dark:text-darkText' : 'text-muted dark:text-darkMuted'}>
                  {label}
                </span>
                <span style={MONO} className="text-dust dark:text-darkMuted">{range}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

// Model feature -> pipeline stage grouping for the attribution panel.
// Blood/MRI/PET features appear with a "not yet measured" state until the
// corresponding test is ordered and completed, then show their live SHAP
// contribution from the served model.
const FEATURE_STAGE = {
  mmse: 1,
  mmse_change: 1,
  n_visits: 1,
  study_years: 1,
  ptau181: 2,
  abeta4240: 2,
  hippocampal_volume: 3,
  amyloid_positive: 4,
  tau_positive: 4,
  age: 0,
  education_years: 0,
  ses: 0,
  sex: 0,
  etiv: 0,
  nwbv: 0,
  asf: 0,
};

const STAGE_GROUPS = [
  { stage: 1, label: 'Cognition & baseline', slot: null },
  { stage: 2, label: 'Blood biomarkers', slot: 'blood' },
  { stage: 3, label: 'MRI volumetrics', slot: 'imaging' },
  { stage: 4, label: 'PET imaging', slot: 'pet' },
];

function ReasoningSection({ patient }) {
  const factorByFeature = Object.fromEntries((patient.factors || []).map((f) => [f.feature, f]));
  const maxAbs = Math.max(...(patient.factors || []).map((f) => Math.abs(f.effect)), 0.0001);

  const factorRow = (f, i, dim = false) => {
    const up = f.effect > 0;
    const width = Math.max(6, (Math.abs(f.effect) / maxAbs) * 100);
    const hex = up ? TIER_HEX.high : TIER_HEX.low;
    const isBinary = f.feature === 'amyloid_positive' || f.feature === 'tau_positive';
    return (
      <div key={`${f.feature}-${i}`} className="space-y-1" style={{ opacity: dim ? 0.7 : 1 }}>
        <div className="flex items-baseline justify-between gap-4">
          <span className="truncate text-xs font-medium text-ink dark:text-darkText" title={f.feature}>
            {f.text}
            {f.value != null && (
              <span style={MONO} className="ml-1.5 text-[11px] text-muted dark:text-darkMuted">
                · {isBinary ? (f.value === 1 ? 'Positive' : 'Negative') : f.value}
              </span>
            )}
            {dim && (
              <span className="ml-1.5 rounded-md bg-[#EAE7DF] dark:bg-darkBorder px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-muted dark:text-darkMuted">
                model default
              </span>
            )}
          </span>
          <span
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-bold"
            style={{ ...MONO, color: hex, backgroundColor: `${hex}18` }}
          >
            {up ? '+' : '−'}{Math.abs(f.effect).toFixed(2)}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
          <div className="h-full rounded-full transition-all duration-500" style={{ width: `${width}%`, backgroundColor: hex }} />
        </div>
      </div>
    );
  };

  const byStage = (stage) =>
    Object.entries(FEATURE_STAGE)
      .filter(([, s]) => s === stage)
      .map(([feat]) => factorByFeature[feat])
      .filter(Boolean)
      .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));

  return (
    <section>
      <SectionLabel
        right={
          <span className="flex items-center gap-3 text-[11px] text-muted dark:text-darkMuted">
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TIER_HEX.high }} /> raises priority
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: TIER_HEX.low }} /> lowers priority
            </span>
          </span>
        }
      >
        Clinical Risk Attribution Factors
      </SectionLabel>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
        SHAP contribution of every model input, grouped by pipeline stage. Tests that haven&rsquo;t
        been ordered yet show their neutral placeholder; results re-score the model live.
      </p>

      <div className="mt-5 space-y-4">
        {STAGE_GROUPS.map(({ stage, label, slot }) => {
          const slotData = slot ? patient[slot] : null;
          const hasResults = Boolean(slotData && slotData.status === 'completed');
          const isOrdered = Boolean(slotData);
          // Cognition group folds in demographics/baseline (stage 0) as context
          const rows = stage === 1 ? [...byStage(1), ...byStage(0)] : byStage(stage);

          return (
            <div key={label} className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-[#FAF9F5] dark:bg-darkCardHover px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-ink dark:text-darkText">
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-bold text-white"
                    style={{ backgroundColor: hasResults ? TIER_HEX.low : isOrdered ? TIER_HEX.medium : '#C7C4BC' }}
                  >
                    {stage}
                  </span>
                  {label}
                </span>
                {!hasResults && slot && (
                  <span className="text-[10px] font-medium text-dust dark:text-darkMuted">
                    {isOrdered ? 'results pending' : 'not yet measured'}
                  </span>
                )}
              </div>

              {rows.length === 0 ? (
                <p className="mt-2 text-[11px] text-muted dark:text-darkMuted">
                  {hasResults
                    ? 'No contribution above threshold from this stage.'
                    : 'Order this test to see its influence on the risk score.'}
                </p>
              ) : (
                <div className="mt-3 space-y-2.5">{rows.map((f, i) => factorRow(f, i, stage > 1 && !hasResults))}</div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
        Rows tagged <span className="font-semibold">model default</span> are tests that haven&rsquo;t been
        performed: the model handles missing values natively, so an unordered test carries a small learned
        placeholder contribution (e.g. +0.06) rather than zero. It is replaced by the measured value&rsquo;s
        actual contribution the moment results land and the model re-scores.
      </p>
    </section>
  );
}

function PipelineSection({ patient }) {
  const current = patient.stage;
  return (
    <section>
      <SectionLabel right={<span className="text-[11px] text-muted dark:text-darkMuted">Cognitive → Blood → MRI → PET</span>}>
        Diagnostic Triage Pathway
      </SectionLabel>
      <div className="mt-6 flex items-start">
        {STAGES_SHORT.map((label, i) => {
          const step = i + 1;
          const done = step < current;
          const active = step === current;
          return (
            <div key={label} className="flex flex-1 items-center last:flex-none">
              <div className="flex flex-col items-center">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-bold transition-all"
                  style={
                    done
                      ? { backgroundColor: TIER_HEX.low, color: '#fff' }
                      : active
                        ? {
                            backgroundColor: '#0D8282',
                            color: '#fff',
                            boxShadow: '0 0 0 4px rgba(13,130,130,0.25)',
                          }
                        : {
                            border: '1px solid #DEDBD3',
                            backgroundColor: 'transparent',
                            color: '#848D9A',
                          }
                  }
                >
                  {done ? (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  ) : (
                    step
                  )}
                </span>
                <span
                  className={`mt-2 whitespace-nowrap text-[11px] ${
                    active ? 'font-bold text-accent dark:text-accent' : done ? 'font-medium text-ink dark:text-darkText' : 'font-medium text-muted dark:text-darkMuted'
                  }`}
                >
                  {label}
                </span>
              </div>
              {step < 4 && (
                <div
                  className="mx-2 mb-6 h-0.5 flex-1 rounded-full transition-colors"
                  style={{ backgroundColor: step < current ? TIER_HEX.low : '#DEDBD3' }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted dark:text-darkMuted">
        <span>Current: <strong className="text-ink dark:text-darkText">{patient.stage_name}</strong></span>
        <span>Stage {current} of 4</span>
      </div>
    </section>
  );
}

function ActionSection({ action, advanceable, onAdvance, busy, error }) {
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [note, setNote] = useState('');

  const startOverride = () => {
    setNote('');
    setOverrideOpen(true);
  };
  const confirmOverride = () => {
    onAdvance(true, note.trim());
    setOverrideOpen(false);
  };

  return (
    <section>
      <SectionLabel right={<span className="text-[11px] text-muted dark:text-darkMuted">Clinician-in-the-loop validation</span>}>
        Recommended Next Step
      </SectionLabel>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-2xl border border-line dark:border-darkBorder bg-[#FAF9F5] dark:bg-darkBorderSubtle px-6 py-5">
        {!action ? (
          <div className="flex items-center gap-3">
            <span className="flex h-7 w-7 items-center justify-center rounded-full text-white" style={{ backgroundColor: TIER_HEX.low }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m5 13 4 4L19 7" />
              </svg>
            </span>
            <div>
              <p className="text-sm font-bold text-ink dark:text-darkText">Pathway Protocol Complete</p>
              <p className="mt-0.5 text-xs text-muted dark:text-darkMuted">Patient ready for multidisciplinary diagnostic review.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="max-w-md">
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-accent">Protocol Action</span>
              <p className="mt-0.5 text-sm font-medium leading-relaxed text-ink dark:text-darkText">{action.summary}</p>
            </div>
            <button
              onClick={() => onAdvance(false)}
              disabled={!advanceable || busy}
              className="rounded-xl px-5 py-2.5 text-xs font-semibold shadow-soft transition active:scale-[0.98]"
              style={
                advanceable && !busy
                  ? { backgroundColor: '#0D8282', color: '#fff' }
                  : { backgroundColor: '#EDEAE2', color: '#9A9D9F', cursor: 'not-allowed' }
              }
            >
              {busy ? 'Processing…' : action.button}
            </button>
          </>
        )}
      </div>

      {action && !advanceable && !overrideOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted dark:text-darkMuted">
          <span>The rule engine recommends routine screening for this priority tier.</span>
          <button
            onClick={startOverride}
            className="font-semibold text-accent hover:underline transition"
          >
            Clinician Override — Order Advanced Test Anyway →
          </button>
        </div>
      )}

      {overrideOpen && (
        <div className="mt-4 space-y-3 rounded-2xl border border-dashed border-accent/60 bg-accent/5 p-4 animate-scale-in">
          <div className="flex items-center gap-2 text-xs font-bold text-accent">
            <span>🛡️</span> Clinician Escalation Override
          </div>
          <p className="text-[11px] text-muted dark:text-darkMuted">
            Provide clinical rationale for bypassing stage-gate protocol. This decision will be logged to the immutable audit trail.
          </p>
          <div className="flex flex-wrap items-center gap-2.5">
            <input
              autoFocus
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmOverride();
                if (e.key === 'Escape') setOverrideOpen(false);
              }}
              placeholder="Rationale, e.g., Rapid subjective memory decline or positive family history…"
              className="h-9 min-w-[260px] flex-1 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 text-xs text-ink dark:text-darkText outline-none transition focus:border-accent"
            />
            <button
              onClick={confirmOverride}
              disabled={busy}
              className="rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Confirm & Advance'}
            </button>
            <button
              onClick={() => setOverrideOpen(false)}
              disabled={busy}
              className="text-xs text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-xl border border-tierHigh/30 bg-tierHigh/10 px-4 py-2.5 text-xs font-semibold text-tierHigh">
          {error}
        </p>
      )}
    </section>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2">
      <dt className="shrink-0 text-xs text-muted dark:text-darkMuted">{k}</dt>
      <dd style={MONO} className="text-right text-xs font-semibold text-ink dark:text-darkText">{v}</dd>
    </div>
  );
}

const OUTCOME_META = {
  normal: { hex: TIER_HEX.low, label: 'Normal / Negative' },
  abnormal: { hex: TIER_HEX.high, label: 'Abnormal / Positive' },
  inconclusive: { hex: TIER_HEX.medium, label: 'Inconclusive' },
};

const CLINICAL_PRESETS = {
  blood: [
    {
      name: 'Elevated p-tau181 (Pathological)',
      outcome: 'abnormal',
      text: 'pTau181: 4.8 pg/mL, abeta4240: 0.052',
      note: 'Significant p-tau elevation; Aβ42/40 ratio below reference range',
    },
    {
      name: 'Normal Biomarkers (Reference)',
      outcome: 'normal',
      text: 'pTau181: 1.6 pg/mL, abeta4240: 0.118',
      note: 'Normal plasma levels across both markers',
    },
  ],
  imaging: [
    {
      name: 'Hippocampal Atrophy (<5th %ile)',
      outcome: 'abnormal',
      text: 'hippocampalVolumeCm3: 2.1, percentile: 4',
      note: 'Bilateral medial temporal lobe volume loss',
    },
    {
      name: 'Age-Appropriate MRI Volumetrics',
      outcome: 'normal',
      text: 'hippocampalVolumeCm3: 3.4, percentile: 52',
      note: 'No focal hippocampal atrophy observed',
    },
  ],
  pet: [
    {
      name: 'Amyloid & Tau Positive (+)',
      outcome: 'abnormal',
      text: 'amyloidSUVr: 1.45, tauBraakStage: IV',
      note: 'Widespread neocortical amyloid retention; specialist consult required',
    },
    {
      name: 'Amyloid Negative (−)',
      outcome: 'normal',
      text: 'amyloidSUVr: 1.05',
      note: 'Non-significant cortical amyloid binding',
    },
  ],
};

function parseValues(text) {
  const values = {};
  String(text || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const m = pair.match(/^([^:=]+)[:=]\s*(.+)$/);
      if (!m) return;
      const key = m[1].trim();
      const raw = m[2].trim();
      const num = Number(raw);
      values[key] = Number.isFinite(num) ? num : raw;
    });
  return values;
}

function ProfileSection({ patient, onRecordResult }) {
  const cog = patient.cognitive;
  const decline = cog && cog.prior != null && cog.latest != null ? cog.prior - cog.latest : 0;
  const [openSlot, setOpenSlot] = useState(null);
  const [outcome, setOutcome] = useState('normal');
  const [valuesText, setValuesText] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [localError, setLocalError] = useState('');

  const SLOT_VALUE_FIELDS = {
    blood: ['pTau181', 'abeta4240'],
    imaging: ['hippocampalVolumeCm3'],
    pet: ['amyloidSUVr'],
  };

  const openForm = (slot) => {
    const existing = patient[slot];
    const amending = existing?.status === 'completed';
    setOutcome(amending ? existing.outcome ?? 'normal' : 'normal');
    // Pre-fill with the current structured values so the clinician edits rather than retypes
    setValuesText(
      amending && existing
        ? (SLOT_VALUE_FIELDS[slot] || [])
            .filter((k) => existing[k] != null)
            .map((k) => `${k}: ${existing[k]}`)
            .join(', ')
        : ''
    );
    setNote(amending ? existing?.note ?? '' : '');
    setLocalError('');
    setOpenSlot(slot);
  };

  const applyPreset = (preset) => {
    setOutcome(preset.outcome);
    setValuesText(preset.text);
    setNote(preset.note);
  };

  const save = async () => {
    if (!openSlot) return;
    setSaving(true);
    setLocalError('');
    try {
      await onRecordResult(openSlot, {
        outcome,
        values: parseValues(valuesText),
        note: note.trim() || '',
      });
      setOpenSlot(null);
    } catch (err) {
      setLocalError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <SectionLabel right={<TierTag tier={patient.risk_tier} />}>Clinical Profile & Labs</SectionLabel>

      {cog?.latest != null && (
        <div className="mt-4">
          <BiomarkerRangeIndicator
            label="Baseline Cognition (MMSE)"
            value={cog.latest}
            unit="pts"
            min={10}
            max={30}
            normalMin={24}
            normalMax={30}
            reverse={true}
          />
        </div>
      )}

      <dl className="mt-4 divide-y divide-line/60 dark:divide-darkBorder/60 text-xs">
        <Row k="Age / Biological Sex" v={patient.age != null ? `${patient.age}y · ${patient.sex === 'M' ? 'Male' : 'Female'}` : '—'} />
        <Row k="Education History" v={patient.education_years != null ? `${patient.education_years} years` : '—'} />
        <Row
          k="Cognitive Trajectory"
          v={
            cog
              ? `${cog.scale} ${cog.latest ?? '—'}${decline > 0 ? ` (−${decline} in ${cog.months ?? 6}m)` : ' (stable)'}`
              : '—'
          }
        />
        <Row k="Family History" v={patient.family_history ? 'Positive (+)' : 'Negative (−)'} />
        <Row
          k="Comorbidity Flags"
          v={patient.comorbidities?.length ? patient.comorbidities.join(', ') : 'None documented'}
        />
      </dl>

      <div className="mt-6 border-t border-line dark:border-darkBorder pt-6">
        <p className="text-xs font-bold uppercase tracking-wider text-muted dark:text-darkMuted">Diagnostic Tests</p>
        <div className="mt-3 divide-y divide-line/60 dark:divide-darkBorder/60">
          {['blood', 'imaging', 'pet'].map((slot) => {
            const value = patient[slot];
            const stageAt = SLOT_STAGE[slot];
            const meta = value?.outcome ? OUTCOME_META[value.outcome] : null;
            const dotHex = meta ? meta.hex : value?.status === 'pending' ? TIER_HEX.medium : '#C7C4BC';

            return (
              <div key={slot} className="py-3">
                <div className="flex items-start justify-between gap-4">
                  <span className="flex shrink-0 items-center gap-2 pt-0.5 text-xs font-medium text-ink dark:text-darkText">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotHex }} />
                    {SLOT_LABEL[slot]}
                  </span>
                  <span className="text-right">
                    {!value ? (
                      <span className="text-[11px] text-dust dark:text-darkMuted">Not ordered (Stage {stageAt})</span>
                    ) : value.status === 'pending' ? (
                      <span className="flex items-center gap-2">
                        <span className="text-[11px] font-semibold text-tierMedium">Results pending</span>
                        <button
                          onClick={() => openForm(slot)}
                          className="rounded-lg border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-2.5 py-1 text-[11px] font-semibold text-accent hover:bg-accent/10 transition"
                        >
                          + Record result
                        </button>
                      </span>
                    ) : (
                      <div>
                        {meta && (
                          <span
                            className="inline-block rounded-md px-2 py-0.5 text-[10.5px] font-bold"
                            style={{ color: meta.hex, backgroundColor: `${meta.hex}18` }}
                          >
                            {meta.label}
                          </span>
                        )}
                        {value.note && (
                          <span className="mt-0.5 block text-[11px] text-muted dark:text-darkMuted">{value.note}</span>
                        )}
                      </div>
                    )}
                  </span>
                </div>

                {openSlot === slot && value?.status === 'pending' && (
                  <div className="mt-3 space-y-3 rounded-2xl border border-dashed border-accent/40 bg-[#FAF9F5] dark:bg-darkCardHover p-4 animate-scale-in">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-ink dark:text-darkText">Enter {SLOT_LABEL[slot]} Result</span>
                      <button onClick={() => setOpenSlot(null)} className="text-xs text-muted dark:text-darkMuted">✕</button>
                    </div>

                    {CLINICAL_PRESETS[slot] && (
                      <div>
                        <span className="text-[10.5px] text-muted dark:text-darkMuted">Quick clinical presets:</span>
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {CLINICAL_PRESETS[slot].map((preset) => (
                            <button
                              key={preset.name}
                              type="button"
                              onClick={() => applyPreset(preset)}
                              className="rounded-lg border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-2 py-1 text-[10.5px] font-medium hover:border-accent transition text-ink dark:text-darkText"
                            >
                              {preset.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="flex gap-2">
                      {['normal', 'abnormal', 'inconclusive'].map((o) => (
                        <button
                          key={o}
                          onClick={() => setOutcome(o)}
                          className={`flex-1 rounded-xl py-1.5 text-xs font-semibold capitalize transition ${
                            outcome === o
                              ? 'bg-accent text-white shadow-soft'
                              : 'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-muted dark:text-darkMuted'
                          }`}
                        >
                          {o}
                        </button>
                      ))}
                    </div>

                    <input
                      type="text"
                      value={valuesText}
                      onChange={(e) => setValuesText(e.target.value)}
                      placeholder="Values, e.g. p-tau181: 4.8, Aβ42/40: 0.052 (optional)"
                      className="h-8 w-full rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 text-xs text-ink dark:text-darkText outline-none focus:border-accent"
                    />
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Clinical lab notes (optional)"
                      className="h-8 w-full rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 text-xs text-ink dark:text-darkText outline-none focus:border-accent"
                    />

                    <div className="flex items-center gap-3">
                      <button
                        onClick={save}
                        disabled={saving}
                        className="rounded-xl bg-accent px-4 py-1.5 text-xs font-bold text-white shadow-soft transition hover:bg-accentHover disabled:opacity-50"
                      >
                        {saving ? 'Saving…' : 'Save & Update Pathway'}
                      </button>
                      <button
                        onClick={() => setOpenSlot(null)}
                        disabled={saving}
                        className="text-xs text-muted dark:text-darkMuted"
                      >
                        Cancel
                      </button>
                      {localError && <span className="text-xs text-tierHigh">{localError}</span>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function AuditSection({ patient }) {
  const history = patient.history ?? [];
  return (
    <section>
      <SectionLabel right={<span className="text-[11px] text-muted dark:text-darkMuted">FDA / AI Audit Trail</span>}>
        Event & Reasoning Trail
      </SectionLabel>
      <ol className="mt-5 space-y-4">
        {history.length === 0 ? (
          <li className="text-xs text-muted dark:text-darkMuted">No events recorded.</li>
        ) : (
          [...history].reverse().map((h, i) => (
            <li key={`${h.at}-${i}`} className="relative pl-5">
              <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full border-2 border-white dark:border-darkCard bg-accent shadow-sm" />
              <p className="text-xs leading-relaxed text-ink dark:text-darkText">{h.text}</p>
              <p style={MONO} className="mt-0.5 text-[10px] text-muted dark:text-darkMuted">{h.at}</p>
            </li>
          ))
        )}
      </ol>
    </section>
  );
}

export default function PatientDetail({
  patient,
  pipeline,
  progression,
  loading,
  error,
  onBack,
  onAdvance,
  advanceBusy,
  advanceError,
  onRecordResult,
  onPrev,
  onNext,
  hasPrev = false,
  hasNext = false,
  onOpenProgression,
}) {
  if (loading || !patient) {
    return (
      <div className="space-y-6 animate-pulse">
        <div className="h-5 w-32 rounded bg-line dark:bg-darkBorder" />
        <div className="grid gap-8 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <div className="h-48 rounded-2xl bg-line dark:bg-darkBorder" />
            <div className="h-32 rounded-2xl bg-line dark:bg-darkBorder" />
          </div>
          <div className="h-80 rounded-2xl bg-line dark:bg-darkBorder lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md py-20 text-center animate-fade-up">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 mb-6 text-xs text-muted dark:text-darkMuted hover:text-ink">
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Return to Cohort</span>
        </button>
        <p className="text-sm font-semibold text-tierHigh">{error}</p>
      </div>
    );
  }

  const action = pipeline?.recommended_next ?? null;
  const advanceable = Boolean(action) && !/^(Schedule|Return)/.test(action.button);

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line dark:border-darkBorder pb-4 no-print">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Cohort</span>
          </button>
          <span className="h-3 w-px bg-line dark:bg-darkBorder" />
          <h1 style={MONO} className="text-lg font-bold text-ink dark:text-darkText tracking-tight">
            {patient.id}
          </h1>
          <TierTag tier={patient.risk_tier} size="lg" />
        </div>

        <div className="flex items-center gap-2">
          {onPrev && (
            <button
              onClick={onPrev}
              disabled={!hasPrev}
              className="inline-flex items-center gap-1 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-xs font-semibold text-ink dark:text-darkText hover:border-accent disabled:opacity-30 transition"
              title="Previous patient"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Prev</span>
            </button>
          )}
          {onNext && (
            <button
              onClick={onNext}
              disabled={!hasNext}
              className="inline-flex items-center gap-1 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-xs font-semibold text-ink dark:text-darkText hover:border-accent disabled:opacity-30 transition"
              title="Next patient"
            >
              <span>Next</span>
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          )}
          {progression?.model_available && onOpenProgression && (
            <button
              onClick={onOpenProgression}
              className="inline-flex items-center gap-2 rounded-xl border border-accent/40 bg-accent/10 px-3.5 py-1.5 text-xs font-semibold text-accent hover:bg-accent/20 shadow-soft transition"
              title="Open the full 12-month progression forecast"
            >
              <TrendingUp className="h-3.5 w-3.5" />
              <span>Progression Probability</span>
              {typeof progression?.projected?.conversion_probability === 'number' && (
                <span style={MONO} className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-bold text-white">
                  {Math.round(progression.projected.conversion_probability * 100)}%
                </span>
              )}
            </button>
          )}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-2 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 py-1.5 text-xs font-semibold text-ink dark:text-darkText hover:border-accent shadow-soft transition"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>Export Consultation Report</span>
          </button>
        </div>
      </div>

      <div className="grid items-start gap-8 lg:grid-cols-5">
        <div className="space-y-8 lg:col-span-3">
          <HeroPanel tier={patient.risk_tier}>
            <ScoreSection patient={patient} />
          </HeroPanel>

          {/* Unified Clinical Decision Dossier */}
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 divide-y divide-line/60 dark:divide-darkBorder/60">
            <div className="p-6">
              <ReasoningSection patient={patient} />
            </div>
            <div className="p-6">
              <PipelineSection patient={patient} />
            </div>
            <div className="p-6">
              <ActionSection
                action={action}
                advanceable={advanceable}
                onAdvance={onAdvance}
                busy={advanceBusy}
                error={advanceError}
              />
            </div>
          </div>
        </div>

        <div className="space-y-8 lg:col-span-2">
          {/* Unified Biomarker Profile & Audit Trail */}
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 divide-y divide-line/60 dark:divide-darkBorder/60">
            <div className="p-6">
              <ProfileSection patient={patient} onRecordResult={onRecordResult} />
            </div>
            <div className="p-6">
              <AuditSection patient={patient} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}