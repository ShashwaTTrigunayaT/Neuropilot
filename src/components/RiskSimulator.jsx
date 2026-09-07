import { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Loader2,
  Play,
  SlidersHorizontal,
  User,
} from 'lucide-react';
import { api } from '../api.js';
import { fmtScore, fmtPercent } from '../lib.js';
import TierTag from './TierTag.jsx';
import {
  HeroPanel,
  MONO,
  RiskGauge,
  SectionLabel,
  TIER_HEX,
  TIER_LABEL,
} from './widgets.jsx';

const PRESETS = [
  {
    name: 'High Risk (Suspected MCI)',
    desc: 'Rapid MMSE decline, advanced age, brain atrophy',
    features: {
      age: 78,
      sex: 'F',
      education_years: 12,
      ses: 2,
      mmse: 21,
      mmse_change: -4,
      nwbv: 0.692,
      etiv: 1480,
      asf: 1.18,
      n_visits: 2,
      study_years: 1.5,
    },
  },
  {
    name: 'Borderline (Moderate Watch)',
    desc: 'Mild MMSE decrease, moderate age, preserved brain volume',
    features: {
      age: 72,
      sex: 'M',
      education_years: 16,
      ses: 2,
      mmse: 26,
      mmse_change: -1,
      nwbv: 0.738,
      etiv: 1620,
      asf: 1.08,
      n_visits: 2,
      study_years: 1.2,
    },
  },
  {
    name: 'Low Risk (Healthy Aging)',
    desc: 'Normal MMSE, stable trajectory, high education',
    features: {
      age: 67,
      sex: 'F',
      education_years: 18,
      ses: 1,
      mmse: 29,
      mmse_change: 0,
      nwbv: 0.785,
      etiv: 1390,
      asf: 1.26,
      n_visits: 2,
      study_years: 2.0,
    },
  },
];

