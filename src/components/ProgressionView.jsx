import { ArrowLeft, Info, TrendingUp } from 'lucide-react';
import TierTag from './TierTag.jsx';
import TrajectoryChart from './TrajectoryChart.jsx';
import { MONO, HeroPanel, RiskGauge, SectionLabel, TIER_HEX } from './widgets.jsx';
import { fmtPercent } from '../lib.js';

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

function LoadingView({ id, onBack }) {
  return (
    <div className="space-y-6 animate-fade-up">
      <div className="h-5 w-40 rounded bg-line dark:bg-darkBorder" />
      <div className="grid gap-8 lg:grid-cols-5">
        <div className="h-64 rounded-2xl bg-line dark:bg-darkBorder lg:col-span-3" />
        <div className="h-64 rounded-2xl bg-line dark:bg-darkBorder lg:col-span-2" />
      </div>
      <p style={MONO} className="text-center text-[11px] text-muted dark:text-darkMuted">
        Computing 12-month projection for {id || 'patient'}…
      </p>
    </div>
  );
}

export default function ProgressionView({ patient, progression, onBack, onOpenDetail }) {
  if (!patient) {
    return (
      <div className="mx-auto max-w-md py-24 text-center animate-fade-up">
        <p className="text-sm font-semibold text-tierHigh">No patient selected.</p>
        <button
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Return to Cohort</span>
        </button>
      </div>
    );
  }

  if (!progression || !progression.model_available) {
    return (
      <div className="mx-auto max-w-md py-24 text-center animate-fade-up">
        <p className="text-sm font-semibold text-tierHigh">Progression model unavailable.</p>
        <p className="mt-2 text-xs leading-relaxed text-muted dark:text-darkMuted">
          The 12-month forecaster artifacts are not loaded by the API. Run
          <code className="mx-1 rounded bg-tint dark:bg-darkBorder px-1 py-0.5">python scripts/train_progression_model.py</code>
          and restart the backend.
        </p>
        <button
          onClick={onBack}
          className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Return to Cohort</span>
        </button>
      </div>
    );
  }

  const { current, projected, drivers } = progression;
  const pPct = Math.round(projected.conversion_probability * 100);
  const convColor =
    projected.conversion_probability >= 0.6
      ? TIER_HEX.high
      : projected.conversion_probability >= 0.3
        ? TIER_HEX.medium
        : TIER_HEX.low;

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-line/80 dark:border-darkBorder/80 pb-6">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 dark:from-accent/25 dark:to-accent/10 border border-accent/25 text-accent shadow-sm">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-[28px] sm:text-[32px] font-black tracking-tight text-ink dark:text-darkText leading-none">
              Progression Probability
            </h1>
            <p className="mt-1.5 text-[13px] text-muted dark:text-darkMuted flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <button
                onClick={onOpenDetail}
                style={MONO}
                className="font-bold text-accent hover:underline"
                title="Open the full patient record"
              >
                {patient.id}
              </button>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>12-month trajectory forecast</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>{current.stage_label}</span>
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="text-[10px] uppercase tracking-wide text-muted dark:text-darkMuted">Current risk</p>
            <div className="mt-1 flex items-center justify-end gap-2">
              <TierTag tier={current.risk_tier} />
              <span style={MONO} className="text-xs font-bold text-ink dark:text-darkText">
                {fmtPercent(current.score)}
              </span>
            </div>
          </div>
          <button
            onClick={onBack}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 py-2 text-xs font-semibold text-ink dark:text-darkText hover:border-accent transition"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Patient Record</span>
          </button>
        </div>
      </div>

      <div className="grid items-start gap-8 lg:grid-cols-5">
        {/* Left: chart + methodology */}
        <div className="space-y-6 lg:col-span-3">
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
            <SectionLabel
              size="sm"
              right={
                <span style={MONO} className="text-[10px] font-bold uppercase tracking-wide text-accent">
                  MMSE over time
                </span>
              }
            >
              Observed vs Predicted Trajectory
            </SectionLabel>
            <div className="mt-4">
              <TrajectoryChart trajectory={progression.trajectory} large />
            </div>
          </div>
        </div>

        {/* Right: headline numbers */}
        <div className="space-y-6 lg:col-span-2">
          <HeroPanel tier={projected.risk_tier}>
            <div className="flex flex-col items-center text-center">
              <RiskGauge score={projected.score} tier={projected.risk_tier} />
              <div className="mt-2 flex items-center gap-2">
                <TierTag tier={projected.risk_tier} size="lg" />
                <span style={MONO} className="text-xs font-bold text-muted dark:text-darkMuted">
                  {fmtPercent(projected.score)} projected
                </span>
              </div>
              <p style={MONO} className="mt-1 text-[10.5px] text-muted dark:text-darkMuted">
                today {fmtPercent(current.score)} · 12 mo {fmtPercent(projected.score)}
                {projected.tier_shift ? ' · tier shift' : ' · tier stable'}
              </p>
            </div>
          </HeroPanel>

          {/* Conversion probability — the headline number */}
          <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
            <SectionLabel size="sm">Probability of clinical progression</SectionLabel>
            <div className="mt-3 flex items-baseline justify-between">
              <span style={MONO} className="text-4xl font-black" style={{ color: convColor }}>
                {pPct}%
              </span>
              <span className="text-[11px] text-muted dark:text-darkMuted">within 12 months</span>
            </div>
            <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-line/50 dark:bg-darkBorder/60">
              <div
                className="h-full rounded-full transition-all duration-700"
                style={{ width: `${Math.max(3, pPct)}%`, backgroundColor: convColor }}
              />
            </div>
            {projected.tier_shift && (
              <p className="mt-3 text-[11.5px] font-semibold" style={{ color: TIER_HEX.high }}>
                Projected tier change: {current.risk_tier} → {projected.risk_tier} — escalate monitoring if
                confirmed at follow-up.
              </p>
            )}
          </div>

          {/* Projected metrics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl border border-line/60 dark:border-darkBorder/60 bg-white/60 dark:bg-darkCard/60 p-4">
              <p className="text-[10px] uppercase tracking-wide text-muted dark:text-darkMuted">Projected MMSE</p>
              <p style={MONO} className="mt-1.5 text-lg font-bold text-ink dark:text-darkText">
                {current.mmse} → {projected.mmse}
              </p>
              <p
                style={MONO}
                className="mt-0.5 text-[11px] font-semibold"
                style={{ color: projected.mmse_delta < 0 ? TIER_HEX.high : TIER_HEX.low }}
              >
                {projected.mmse_delta > 0 ? '+' : ''}
                {projected.mmse_delta} pts ± {projected.band}
              </p>
            </div>
            <div className="rounded-2xl border border-line/60 dark:border-darkBorder/60 bg-white/60 dark:bg-darkCard/60 p-4">
              <p className="text-[10px] uppercase tracking-wide text-muted dark:text-darkMuted">Risk score shift</p>
              <p style={MONO} className="mt-1.5 text-lg font-bold text-ink dark:text-darkText">
                {current.score?.toFixed(2)} → {projected.score?.toFixed(2)}
              </p>
              <p style={MONO} className="mt-0.5 text-[11px] text-muted dark:text-darkMuted">
                Δ {projected.score - current.score >= 0 ? '+' : ''}
                {(projected.score - current.score).toFixed(2)}
              </p>
            </div>
          </div>

          {/* Drivers */}
          {drivers?.length > 0 && (
            <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
              <SectionLabel size="sm">Forecast drivers</SectionLabel>
              <div className="mt-3 space-y-2">
                {drivers.map((d) => (
                  <div key={d.feature} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-ink dark:text-darkText">
                      {DRIVER_LABELS[d.feature] || d.feature}
                    </span>
                    <span
                      style={MONO}
                      className={`rounded-md px-1.5 py-0.5 text-[11px] font-bold ${
                        d.contribution > 0
                          ? 'bg-tierHigh/10 text-tierHigh'
                          : 'bg-tierLow/10 text-tierLow'
                      }`}
                    >
                      {d.contribution > 0 ? 'raises' : 'lowers'} · {d.contribution > 0 ? '+' : '−'}
                      {Math.abs(d.contribution).toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            <Info className="mt-0.5 h-3 w-3 shrink-0" />
            {progression.disclaimer}
          </p>
        </div>
      </div>
    </div>
  );
}
