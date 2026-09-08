import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  FlaskConical,
  Loader2,
  Play,
  PlusCircle,
  ScanLine,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '../api.js';
import { fmtPercent } from '../lib.js';
import TierTag from './TierTag.jsx';
import {
  HeroPanel,
  MONO,
  RiskGauge,
  SectionLabel,
  TIER_HEX,
} from './widgets.jsx';

/* ------------------------------------------------------------------ */
/*  The 10 features the served v2 model actually uses (model_meta).    */
/*  Blood / MRI / PET inputs are only sent when the corresponding      */
/*  stage is toggled "measured" — otherwise null (model default path). */
/* ------------------------------------------------------------------ */

const FACTOR_META = {
  mmse: { stage: 'Cognitive', label: 'MMSE (latest)' },
  mmse_change: { stage: 'Cognitive', label: 'MMSE change' },
  age: { stage: 'Demographic', label: 'Age' },
  sex: { stage: 'Demographic', label: 'Sex' },
  education_years: { stage: 'Demographic', label: 'Education' },
  ptau181: { stage: 'Blood', label: 'p-tau181' },
  abeta4240: { stage: 'Blood', label: 'Aβ42/40' },
  hippocampal_volume: { stage: 'MRI', label: 'Hippocampal volume' },
  amyloid_positive: { stage: 'PET', label: 'Amyloid PET' },
  tau_positive: { stage: 'PET', label: 'Tau PET' },
};

const STAGE_COLORS = {
  Cognitive: '#0D8282',
  Blood: '#3B82F6',
  MRI: '#8B5CF6',
  PET: '#EC4899',
  Demographic: '#6E7175',
};

function formatFactorValue(f) {
  const v = f.value;
  if (v === null || v === undefined) return 'not measured';
  switch (f.feature) {
    case 'sex':
      return v === 1 ? 'Male' : 'Female';
    case 'amyloid_positive':
    case 'tau_positive':
      return v === 1 ? 'Positive' : 'Negative';
    case 'age':
      return `${Math.round(v)} yrs`;
    case 'education_years':
      return `${Math.round(v)} yrs`;
    case 'mmse':
      return `${Math.round(v)}/30`;
    case 'mmse_change':
      return `${v > 0 ? '+' : ''}${v} pts`;
    case 'ptau181':
      return `${Number(v).toFixed(1)} pg/mL`;
    case 'abeta4240':
      return Number(v).toFixed(3);
    case 'hippocampal_volume':
      return `${Number(v).toFixed(2)} cm³`;
    default:
      return typeof v === 'number' ? v.toFixed(2) : String(v);
  }
}

const PRESETS = [
  {
    name: 'High Risk (Suspected AD)',
    desc: 'Rapid decline, amyloid + tau positive, severe atrophy',
    features: {
      age: 78,
      sex: 'F',
      education_years: 12,
      mmse: 21,
      mmse_change: -4,
      ptau181: 5.8,
      abeta4240: 0.055,
      hippocampal_volume: 1.9,
      amyloid_positive: true,
      tau_positive: true,
    },
    stages: { blood: true, mri: true, pet: true },
  },
  {
    name: 'Borderline (MCI Watch)',
    desc: 'Mild decline, borderline blood panel, MRI/PET pending',
    features: {
      age: 72,
      sex: 'M',
      education_years: 16,
      mmse: 26,
      mmse_change: -1,
      ptau181: 3.4,
      abeta4240: 0.075,
      hippocampal_volume: 2.4,
      amyloid_positive: false,
      tau_positive: false,
    },
    stages: { blood: true, mri: false, pet: false },
  },
  {
    name: 'Low Risk (Healthy Aging)',
    desc: 'Normal cognition, clean blood panel, preserved volumes',
    features: {
      age: 67,
      sex: 'F',
      education_years: 18,
      mmse: 29,
      mmse_change: 0,
      ptau181: 1.2,
      abeta4240: 0.135,
      hippocampal_volume: 3.8,
      amyloid_positive: false,
      tau_positive: false,
    },
    stages: { blood: true, mri: true, pet: false },
  },
];