export default function RiskSimulator({ initialPatient = null, onSelectPatient }) {
  const [features, setFeatures] = useState(() => {
    if (initialPatient) {
      return {
        age: initialPatient.age || 75,
        sex: initialPatient.sex || 'F',
        education_years: initialPatient.education_years || 14,
        ses: 2,
        mmse: initialPatient.cognitive?.latest || 25,
        mmse_change: (initialPatient.cognitive?.latest || 25) - (initialPatient.cognitive?.prior || 25),
        nwbv: 0.725,
        etiv: 1510,
        asf: 1.15,
        n_visits: 2,
        study_years: 1.5,
      };
    }
    return PRESETS[0].features;
  });

  const [scoring, setScoring] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [autoScore, setAutoScore] = useState(true);

  const runScore = useCallback(
    async (feat) => {
      setScoring(true);
      setError('');
      try {
        const payload = {
          ...feat,
          sex: feat.sex === 'M' || feat.sex === 1 ? 1 : 0,
        };
        const res = await api.scorePatient(payload);
        setResult(res);
      } catch (err) {
        setError(err.message);
      } finally {
        setScoring(false);
      }
    },
    []
  );

  useEffect(() => {
    if (autoScore) {
      const timer = setTimeout(() => runScore(features), 250);
      return () => clearTimeout(timer);
    }
  }, [features, autoScore, runScore]);

  const updateField = (key, val) => {
    setFeatures((prev) => ({ ...prev, [key]: val }));
  };

  const applyPreset = (preset) => {
    setFeatures({ ...preset.features });
  };

  const tier = result ? result.risk_tier : 'medium';
  const factors = result?.factors || [];

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
              <span>Interactive Modeling</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>Longitudinal Trajectory Simulation</span>
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
            onClick={() => runScore(features)}
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
            const IconComp = idx === 0 ? AlertTriangle : (idx === 1 ? Activity : CheckCircle2);
            const iconColor = idx === 0 ? 'text-tierHigh' : (idx === 1 ? 'text-tierMedium' : 'text-tierLow');
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
        {/* Sliders / Inputs - Unified Clinical Parameter Workbench */}
        <div className="space-y-6 lg:col-span-7">
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 divide-y divide-line/60 dark:divide-darkBorder/60">
            {/* Demographics & Cognitive */}
            <div className="p-6">
              <SectionLabel size="sm">Patient Demographics & Cognitive Markers</SectionLabel>

              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {/* Age */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Age</span>
                    <span style={MONO} className="font-bold text-accent">{features.age} yrs</span>
                  </div>
                  <input
                    type="range"
                    min="55"
                    max="95"
                    value={features.age}
                    onChange={(e) => updateField('age', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>55y</span>
                    <span>95y</span>
                  </div>
                </div>

                {/* Sex */}
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

                {/* MMSE Score */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Latest MMSE Score</span>
                    <span style={MONO} className="font-bold text-accent">{features.mmse} / 30</span>
                  </div>
                  <input
                    type="range"
                    min="10"
                    max="30"
                    value={features.mmse}
                    onChange={(e) => updateField('mmse', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>10 (Severe)</span>
                    <span>24 (Cutoff)</span>
                    <span>30 (Normal)</span>
                  </div>
                </div>

                {/* MMSE Change */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">MMSE Change vs Baseline</span>
                    <span
                      style={MONO}
                      className={`font-bold ${features.mmse_change < 0 ? 'text-tierHigh' : 'text-tierLow'}`}
                    >
                      {features.mmse_change > 0 ? `+${features.mmse_change}` : features.mmse_change} pts
                    </span>
                  </div>
                  <input
                    type="range"
                    min="-8"
                    max="3"
                    value={features.mmse_change}
                    onChange={(e) => updateField('mmse_change', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>-8 (Decline)</span>
                    <span>0</span>
                    <span>+3 (Stable)</span>
                  </div>
                </div>

                {/* Education */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Education Years</span>
                    <span style={MONO} className="font-bold text-accent">{features.education_years} yrs</span>
                  </div>
                  <input
                    type="range"
                    min="6"
                    max="24"
                    value={features.education_years}
                    onChange={(e) => updateField('education_years', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>6y</span>
                    <span>12y (HS)</span>
                    <span>24y</span>
                  </div>
                </div>

                {/* SES */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Socioeconomic Class (SES)</span>
                    <span style={MONO} className="font-bold text-accent">Tier {features.ses}</span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="5"
                    value={features.ses}
                    onChange={(e) => updateField('ses', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>1 (Highest)</span>
                    <span>5 (Lowest)</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Neuroimaging Biomarkers */}
            <div className="p-6">
              <SectionLabel size="sm">Structural MRI Morphometry</SectionLabel>
              <div className="mt-5 grid gap-5 sm:grid-cols-2">
                {/* nWBV */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Normalized Whole Brain Volume (nWBV)</span>
                    <span style={MONO} className="font-bold text-accent">{(features.nwbv * 100).toFixed(1)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0.65"
                    max="0.85"
                    step="0.005"
                    value={features.nwbv}
                    onChange={(e) => updateField('nwbv', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>0.65 (Atrophy)</span>
                    <span>0.75</span>
                    <span>0.85 (Preserved)</span>
                  </div>
                </div>

                {/* eTIV */}
                <div>
                  <div className="flex justify-between text-xs">
                    <span className="font-medium text-ink dark:text-darkText">Estimated Total Intracranial Volume (eTIV)</span>
                    <span style={MONO} className="font-bold text-accent">{features.etiv} cm³</span>
                  </div>
                  <input
                    type="range"
                    min="1100"
                    max="1950"
                    step="10"
                    value={features.etiv}
                    onChange={(e) => updateField('etiv', Number(e.target.value))}
                    className="mt-2 w-full accent-accent cursor-pointer"
                  />
                  <div className="flex justify-between text-[10px] text-muted dark:text-darkMuted" style={MONO}>
                    <span>1100 cm³</span>
                    <span>1950 cm³</span>
                  </div>
                </div>
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

                {/* Recommended Next Test */}
                <div className="mt-6 rounded-xl border border-line/60 dark:border-darkBorder/60 bg-white/70 dark:bg-darkCard/70 p-4 backdrop-blur">
                  <div className="flex items-center gap-2 text-xs font-semibold text-ink dark:text-darkText">
                    <span className="h-2 w-2 rounded-full bg-accent" />
                    Recommended Protocol:
                  </div>
                  <p className="mt-1 text-xs text-muted dark:text-darkMuted">
                    {tier === 'high' || tier === 'medium'
                      ? 'Order Stage 2: Blood biomarker panel (plasma p-tau181, Aβ42/40) to confirm pathology.'
                      : 'Stage 1 complete: Low risk. Schedule routine follow-up cognitive evaluation in 12 months.'}
                  </p>
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
                      const isUp = f.contribution > 0;
                      const abs = Math.abs(f.contribution);
                      const maxVal = Math.max(...factors.map((x) => Math.abs(x.contribution)), 0.05);
                      const widthPct = Math.min(100, Math.max(8, (abs / maxVal) * 100));
                      const color = isUp ? TIER_HEX.high : TIER_HEX.low;

                      return (
                        <div key={`${f.feature}-${i}`} className="space-y-1">
                          <div className="flex items-baseline justify-between text-xs">
                            <span className="font-medium text-ink dark:text-darkText truncate">
                              {f.feature}
                              <span style={MONO} className="ml-1 text-[10.5px] text-muted dark:text-darkMuted">
                                · {typeof f.value === 'number' ? (f.feature === 'sex' ? (f.value === 1 ? 'Male' : 'Female') : f.value.toFixed(2)) : (f.value ?? 'N/A')}
                              </span>
                            </span>
                            <span
                              className="font-bold text-[11px]"
                              style={{ ...MONO, color }}
                            >
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
