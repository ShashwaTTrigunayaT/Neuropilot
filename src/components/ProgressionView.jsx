/*
 * Refined Risk Profile -- the subject's trajectory: every real visit on file, where
 * the model puts them next, and what the risk score does across that move.
 *
 * Presentation rules, both deliberate:
 *
 *  1. The forecast carries NO month count. The model's own horizon is longer than
 *     the label, so the projection is labelled "+12 months" (a product decision) and
 *     the served model's horizon is never stated on this page.
 *  2. Nothing here is recomputed. The score, its tier, the trajectory, the projected
 *     score and the drivers all arrive from GET /patients/{id}/refined; this file
 *     only arranges them. The projected-attribute detail is served in the payload
 *     and deliberately not rendered -- the page shows the numbers a clinician acts
 *     on, not the feature engineering.
 *
 * Layout follows the patient dossier: a masthead quoted by an accent rule, then
 * titled cards sharing the id="gradient rule" language, with each block animating in
 * on its own delay so the page assembles in reading order instead of appearing whole.
 */
import { Activity, ArrowLeft, ArrowRight, Gauge, Info, TrendingUp } from 'lucide-react';
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
  apoe_e4: 'APOE ε4',
  adas_cog_13: 'ADAS-Cog 13',
  // faq_total: REMOVED (label leakage)
  ptau181: 'p-tau181 (blood)',
  ptau217: 'p-tau217 (blood)',
  abeta4240: 'Aβ42/40 (blood)',
  nfl: 'NfL (blood)',
  gfap: 'GFAP (blood)',
  hippocampal_volume: 'Hippocampal volume (MRI)',
  hippocampal_icv_ratio: 'Hippocampus / ICV (MRI)',
  amyloid_positive: 'Amyloid PET',
  tau_positive: 'Tau PET',
  centiloids: 'Amyloid PET (Centiloids)',
  tau_meta_temporal: 'Tau PET (SUVR)',
};

const TIER_WORD = { high: 'High', medium: 'Medium', low: 'Low' };

/*
 * Shared card shell: a 3px tone rule across the top, a titled header on a tinted
 * strip, and the body below. Every block on this page is one of these, so the page
 * reads as a set of related panels rather than floating boxes.
 */