function featuresFromPatient(p) {
  const cog = p.cognitive || {};
  const blood = p.blood || {};
  const imaging = p.imaging || {};
  const pet = p.pet || {};
  const latest = cog.latest ?? 25;
  const prior = cog.prior ?? latest;
  return {
    features: {
      age: p.age || 75,
      sex: p.sex || 'F',
      education_years: p.education_years || 14,
      mmse: latest,
      mmse_change: Math.round((latest - prior) * 10) / 10,
      ptau181: blood.pTau181 ?? 2.5,
      abeta4240: blood.abeta4240 ?? 0.12,
      hippocampal_volume: imaging.hippocampalVolumeCm3 ?? 3.0,
      amyloid_positive: pet.amyloid === 'positive',
      tau_positive: pet.tau === 'positive',
    },
    stages: {
      blood: blood.status === 'completed',
      mri: imaging.status === 'completed',
      pet: pet.status === 'completed',
    },
  };
}

function StageToggle({ on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={on ? 'Results included in scoring — click to simulate "test not ordered"' : 'Simulates a test that has not been ordered — model falls back to its learned default'}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide transition ${
        on
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-line dark:border-darkBorder bg-white/60 dark:bg-darkCard/60 text-muted dark:text-darkMuted'
      }`}
    >
      {on ? <CheckCircle2 className="h-3 w-3" /> : <PlusCircle className="h-3 w-3" />}
      {on ? 'Measured' : 'Not ordered'}
    </button>
  );
}

function Slider({ label, value, display, min, max, step = 1, marks, disabled, onChange }) {
  return (
    <div className={disabled ? 'opacity-40 pointer-events-none' : ''}>
      <div className="flex justify-between text-xs">
        <span className="font-medium text-ink dark:text-darkText">{label}</span>
        <span style={MONO} className="font-bold text-accent">{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-2 w-full accent-accent cursor-pointer"
      />
      {marks && (
        <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
          {marks.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export default function RiskSimulator({ initialPatient = null, onSelectPatient }) {
  const [{ features, stages }, setSimState] = useState(() => {
    if (initialPatient) return featuresFromPatient(initialPatient);
    const preset = PRESETS[0];
    return { features: preset.features, stages: preset.stages };
  });

  const [scoring, setScoring] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [autoScore, setAutoScore] = useState(true);

  const runScore = useCallback(async (feat) => {
    setScoring(true);
    setError('');
    try {
      const payload = {
        age: feat.features.age,
        sex: feat.features.sex === 'M' ? 1 : 0,
        education_years: feat.features.education_years,
        mmse: feat.features.mmse,
        mmse_change: feat.features.mmse_change,
        ptau181: feat.stages.blood ? feat.features.ptau181 : null,
        abeta4240: feat.stages.blood ? feat.features.abeta4240 : null,
        hippocampal_volume: feat.stages.mri ? feat.features.hippocampal_volume : null,
        amyloid_positive: feat.stages.pet ? (feat.features.amyloid_positive ? 1 : 0) : null,
        tau_positive: feat.stages.pet ? (feat.features.tau_positive ? 1 : 0) : null,
      };
      const res = await api.scorePatient(payload);
      setResult(res);
    } catch (err) {
      setError(err.message);
    } finally {
      setScoring(false);
    }
  }, []);

  useEffect(() => {
    if (autoScore) {
      const timer = setTimeout(() => runScore({ features, stages }), 250);
      return () => clearTimeout(timer);
    }
  }, [features, stages, autoScore, runScore]);

  const updateField = (key, val) => {
    setSimState((prev) => ({ ...prev, features: { ...prev.features, [key]: val } }));
  };

  const toggleStage = (slot) => {
    setSimState((prev) => ({ ...prev, stages: { ...prev.stages, [slot]: !prev.stages[slot] } }));
  };

  const applyPreset = (preset) => {
    setSimState({ features: { ...preset.features }, stages: { ...preset.stages } });
  };

  const tier = result ? result.risk_tier : 'medium';
  const factors = result?.factors || [];

  const protocol = useMemo(() => {
    if (tier === 'low') {
      return 'Stage 1 complete: Low risk. Schedule routine follow-up cognitive evaluation in 12 months.';
    }
    if (!stages.blood) {
      return 'Order Stage 2: Blood biomarker panel (plasma p-tau181, Aβ42/40) to confirm pathology.';
    }
    if (!stages.mri) {
      return 'Blood panel complete — order Stage 3: MRI volumetrics (hippocampal volume) to quantify neurodegeneration.';
    }
    if (!stages.pet) {
      return 'MRI complete — order Stage 4: PET (amyloid/tau) to confirm pathology before specialist referral.';
    }
    return 'Full 4-stage workup complete — refer to specialist memory clinic for diagnostic confirmation.';
  }, [tier, stages]);

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Premium Header */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line/80 dark:border-darkBorder/80 pb-6">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 dark:from-accent/25 dark:to-accent/10 border border-accent/25 text-accent shadow-sm">
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-[28px] sm:text-[32px] font-black tracking-tight text-ink dark:text-darkText leading-none">
              Clinical Risk Simulator
            </h1>
            <p className="mt-1.5 text-[13px] text-muted dark:text-darkMuted flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span>10-Feature Model Workbench</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>Staged Measurement (Cognition → Blood → MRI → PET)</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>SHAP Attribution</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs font-medium text-muted dark:text-darkMuted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoScore}
              onChange={(e) => setAutoScore(e.target.checked)}
              className="rounded accent-accent h-4 w-4"
            />
            Live auto-predict
          </label>
          <button
            onClick={() => runScore({ features, stages })}
            disabled={scoring}
            className="inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-xs font-semibold text-white shadow-soft transition hover:bg-accentHover disabled:opacity-50"
          >
            {scoring ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Computing…
              </>
            ) : (
              <>
                <Play className="h-3 w-3 fill-current" />
                Calculate Risk Projection
              </>
            )}
          </button>
        </div>
      </div>

      {/* Clinical Presets */}
      <div>
        <p className="text-[11px] font-semibold text-muted dark:text-darkMuted uppercase tracking-wider mb-2.5">
          Quick clinical scenarios:
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          {PRESETS.map((p, idx) => {
            const IconComp = idx === 0 ? AlertTriangle : idx === 1 ? Activity : CheckCircle2;
            const iconColor = idx === 0 ? 'text-tierHigh' : idx === 1 ? 'text-tierMedium' : 'text-tierLow';
            return (
              <button
                key={p.name}
                onClick={() => applyPreset(p)}
                className="text-left rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard p-3 transition-all hover:border-accent dark:hover:border-accent hover:shadow-soft"
              >
                <div className="flex items-center gap-1.5 text-xs font-semibold text-ink dark:text-darkText">
                  <IconComp className={`h-3.5 w-3.5 shrink-0 ${iconColor}`} />
                  <span>{p.name}</span>
                </div>
                <div className="text-[11px] text-muted dark:text-darkMuted mt-1">{p.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Grid: Controls on Left, Live Output on Right */}
      <div className="grid gap-8 lg:grid-cols-12">
        {/* Parameter Workbench */}
        <div className="space-y-6 lg:col-span-7">
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 divide-y divide-line/60 dark:divide-darkBorder/60">
            {/* Demographics */}
            <div className="p-6">
              <SectionLabel size="sm">Patient Demographics</SectionLabel>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Slider
                  label="Age"
                  value={features.age}
                  display={`${features.age} yrs`}
                  min={55}
                  max={95}
                  marks={['55y', '95y']}
                  onChange={(v) => updateField('age', v)}
                />
                <div>
                  <span className="block text-xs font-medium text-ink dark:text-darkText">Sex</span>
                  <div className="mt-2 flex gap-2">
                    {['F', 'M'].map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => updateField('sex', s)}
                        className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold transition ${
                          features.sex === s
                            ? 'border-accent bg-accent text-white shadow-soft'
                            : 'border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText'
                        }`}
                      >
                        {s === 'F' ? 'Female' : 'Male'}
                      </button>
                    ))}
                  </div>
                </div>
                <Slider
                  label="Education (cognitive reserve)"
                  value={features.education_years}
                  display={`${features.education_years} yrs`}
                  min={6}
                  max={24}
                  marks={['6y', '12y (HS)', '24y']}
                  onChange={(v) => updateField('education_years', v)}
                />
              </div>
            </div>

            {/* Cognitive — always measured (Stage 1) */}
            <div className="p-6">
              <div className="flex items-center justify-between">
                <SectionLabel size="sm">Cognitive Assessment (Stage 1)</SectionLabel>
                <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
                  <CheckCircle2 className="h-3 w-3" />
                  Always measured
                </span>
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Slider
                  label="Latest MMSE Score"
                  value={features.mmse}
                  display={`${features.mmse} / 30`}
                  min={10}
                  max={30}
                  marks={['10 (Severe)', '24 (Cutoff)', '30 (Normal)']}
                  onChange={(v) => updateField('mmse', v)}
                />
                <Slider
                  label="MMSE Change vs Baseline"
                  value={features.mmse_change}
                  display={`${features.mmse_change > 0 ? '+' : ''}${features.mmse_change} pts`}
                  min={-8}
                  max={3}
                  marks={['-8 (Decline)', '0', '+3 (Stable)']}
                  onChange={(v) => updateField('mmse_change', v)}
                />
              </div>
            </div>

            {/* Blood — Stage 2, toggleable */}
            <div className="p-6">
              <div className="flex items-center justify-between">
                <SectionLabel size="sm">
                  <span className="inline-flex items-center gap-2">
                    <FlaskConical className="h-3.5 w-3.5 text-[#3B82F6]" />
                    Blood Biomarker Panel (Stage 2)
                  </span>
                </SectionLabel>
                <StageToggle on={stages.blood} onClick={() => toggleStage('blood')} />
              </div>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                <Slider
                  label="p-tau181 (plasma)"
                  value={features.ptau181}
                  display={`${Number(features.ptau181).toFixed(1)} pg/mL`}
                  min={0.6}
                  max={7.5}
                  step={0.1}
                  marks={['0.6 (Normal)', '4.0 (Cutoff)', '7.5 (High)']}
                  disabled={!stages.blood}
                  onChange={(v) => updateField('ptau181', v)}
                />
                <Slider
                  label="Aβ42/40 ratio"
                  value={features.abeta4240}
                  display={Number(features.abeta4240).toFixed(3)}
                  min={0.04}
                  max={0.16}
                  step={0.001}
                  marks={['0.04 (Low)', '0.068 (Cutoff)', '0.16 (Normal)']}
                  disabled={!stages.blood}
                  onChange={(v) => updateField('abeta4240', v)}
                />
              </div>
            </div>

            {/* MRI — Stage 3, toggleable */}
            <div className="p-6">
              <div className="flex items-center justify-between">
                <SectionLabel size="sm">
                  <span className="inline-flex items-center gap-2">
                    <Brain className="h-3.5 w-3.5 text-[#8B5CF6]" />
                    MRI Volumetrics (Stage 3)
                  </span>
                </SectionLabel>
                <StageToggle on={stages.mri} onClick={() => toggleStage('mri')} />
              </div>
              <div className="mt-5">
                <Slider
                  label="Hippocampal Volume"
                  value={features.hippocampal_volume}
                  display={`${Number(features.hippocampal_volume).toFixed(2)} cm³`}
                  min={1.6}
                  max={4.3}
                  step={0.05}
                  marks={['1.6 (Atrophy)', '2.25 (Cutoff)', '4.3 (Preserved)']}
                  disabled={!stages.mri}
                  onChange={(v) => updateField('hippocampal_volume', v)}
                />
              </div>
            </div>

            {/* PET — Stage 4, toggleable */}
            <div className="p-6">
              <div className="flex items-center justify-between">
                <SectionLabel size="sm">
                  <span className="inline-flex items-center gap-2">
                    <ScanLine className="h-3.5 w-3.5 text-[#EC4899]" />
                    PET Tracer Status (Stage 4)
                  </span>
                </SectionLabel>
                <StageToggle on={stages.pet} onClick={() => toggleStage('pet')} />
              </div>
              <div className={`mt-5 grid gap-5 sm:grid-cols-2 ${stages.pet ? '' : 'opacity-40 pointer-events-none'}`}>
                {[
                  ['amyloid_positive', 'Amyloid PET'],
                  ['tau_positive', 'Tau PET'],
                ].map(([key, label]) => (
                  <div key={key}>
                    <span className="block text-xs font-medium text-ink dark:text-darkText">{label}</span>
                    <div className="mt-2 flex gap-2">
                      {[
                        [false, 'Negative'],
                        [true, 'Positive'],
                      ].map(([val, lab]) => (
                        <button
                          key={lab}
                          type="button"
                          onClick={() => updateField(key, val)}
                          className={`flex-1 rounded-lg border py-1.5 text-xs font-semibold transition ${
                            features[key] === val
                              ? 'border-accent bg-accent text-white shadow-soft'
                              : 'border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText'
                          }`}
                        >
                          {lab}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Live Output & SHAP Waterfall on Right */}
        <div className="space-y-6 lg:col-span-5">
          {error ? (
            <div className="rounded-2xl border border-tierHigh/40 bg-tierHigh/10 p-6 text-tierHigh">
              <p className="font-semibold text-sm">Inference Error</p>
              <p className="mt-1 text-xs">{error}</p>
            </div>
          ) : result ? (
            <>
              {/* Primary Gauge Card */}
              <HeroPanel tier={tier}>
                <div className="flex flex-col items-center text-center">
                  <RiskGauge score={result.score} tier={tier} />
                  <div className="mt-2 flex items-center gap-2">
                    <TierTag tier={tier} size="lg" />
                    <span style={MONO} className="text-xs font-bold text-muted dark:text-darkMuted">
                      {fmtPercent(result.score)}
                    </span>
                  </div>
                </div>

                {/* Recommended Next Test — stage-aware */}
                <div className="mt-6 rounded-xl border border-line/60 dark:border-darkBorder/60 bg-white/70 dark:bg-darkCard/70 p-4 backdrop-blur">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink dark:text-darkText">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    Recommended Protocol:
                  </div>
                  <p className="mt-1 text-xs text-muted dark:text-darkMuted">{protocol}</p>
                </div>
              </HeroPanel>

              {/* SHAP Feature Waterfall */}
              <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
                <SectionLabel
                  size="sm"
                  right={
                    <span className="flex items-center gap-2 text-[10.5px] text-muted dark:text-darkMuted">
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-tierHigh" /> +Risk
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-tierLow" /> −Risk
                      </span>
                    </span>
                  }
                >
                  Biomarker & Risk Attribution Analysis
                </SectionLabel>

                <div className="mt-5 space-y-3.5">
                  {factors.length === 0 ? (
                    <p className="text-xs text-muted dark:text-darkMuted">Calculating feature importances…</p>
                  ) : (
                    factors.map((f, i) => {
                      const meta = FACTOR_META[f.feature] || { stage: 'Other', label: f.feature };
                      const isDefault = f.value === null || f.value === undefined;
                      const isUp = f.contribution > 0;
                      const abs = Math.abs(f.contribution);
                      const maxVal = Math.max(...factors.map((x) => Math.abs(x.contribution)), 0.05);
                      const widthPct = Math.min(100, Math.max(8, (abs / maxVal) * 100));
                      const color = isUp ? TIER_HEX.high : TIER_HEX.low;

                      return (
                        <div key={`${f.feature}-${i}`} className={`space-y-1 ${isDefault ? 'opacity-55' : ''}`}>
                          <div className="flex items-baseline justify-between text-xs">
                            <span className="font-medium text-ink dark:text-darkText truncate">
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle"
                                style={{ backgroundColor: STAGE_COLORS[meta.stage] || '#6E7175' }}
                              />
                              {meta.label}
                              <span style={MONO} className="ml-1 text-[10.5px] text-muted dark:text-darkMuted">
                                · {formatFactorValue(f)}
                              </span>
                              {isDefault && (
                                <span className="ml-1.5 rounded border border-line dark:border-darkBorder px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted dark:text-darkMuted">
                                  model default
                                </span>
                              )}
                            </span>
                            <span className="font-bold text-[11px]" style={{ ...MONO, color }}>
                              {isUp ? '+' : '−'}{abs.toFixed(3)}
                            </span>
                          </div>
                          <div className="h-1.5 w-full rounded-full bg-[#EAE7DF] dark:bg-darkBorder overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-300"
                              style={{ width: `${widthPct}%`, backgroundColor: color }}
                            />
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