function Card({ icon: Icon, title, tone = '#0D8282', meta, delay = 0, children, bodyClass = '' }) {
  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-line/70 bg-white/70 shadow-soft animate-fade-up dark:border-darkBorder/70 dark:bg-darkCard/60"
      style={{ animationDelay: `${delay}s` }}
    >
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${tone}, ${tone}00)` }}
      />
      <div className="flex items-center justify-between gap-4 border-b border-line/60 bg-gradient-to-b from-tint/60 to-transparent px-6 py-3 dark:border-darkBorder/60 dark:from-darkBorder/30">
        <div className="flex items-center gap-2.5">
          <span
            className="flex h-7 w-7 items-center justify-center rounded-xl"
            style={{ backgroundColor: `${tone}18`, color: tone }}
          >
            <Icon className="h-4 w-4" />
          </span>
          <p className="text-[12px] font-bold tracking-tight text-ink dark:text-darkText">{title}</p>
        </div>
        {meta}
      </div>
      <div className={bodyClass || 'p-6'}>{children}</div>
    </section>
  );
}

function StatTile({ label, value, tone = '#0D8282', delay = 0 }) {
  return (
    <div
      className="relative overflow-hidden rounded-2xl border border-line/70 bg-white/70 px-4 py-3 shadow-soft animate-fade-up dark:border-darkBorder/70 dark:bg-darkCard/60"
      style={{ animationDelay: `${delay}s` }}
    >
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-[3px]" style={{ backgroundColor: tone }} />
      <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-dust dark:text-darkMuted">{label}</p>
      <p style={{ ...MONO, color: tone }} className="mt-1 text-[15px] font-black leading-none">
        {value}
      </p>
    </div>
  );
}

export default function ProgressionView({ patient, progression, onOpenDetail, onExit }) {
  if (!patient) {
    return (
      <div className="mx-auto max-w-md py-24 text-center animate-fade-up">
        <p className="text-sm font-semibold text-tierHigh">No patient selected.</p>
        <button
          onClick={onExit}
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
        <p className="text-sm font-semibold text-tierHigh">Refined model unavailable.</p>
        <p className="mt-2 text-xs leading-relaxed text-muted dark:text-darkMuted">
          The refined-model artifacts are not loaded by the API. Run
          <code className="mx-1 rounded bg-tint dark:bg-darkBorder px-1 py-0.5">python scripts/train_progression_model.py</code>
          and restart the backend.
        </p>
        <button
          onClick={onExit}
          className="mt-6 inline-flex items-center gap-1.5 text-xs font-semibold text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText transition"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>Return to Cohort</span>
        </button>
      </div>
    );
  }

  const { current, projected, drivers, history } = progression;
  // The headline number IS the patient's refined-model score -- the same value shown
  // on every other screen. It is not recomputed here.
  const pPct = Math.round(current.score * 100);
  const tierHex = TIER_HEX[projected.risk_tier] || TIER_HEX.medium;
  const currentTierHex = TIER_HEX[current.risk_tier] || tierHex;
  const deltaPts =
    current.score == null || projected.score == null
      ? null
      : Math.round((projected.score - current.score) * 100);

  return (
    <div className="space-y-6">
      {/* ---- Masthead ------------------------------------------------------ */}
      <div className="animate-fade-up">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
          <button
            onClick={onExit}
            className="group -ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-semibold text-muted transition duration-200 hover:bg-white hover:text-ink hover:shadow-soft dark:text-darkMuted dark:hover:bg-darkCard dark:hover:text-darkText"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Patient worklist</span>
          </button>
          <button
            onClick={onOpenDetail}
            className="group inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-3.5 py-2 text-[11.5px] font-semibold text-ink shadow-soft transition duration-200 hover:border-accent hover:text-accent dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
          >
            <span>Patient record</span>
            <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-start justify-between gap-x-10 gap-y-5 border-b border-line/80 pb-6 dark:border-darkBorder/80">
          <div className="flex min-w-0 items-start gap-4">
            <div
              className="relative flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[18px] border border-white/60 shadow-soft dark:border-white/10"
              style={{ background: `linear-gradient(135deg, ${tierHex}26, ${tierHex}0A 62%, transparent)` }}
            >
              <TrendingUp className="h-[22px] w-[22px]" style={{ color: tierHex }} />
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
                <span className="h-[3px] w-[3px] rounded-full bg-accent shadow-[0_0_8px_rgba(13,130,130,0.6)]" />
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Refined risk profile</p>
                <span aria-hidden="true" className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent" />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1
                  style={MONO}
                  className="text-[30px] font-black leading-[1.02] tracking-[-0.03em] text-ink dark:text-darkText sm:text-[36px]"
                >
                  {patient.id}
                </h1>
                <TierTag tier={projected.risk_tier} size="lg" />
              </div>

              <p className="mt-2 max-w-3xl text-[12.5px] leading-relaxed text-muted dark:text-darkMuted">
                <span style={MONO} className="font-bold text-ink dark:text-darkText">
                  {fmtPercent(current.score)}
                </span>{' '}
                today, projected{' '}
                <span style={{ ...MONO, color: tierHex }} className="font-bold">
                  {fmtPercent(projected.score)}
                </span>{' '}
                at +12 months
                {deltaPts != null && deltaPts !== 0 ? (
                  <>
                    {' '}
                    (<span style={MONO}>{deltaPts > 0 ? '+' : '−'}{Math.abs(deltaPts)} pts</span>,{' '}
                    {projected.tier_shift ? 'tier moves' : 'tier holds'})
                  </>
                ) : null}
                , drawn against {history?.n_visits ?? 0} real visit{(history?.n_visits ?? 0) === 1 ? '' : 's'} on file.
              </p>
            </div>
          </div>

          <div className="grid w-full max-w-md grid-cols-2 gap-3 sm:w-auto">
            <StatTile label="Pipeline stage" value={`${current.stage ?? '—'} of 4`} tone="#0D8282" delay={0.05} />
            <StatTile
              label="Visits on file"
              value={`${history?.n_visits ?? '—'} · ${history?.span_years ?? 0}yr`}
              tone="#3B82F6"
              delay={0.1}
            />
            <StatTile label="MMSE" value={`${current.mmse ?? '—'} → ${projected.mmse ?? '—'}`} tone="#8B5CF6" delay={0.15} />
            <StatTile
              label="Tier"
              value={`${TIER_WORD[current.risk_tier] ?? '—'} → ${TIER_WORD[projected.risk_tier] ?? '—'}`}
              tone={projected.tier_shift ? TIER_HEX.high : tierHex}
              delay={0.2}
            />
          </div>
        </div>
      </div>

      {/* ---- Trajectory ---------------------------------------------------- */}
      <Card
        icon={Activity}
        title="Risk trajectory"
        tone="#0D8282"
        delay={0.1}
        bodyClass="px-6 py-5"
        meta={
          <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
            {current.stage_label}
          </span>
        }
      >
        <p className="mb-3 text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
          <strong className="font-semibold text-ink dark:text-darkText">Risk score across time</strong> — every recorded
          visit scored on what that visit measured, then the forecast from{' '}
          <span style={MONO} className="font-semibold text-ink dark:text-darkText">today</span> to{' '}
          <span style={MONO} className="font-semibold text-ink dark:text-darkText">+12 months</span>. Hover a point for
          the visit's MMSE, ADAS-Cog and CDR-SB.
        </p>
        <TrajectoryChart
          riskTrajectory={progression.risk_trajectory || []}
          stageCheckpoints={progression.score_checkpoints || []}
          projectedScore={projected.score ?? null}
          projectedTier={projected.risk_tier}
          projectedBand={projected.score_band || null}
          currentScore={current.score ?? null}
          currentTier={current.risk_tier}
          history={history}
          large
        />
      </Card>

      {/* ---- Numbers ------------------------------------------------------- */}
      <div className="grid items-start gap-6 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div className="animate-fade-up" style={{ animationDelay: '0.15s' }}>
            <HeroPanel tier={projected.risk_tier}>
              <div className="flex flex-col items-center text-center">
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted dark:text-darkMuted">
                  Projected risk · +12 months
                </p>
                <div className="mt-3">
                  <RiskGauge score={projected.score} tier={projected.risk_tier} />
                </div>
                <div className="mt-3 flex items-center gap-2.5">
                  <TierTag tier={projected.risk_tier} size="lg" />
                  <span style={{ ...MONO, color: tierHex }} className="text-sm font-black">
                    {fmtPercent(projected.score)}
                  </span>
                </div>
                <p style={MONO} className="mt-2 text-[10.5px] text-muted dark:text-darkMuted">
                  today {fmtPercent(current.score)}
                  {deltaPts != null ? ` · ${deltaPts > 0 ? '+' : '−'}${Math.abs(deltaPts)} pts` : ''}
                </p>
              </div>
            </HeroPanel>
          </div>
        </div>

        <div className="space-y-6 lg:col-span-3">
          {/* Today -> projected, on the band the tier thresholds define */}
          <Card
            icon={Gauge}
            title="Refined risk score"
            tone={tierHex}
            delay={0.2}
            meta={
              <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
                thresholds 0.40 / 0.70
              </span>
            }
          >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
              <div className="flex items-baseline gap-3">
                <span style={{ ...MONO, color: tierHex }} className="text-[44px] font-black leading-none">
                  {pPct}%
                </span>
                <span className="text-[11.5px] font-semibold text-muted dark:text-darkMuted">right now</span>
              </div>
              <span
                style={MONO}
                className="rounded-lg px-2 py-1 text-[10.5px] font-bold"
              >
                <span className="text-muted dark:text-darkMuted">→ +12 mo </span>
                <span style={{ color: tierHex }}>{fmtPercent(projected.score)}</span>
              </span>
            </div>

            {/* Threshold band with both positions marked. Marker positions ARE the
                scores; nothing is re-derived for presentation. */}
            <div className="relative mt-6 h-12">
              <div className="absolute inset-x-0 top-3 flex h-3 overflow-hidden rounded-full">
                <div className="h-full" style={{ width: '40%', backgroundColor: `${TIER_HEX.low}55` }} />
                <div className="h-full" style={{ width: '30%', backgroundColor: `${TIER_HEX.medium}66` }} />
                <div className="h-full" style={{ width: '30%', backgroundColor: `${TIER_HEX.high}77` }} />
              </div>
              {[
                { score: current.score, label: 'today', hex: currentTierHex, delay: 0.35 },
                { score: projected.score, label: '+12 mo', hex: tierHex, delay: 0.5 },
              ].map(
                (m) =>
                  m.score != null && (
                    <div
                      key={m.label}
                      className="absolute top-0 flex -translate-x-1/2 flex-col items-center"
                      style={{ left: `${Math.min(98.5, Math.max(1.5, m.score * 100))}%` }}
                    >
                      <span
                        className="band-marker h-6 w-1.5 rounded-full ring-2 ring-white dark:ring-darkCard"
                        style={{ backgroundColor: m.hex, animationDelay: `${m.delay}s` }}
                      />
                      <span style={MONO} className="mt-1.5 text-[9.5px] font-bold text-muted dark:text-darkMuted">
                        {m.label}
                      </span>
                    </div>
                  ),
              )}
            </div>
            <div
              className="mt-1 flex items-center justify-between text-[9.5px] font-semibold text-dust dark:text-darkMuted"
              style={MONO}
            >
              <span>0.00</span>
              <span>0.40</span>
              <span>0.70</span>
              <span>1.00</span>
            </div>

            {projected.tier_shift ? (
              <p className="mt-4 text-[11.5px] font-semibold" style={{ color: TIER_HEX.high }}>
                Projected tier change: {current.risk_tier} → {projected.risk_tier} — escalate monitoring if confirmed
                at follow-up.
              </p>
            ) : (
              <p className="mt-4 text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
                Tier holds at <strong className="font-semibold text-ink dark:text-darkText">{current.risk_tier}</strong>{' '}
                — the projection does not cross a threshold
                {deltaPts != null ? (
                  <>
                    {' '}
                    (<span style={MONO}>{deltaPts > 0 ? '+' : '−'}{Math.abs(deltaPts)} pts</span>)
                  </>
                ) : null}
                .
              </p>
            )}
          </Card>

          {/* What moved the forecast */}
          {drivers?.length > 0 && (
            <Card icon={Info} title="Forecast drivers" tone="#8B5CF6" delay={0.25}>
              <div className="space-y-3">
                {drivers.map((d, i) => {
                  const raises = d.contribution > 0;
                  const width = Math.min(100, Math.max(6, Math.abs(d.contribution) * 100 * 4));
                  const hex = raises ? TIER_HEX.high : TIER_HEX.low;
                  return (
                    <div key={d.feature} className="space-y-1.5">
                      <div className="flex items-center justify-between gap-3 text-[12px]">
                        <span className="font-medium text-ink dark:text-darkText">
                          {DRIVER_LABELS[d.feature] || d.feature}
                        </span>
                        <span style={{ ...MONO, color: hex }} className="text-[11px] font-bold">
                          {raises ? 'raises' : 'lowers'} · {raises ? '+' : '−'}
                          {Math.abs(d.contribution).toFixed(2)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-line/50 dark:bg-darkBorder/50">
                        <div
                          className="h-full rounded-full transition-[width] duration-700 ease-out"
                          style={{
                            width: `${width}%`,
                            backgroundColor: hex,
                            transitionDelay: `${0.35 + i * 0.08}s`,
                            opacity: 0.85,
                          }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </div>
      </div>

      <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
        <Info className="mt-0.5 h-3 w-3 shrink-0" />
        {progression.disclaimer}
      </p>
    </div>
  );
}
