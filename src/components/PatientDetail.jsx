import { useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FlaskConical,
  IdCard,
  Plus,
  Printer,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  X,
} from 'lucide-react';
import { STAGES_SHORT, fmtScore, fmtPercent } from '../lib.js';
import TierTag from './TierTag.jsx';
import {
  BiomarkerRangeIndicator,
  Btn,
  HeroPanel,
  MONO,
  RiskGauge,
  SectionLabel,
  STAGE_FILLS,
  TIER_HEX,
  TIER_LABEL,
} from './widgets.jsx';

const SLOT_STAGE = { blood: 2, imaging: 3, pet: 4 };
const SLOT_LABEL = { blood: 'Blood biomarkers', imaging: 'MRI volumetrics', pet: 'PET imaging' };

/*
 * The priority band.
 *
 * The score used to be ten lines of prose with a legend underneath it. It is
 * now the three things a reader actually needs, in the order they need them:
 * the number at display size, the scale it sits on, and the three scores side
 * by side. The explanatory footnote survives in one line at the bottom, because
 * it is the rule that produces the tier and dropping it would hide the gate.
 */
function ScoreSection({ patient }) {
  const tier = patient.risk_tier;
  const hex = TIER_HEX[tier] || 'var(--accent)';
  const score = patient.score ?? 0;
  const marker = Math.max(0, Math.min(100, score * 100));
  const confidence = Math.round((patient.estimate_confidence ?? 1) * 100);

  const bands = [
    { key: 'low', label: 'Low', range: '< 0.40', width: 40 },
    { key: 'medium', label: 'Medium', range: '0.40–0.70', width: 30 },
    { key: 'high', label: 'High', range: '> 0.70', width: 30 },
  ];

  const stats = [
    { label: 'Official', value: patient.official_score ?? patient.score, caption: 'measured risk' },
    {
      label: 'Provisional',
      value: patient.provisional_score ?? patient.score,
      caption: confidence < 100 ? `${confidence}% confidence` : 'complete inputs',
    },
    { label: 'Priority', value: patient.final_score ?? patient.score, caption: 'triage order', accent: true },
  ];

  return (
    <section>
      <div className="flex flex-col items-center gap-7 lg:flex-row lg:items-center lg:gap-10">
        <RiskGauge score={patient.score} tier={tier} />

        <div className="w-full flex-1">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-muted dark:text-darkMuted">
              Predicted probability
            </p>
            <span style={MONO} className="text-[11px] text-muted dark:text-darkMuted">
              updated {patient.updated_at?.substring(5, 16) ?? '—'}
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-2">
            <p style={MONO} className="text-[42px] font-black leading-none tabular-nums text-ink dark:text-darkText">
              {fmtScore(score)}
            </p>
            <TierTag tier={tier} size="lg" />
            <span className="max-w-[30ch] text-[11px] leading-snug text-muted dark:text-darkMuted">
              measured risk, banded to a tier — decision support for triage, never a diagnosis
            </span>
          </div>

          {/* The scale the tier is cut from. Three bands, the occupied one lit,
              and a needle at the score, so "how close to the next line" is a
              glance rather than an arithmetic step. */}
          <div className="relative mt-6">
            <div className="relative flex h-2.5 w-full overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
              {bands.map((b) => (
                <span
                  key={b.key}
                  className="h-full transition-all"
                  style={{
                    width: `${b.width}%`,
                    backgroundColor: tier === b.key ? TIER_HEX[b.key] : `${TIER_HEX[b.key]}38`,
                    boxShadow: tier === b.key ? `0 0 16px -1px ${TIER_HEX[b.key]}` : undefined,
                  }}
                />
              ))}
            </div>
            <span
              aria-hidden="true"
              className="absolute -top-[5px] h-5 w-[3px] -translate-x-1/2 rounded-full border border-white bg-ink shadow-soft dark:border-darkCard dark:bg-white"
              style={{ left: `${marker}%` }}
            />
            <div className="mt-2 flex">
              {bands.map((b) => (
                <p
                  key={b.key}
                  style={{ width: `${b.width}%` }}
                  className={`text-[9.5px] leading-tight sm:text-[10px] ${tier === b.key ? 'font-bold text-ink dark:text-darkText' : 'text-muted dark:text-darkMuted'}`}
                >
                  {b.label}{' '}
                  <span style={MONO} className="text-dust dark:text-darkMuted">{b.range}</span>
                </p>
              ))}
            </div>
          </div>

          {/* Three scores, three surfaces: a measured value, a provisional one
              and the priority the queue is actually ordered by. */}
          <div className="mt-5 grid grid-cols-3 gap-2.5">
            {stats.map((s) => (
              <div
                key={s.label}
                className={`relative overflow-hidden rounded-xl border px-3.5 pb-2.5 pt-3.5 ${
                  s.accent
                    ? 'border-accent/35 bg-accent/[0.07]'
                    : 'border-line/70 bg-white/70 dark:border-darkBorder/70 dark:bg-darkCard/50'
                }`}
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px]"
                  style={{ background: s.accent ? 'var(--accent)' : hex }}
                />
                <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">{s.label}</p>
                <p
                  style={MONO}
                  className={`mt-1.5 text-[19px] font-black leading-none tabular-nums ${
                    s.accent ? 'text-accent' : 'text-ink dark:text-darkText'
                  }`}
                >
                  {s.value != null ? fmtScore(s.value) : '—'}
                </p>
                <p className="mt-1 text-[9.5px] text-dust dark:text-darkMuted">{s.caption}</p>
              </div>
            ))}
          </div>

          <p className="mt-4 flex items-start gap-2 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
            <span aria-hidden="true" className="mt-[4px] h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: hex }} />
            <span>
              Thresholds band the risk;{' '}
              <strong className="font-semibold text-ink dark:text-darkText">
                High additionally requires a biomarker result on file
              </strong>{' '}
              — a cognitive score alone caps at Medium, since cognition is the assessment the referral was already
              based on.
            </span>
          </p>
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
  // stage 1 (cognitive / clinical) + stage 0 (always-known baseline)
  mmse: 1,
  mmse_change: 1,
  adas_cog_13: 1,
  // faq_total: 1,  REMOVED — label leakage
  n_visits: 1,
  study_years: 1,
  // stage 2 blood
  ptau181: 2,
  ptau217: 2,
  abeta4240: 2,
  nfl: 2,
  gfap: 2,
  // stage 3 MRI
  hippocampal_volume: 3,
  hippocampal_icv_ratio: 3,
  // stage 4 PET
  amyloid_positive: 4,
  tau_positive: 4,
  centiloids: 4,
  tau_meta_temporal: 4,
  // never "pending" -- demographics/genetics are known at intake
  age: 0,
  education_years: 0,
  apoe_e4: 0,
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

  // The decomposition, summarised: how much of the score is being pushed up
  // versus pulled down over all inputs. Every row below is a slice of this bar.
  const posSum = (patient.factors || []).filter((f) => f.effect > 0).reduce((s, f) => s + f.effect, 0);
  const negSum = (patient.factors || []).filter((f) => f.effect < 0).reduce((s, f) => s + Math.abs(f.effect), 0);
  const posShare = posSum + negSum > 0 ? (posSum / (posSum + negSum)) * 100 : 50;
  const strongest = (patient.factors || []).length
    ? [...patient.factors].sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect))[0]
    : null;

  const factorRow = (f, i, dim = false, estimated = false) => {
    const up = f.effect > 0;
    const width = Math.max(6, (Math.abs(f.effect) / maxAbs) * 100);
    const hex = up ? TIER_HEX.high : TIER_HEX.low;
    const isBinary = f.feature === 'amyloid_positive' || f.feature === 'tau_positive';
    const isApoe = f.feature === 'apoe_e4';
    return (
      <div key={`${f.feature}-${i}`} className="space-y-1.5" style={{ opacity: dim ? 0.7 : 1 }}>
        <div className="flex items-baseline justify-between gap-4">
          <span className="truncate text-xs font-medium text-ink dark:text-darkText" title={f.feature}>
            {f.text}
            {f.value != null && (
              <span style={MONO} className="ml-1.5 text-[11px] text-muted dark:text-darkMuted">
                · {isBinary
                  ? f.value === 1 ? 'Positive' : 'Negative'
                  : isApoe
                    ? f.value === 1 ? 'ε4 carrier' : 'non-carrier'
                    : f.value}
              </span>
            )}
            {dim && (
              <span className="ml-1.5 text-[9px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
                {estimated ? 'predicted stage' : 'model default'}
              </span>
            )}
          </span>
          <span className="shrink-0 text-[11px] font-bold tabular-nums" style={{ ...MONO, color: hex }}>
            {up ? '+' : '−'}{Math.abs(f.effect).toFixed(2)}
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
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
        SHAP contribution of every model input, grouped by pipeline stage. Missing stages show
        a model estimate separately; real results replace estimates and re-score the model live.
      </p>

      <div className="mt-4 rounded-xl border border-line/70 bg-white/70 px-4 py-3.5 dark:border-darkBorder/70 dark:bg-darkCard/50">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted dark:text-darkMuted">
            Net contribution
          </p>
          <p style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
            {(patient.factors || []).length} factors{strongest ? ` · ${strongest.text}` : ''}
          </p>
        </div>
        <div className="mt-2.5 flex h-3.5 w-full overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
          <span
            className="h-full transition-all"
            style={{ width: `${posShare}%`, backgroundColor: TIER_HEX.high }}
          />
          <span className="h-full flex-1" style={{ backgroundColor: TIER_HEX.low }} />
        </div>
        <div className="mt-2 flex items-center justify-between gap-3 text-[10.5px] font-semibold">
          <span className="flex items-center gap-1.5" style={{ color: TIER_HEX.high }}>
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_HEX.high }} />
            +{posSum.toFixed(2)} raising priority
          </span>
          <span className="flex items-center gap-1.5" style={{ color: TIER_HEX.low }}>
            −{negSum.toFixed(2)} lowering priority
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_HEX.low }} />
          </span>
        </div>
      </div>

      <div className="mt-4 space-y-4">
        {STAGE_GROUPS.map(({ stage, label, slot }) => {
          const slotData = slot ? patient[slot] : null;
          const hasResults = Boolean(slotData && slotData.status === 'completed');
          const isOrdered = Boolean(slotData);
          const hasEstimate = Boolean(slot && patient.estimated_values?.[slot]);
          // Cognition group folds in demographics/baseline (stage 0) as context
          const rows = stage === 1 ? [...byStage(1), ...byStage(0)] : byStage(stage);

          const stageHex = STAGE_FILLS[stage - 1];
          return (
            <div
              key={label}
              className="relative overflow-hidden rounded-2xl border border-line/70 bg-[#FAF9F5] py-3.5 pl-5 pr-4 dark:border-darkBorder/70 dark:bg-darkCardHover"
            >
              {/* The stage's own colour runs down the leading edge, so the
                  group reads as the same stage as its tile in the pathway. */}
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ backgroundColor: hasResults ? stageHex : `${stageHex}55` }}
              />
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-ink dark:text-darkText">
                  <span
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-black text-white"
                    style={{ backgroundColor: hasResults ? stageHex : '#C7C4BC' }}
                  >
                    {stage}
                  </span>
                  {label}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                    {rows.length} {rows.length === 1 ? 'factor' : 'factors'}
                  </span>
                  {!hasResults && slot && (
                    <span className={`text-[9.5px] font-bold uppercase tracking-[0.12em] ${hasEstimate ? 'text-accent' : 'text-dust dark:text-darkMuted'}`}>
                      {hasEstimate ? 'predicted · not measured' : isOrdered ? 'add real result' : 'not measured'}
                    </span>
                  )}
                </span>
              </div>

              {rows.length === 0 ? (
                <p className="mt-2 text-[11px] text-muted dark:text-darkMuted">
                  {hasResults
                    ? 'No contribution above threshold from this stage.'
                    : 'Order this test to see its influence on the risk score.'}
                </p>
              ) : (
                <div className="mt-3 space-y-3">{rows.map((f, i) => factorRow(f, i, stage > 1 && !hasResults, hasEstimate))}</div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
        Rows tagged <span className="font-semibold">predicted stage</span> are model estimates, not measured
        clinical results. They support priority ranking only. Add the real result when available; its measured
        contribution then replaces the estimate and the model re-scores.
      </p>
    </section>
  );
}

const SLOT_FOR_STEP = { 2: 'blood', 3: 'imaging', 4: 'pet' };

/*
 * The pathway as four stage tiles rather than four dots on a line.
 *
 * A dot can say only "gone by" or "not yet"; the tile can also say what is
 * actually on file for that stage — the outcome if it is measured, or the fact
 * that the test is ordered and still waiting. Each stage carries its own colour
 * from the shared stage palette, so the same measurement reads the same here as
 * it does on the worklist and the cohort chart.
 */
function PipelineSection({ patient }) {
  const current = patient.stage;
  const cog = patient.cognitive;

  return (
    <section>
      <SectionLabel right={<span className="text-[11px] text-muted dark:text-darkMuted">Cognitive → Blood → MRI → PET</span>}>
        Diagnostic Triage Pathway
      </SectionLabel>

      <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
        {STAGES_SHORT.map((label, i) => {
          const step = i + 1;
          const slot = SLOT_FOR_STEP[step];
          const data = slot ? patient[slot] : null;
          const measured = data?.status === 'completed';
          const done = step < current || measured;
          const active = !done && step === current;
          const hex = STAGE_FILLS[i];
          const outcome = data?.outcome ? OUTCOME_META[data.outcome] : null;
          const detail =
            step === 1
              ? `Cognitive battery${cog?.latest != null ? ` · MMSE ${cog.latest}` : ''}`
              : measured
                ? outcome?.label ?? 'Result on file'
                : active
                  ? 'Ordered — awaiting result'
                  : 'Not ordered yet';

          return (
            <div
              key={label}
              className={`relative overflow-hidden rounded-xl border px-3.5 pb-3 pt-3.5 transition ${
                active
                  ? 'border-accent/45 bg-accent/[0.07] ring-1 ring-accent/25'
                  : done
                    ? 'border-tierLow/30 bg-tierLow/[0.05]'
                    : 'border-line/70 bg-white/60 dark:border-darkBorder/70 dark:bg-darkCard/40'
              }`}
            >
              {/* Inline gradients cannot carry a `dark:` variant, so the
                  unmeasured state uses a token class instead — a light-grey rule
                  on a dark card is the one thing that looks broken in the dark. */}
              <span
                aria-hidden="true"
                className={`absolute inset-x-0 top-0 h-[3px] ${done || active ? '' : 'bg-line dark:bg-darkBorder'}`}
                style={done || active ? { background: `linear-gradient(90deg, ${hex}, transparent)` } : undefined}
              />

              <div className="flex items-center justify-between gap-2">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-black ${
                    done || active ? '' : 'bg-tint text-muted dark:bg-darkBorder dark:text-darkMuted'
                  }`}
                  style={
                    done
                      ? { backgroundColor: TIER_HEX.low, color: '#fff' }
                      : active
                        ? { backgroundColor: 'var(--accent)', color: '#fff', boxShadow: '0 0 0 4px var(--accent-ring)' }
                        : undefined
                  }
                >
                  {done ? (
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  ) : (
                    step
                  )}
                </span>
                <span
                  className={`text-[9px] font-bold uppercase tracking-[0.14em] ${
                    done || active ? '' : 'text-dust dark:text-darkMuted'
                  }`}
                  style={done ? { color: TIER_HEX.low } : active ? { color: 'var(--accent)' } : undefined}
                >
                  {done ? 'On file' : active ? 'Current' : `Step ${step}`}
                </span>
              </div>

              <p className="mt-2.5 text-[12.5px] font-bold tracking-tight text-ink dark:text-darkText">{label}</p>
              <p className="mt-0.5 text-[10.5px] leading-snug" style={outcome ? { color: outcome.hex } : undefined}>
                <span className={outcome ? 'font-semibold' : 'text-muted dark:text-darkMuted'}>{detail}</span>
              </p>
            </div>
          );
        })}
      </div>

      <div className="mt-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 rounded-xl border border-line/70 bg-tint/40 px-4 py-2.5 text-[11.5px] dark:border-darkBorder/70 dark:bg-darkBorder/25">
        <span className="text-muted dark:text-darkMuted">
          Current stage:{' '}
          <strong className="font-bold text-ink dark:text-darkText">{patient.stage_name}</strong>
        </span>
        <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
          stage {current} of 4
        </span>
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
      {/* A finished pathway is good news, so the box says so in green instead
          of staying the same neutral surface as an open action. */}
      <div
        className={`mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-4 rounded-2xl border px-6 py-5 transition ${
          !action
            ? 'border-tierLow/30 bg-tierLow/[0.06]'
            : 'border-line bg-[#FAF9F5] dark:border-darkBorder dark:bg-darkBorderSubtle'
        }`}
      >
        {!action ? (
          <div className="flex items-center gap-3">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-full text-white ring-4 ring-tierLow/20"
              style={{ backgroundColor: TIER_HEX.low }}
            >
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
            {/* The page's primary commit. When the gate is closed it turns into
                a dashed "not yet" control rather than a greyed-out block, so a
                blocked state reads as a rule rather than as a dead button. */}
            <button
              onClick={() => onAdvance(false)}
              disabled={!advanceable || busy}
              className={`group inline-flex items-center gap-2.5 rounded-xl px-5 py-2.5 text-xs font-bold transition duration-200 active:scale-[0.98] ${
                advanceable && !busy
                  ? 'bg-gradient-to-b from-accent to-accentHover text-white shadow-[0_10px_24px_-12px_var(--accent-glow-max)] ring-1 ring-inset ring-white/15 hover:shadow-[0_14px_28px_-10px_var(--accent-glow-95)]'
                  : 'cursor-not-allowed border border-dashed border-line bg-tint/60 text-muted dark:border-darkBorder dark:bg-darkBorder/40 dark:text-darkMuted'
              }`}
            >
              {busy ? 'Processing…' : action.button}
              {!busy && (
                <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
              )}
            </button>
          </>
        )}
      </div>

      {action && !advanceable && !overrideOpen && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted dark:text-darkMuted">
          <span>The rule engine recommends routine screening for this priority tier.</span>
          <button
            onClick={startOverride}
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-accent/50 bg-accent/[0.04] px-2.5 py-1 text-[11px] font-semibold text-accent transition duration-200 hover:bg-accent/10"
          >
            <ShieldAlert className="h-3.5 w-3.5" />
            Clinician override — order the advanced test anyway
          </button>
        </div>
      )}

      {overrideOpen && (
        <div className="mt-4 animate-scale-in space-y-3 rounded-2xl border border-accent/40 bg-accent/[0.04] p-4 ring-1 ring-accent/10">
          <div className="flex items-center gap-2 text-xs font-bold text-accent">
            <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-accent/10">
              <ShieldCheck className="h-3.5 w-3.5" />
            </span>
            Clinician Escalation Override
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
              className="h-9 min-w-0 flex-1 rounded-xl border border-line bg-white px-3.5 text-xs text-ink outline-none transition placeholder:text-muted/80 focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
            />
            <Btn tone="primary" icon={Check} onClick={confirmOverride} disabled={busy}>
              {busy ? 'Saving…' : 'Confirm & Advance'}
            </Btn>
            <Btn tone="quiet" onClick={() => setOverrideOpen(false)} disabled={busy}>
              Cancel
            </Btn>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-3 inline-flex items-center gap-2 rounded-xl border border-tierHigh/30 bg-tierHigh/10 px-4 py-2.5 text-xs font-semibold text-tierHigh">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </p>
      )}
    </section>
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
  // Results measured ahead of the ordered pathway (real-cohort ordering gaps):
  // the stage stops at the first missing test, so these are "already on file".
  const aheadOfPathway = ['blood', 'imaging', 'pet'].filter(
    (slot) => patient[slot]?.status === 'completed' && SLOT_STAGE[slot] > (patient.stage ?? 1)
  );
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

      {/* The baseline facts as tiles rather than a definition list. They are
          five short machine values, and a grid lets the eye take them in as a
          block instead of re-reading a label/value pair five times. */}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        {[
          {
            k: 'Age / sex',
            v: patient.age != null ? `${patient.age}y · ${patient.sex === 'M' ? 'Male' : 'Female'}` : '—',
          },
          {
            k: 'Education',
            v: patient.education_years != null ? `${patient.education_years} years` : '—',
          },
          {
            k: 'Cognitive trajectory',
            v: cog
              ? `${cog.scale} ${cog.latest ?? '—'}${decline > 0 ? ` (−${decline} in ${cog.months ?? 6}m)` : ' (stable)'}`
              : '—',
          },
          { k: 'Family history', v: patient.family_history ? 'Positive (+)' : 'Negative (−)' },
        ].map((f) => (
          <div
            key={f.k}
            className="rounded-xl border border-line/70 bg-white/70 px-3 py-2.5 dark:border-darkBorder/70 dark:bg-darkCard/50"
          >
            <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">{f.k}</p>
            <p style={MONO} className="mt-1 text-[12.5px] font-semibold leading-snug text-ink dark:text-darkText">
              {f.v}
            </p>
          </div>
        ))}
        <div className="col-span-2 rounded-xl border border-line/70 bg-white/70 px-3 py-2.5 dark:border-darkBorder/70 dark:bg-darkCard/50">
          <p className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
            Comorbidity flags
          </p>
          <p className="mt-1 text-[12px] font-medium leading-snug text-ink dark:text-darkText">
            {patient.comorbidities?.length ? patient.comorbidities.join(' · ') : 'None documented'}
          </p>
        </div>
      </div>

      <div className="mt-6 border-t border-line dark:border-darkBorder pt-5">
        <div className="flex items-baseline justify-between gap-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted dark:text-darkMuted">
            Diagnostic tests
          </p>
          <p style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
            {['blood', 'imaging', 'pet'].filter((s) => patient[s]?.status === 'completed').length} of 3 on file
          </p>
        </div>

        {/* Real cohorts arrive with ordering gaps: a measured result can sit
            ahead of the ordered pathway (an ADNI subject with an MRI and no
            plasma panel). Say so explicitly, so "Stage 1 · MRI completed"
            reads as the truth it is rather than looking self-contradictory. */}
        {aheadOfPathway.length > 0 && (
          <p className="mt-3 rounded-lg border border-line/70 dark:border-darkBorder/70 bg-tint/50 dark:bg-darkBorder/30 p-2.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
            <strong className="text-ink dark:text-darkText">
              {aheadOfPathway.map((s) => SLOT_LABEL[s]).join(' + ')} already on file
            </strong>{' '}
            — measured outside the ordered workup, so the stage still reflects the pathway
            (cognition → blood → MRI → PET).
            {` `}The model sees it only once the pathway reaches its stage, so ordering the
            missing test below is what brings it in.
          </p>
        )}
        <div className="mt-3 space-y-3">
          {['blood', 'imaging', 'pet'].map((slot) => {
            const value = patient[slot];
            const estimate = patient.estimated_values?.[slot] || null;
            const stageAt = SLOT_STAGE[slot];
            const meta = value?.outcome ? OUTCOME_META[value.outcome] : null;
            const awaitingResult = value?.status === 'pending' || value?.status === 'ordered';
            const done = value?.status === 'completed';
            const dotHex = meta ? meta.hex : awaitingResult ? TIER_HEX.medium : '#C7C4BC';
            const statusLabel = done
              ? meta?.label ?? 'Result on file'
              : awaitingResult
                ? value?.status === 'ordered'
                  ? 'Ordered'
                  : 'Pending'
                : 'Not ordered';

            return (
              /* One panel per test, banded down its leading edge by the state
                 of that result: green and red for measured outcomes, amber for
                 ordered-and-waiting, grey for never ordered. */
              <div
                key={slot}
                className="relative overflow-hidden rounded-2xl border border-line/70 bg-white/70 dark:border-darkBorder/70 dark:bg-darkCard/50"
              >
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-[3px]"
                  style={{ backgroundColor: dotHex }}
                />

                <div className="flex items-center justify-between gap-3 border-b border-line/60 px-4 py-2.5 dark:border-darkBorder/60">
                  <span className="flex items-center gap-2 text-[11.5px] font-bold tracking-tight text-ink dark:text-darkText">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: dotHex }} />
                    {SLOT_LABEL[slot]}
                  </span>
                  <span
                    className="shrink-0 rounded-md px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-[0.1em]"
                    style={{ color: dotHex, backgroundColor: `${dotHex}18` }}
                  >
                    {statusLabel}
                  </span>
                </div>

                <div className="px-4 py-3">
                    {!value ? (
                      <div className="space-y-3">
                        {estimate ? (
                          <div className="rounded-xl border border-dashed border-accent/40 bg-accent/[0.05] px-3 py-2.5">
                            <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-accent">
                              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                              Model estimate · not measured
                            </p>
                            <div className="mt-1.5 space-y-0.5 text-[10.5px] text-muted dark:text-darkMuted">
                              {Object.entries(estimate).map(([key, estimated]) => (
                                <div key={key} className="flex justify-between gap-3"><span>{key}</span><span style={MONO} className="font-semibold text-ink dark:text-darkText">{estimated}</span></div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <p className="rounded-xl border border-dashed border-line px-3 py-2 text-[10.5px] text-dust dark:border-darkBorder dark:text-darkMuted">
                            No model estimate available before stage {stageAt}
                          </p>
                        )}
                        <button
                          onClick={() => onAdvance?.(false)}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-[11.5px] font-semibold text-accent transition duration-200 hover:border-accent/40 hover:bg-accent/5 active:scale-[0.99] dark:border-darkBorder dark:bg-darkCard"
                        >
                          <ArrowRight className="h-3.5 w-3.5" />
                          Order test / add result later
                        </button>
                      </div>
                    ) : awaitingResult ? (
                      <div className="space-y-3">
                        {estimate && (
                          <div className="rounded-xl border border-dashed border-accent/40 bg-accent/[0.05] px-3 py-2.5">
                            <p className="flex items-center gap-1.5 text-[9.5px] font-bold uppercase tracking-[0.12em] text-accent">
                              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                              Model estimate · not measured
                            </p>
                            <div className="mt-1.5 space-y-0.5 text-[10.5px] text-muted dark:text-darkMuted">
                              {Object.entries(estimate).map(([key, estimated]) => (
                                <div key={key} className="flex justify-between gap-3"><span>{key}</span><span style={MONO} className="font-semibold text-ink dark:text-darkText">{estimated}</span></div>
                              ))}
                            </div>
                          </div>
                        )}
                        <button
                          onClick={() => openForm(slot)}
                          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-accent/35 bg-accent/5 px-3 py-2 text-[11.5px] font-semibold text-accent transition duration-200 hover:bg-accent/10 active:scale-[0.99]"
                        >
                          <Plus className="h-3.5 w-3.5" />
                          Add real result
                        </button>
                      </div>
                    ) : (
                      <div>
                        {meta && (
                          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <span
                              className="rounded-md px-2 py-0.5 text-[10.5px] font-bold"
                              style={{ color: meta.hex, backgroundColor: `${meta.hex}18` }}
                            >
                              {meta.label}
                            </span>
                            {value.ordered_at && (
                              <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                                ordered {value.ordered_at.substring(5, 10)}
                              </span>
                            )}
                          </p>
                        )}
                        {value.note && (
                          <p className="mt-1.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">{value.note}</p>
                        )}
                      </div>
                    )}
                </div>

                {/* `awaitingResult`, not `pending`: in this cohort an unmeasured
                    stage is usually `ordered` (the test exists, no result yet), and
                    gating the form on `pending` left the "+ Add real result"
                    button above pointing at a form that could never render. */}
                {openSlot === slot && awaitingResult && (
                  <div className="mt-3 animate-scale-in space-y-3 rounded-2xl border border-accent/30 bg-accent/[0.035] p-4 ring-1 ring-accent/10 dark:bg-darkCardHover">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-ink dark:text-darkText">Enter {SLOT_LABEL[slot]} Result</span>
                      <button
                        onClick={() => setOpenSlot(null)}
                        aria-label="Close result form"
                        className="flex h-6 w-6 items-center justify-center rounded-lg text-muted transition duration-200 hover:bg-tint hover:text-ink dark:text-darkMuted dark:hover:bg-darkBorder dark:hover:text-darkText"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>

                    {CLINICAL_PRESETS[slot] && (
                      <div>
                        <span className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">
                          Quick clinical presets
                        </span>
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {CLINICAL_PRESETS[slot].map((preset) => (
                            <button key={preset.name} type="button" onClick={() => applyPreset(preset)} className={BTN_CHIP}>
                              {/* The flask carries the preset's own outcome, so a
                                  pathological example is red before it is read. */}
                              <FlaskConical
                                className="h-3.5 w-3.5"
                                style={{ color: OUTCOME_META[preset.outcome].hex }}
                              />
                              {preset.name}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* The outcome carries its own colour — a positive result is
                        red because it is positive, not because it is selected —
                        and the track makes the three options one choice. */}
                    <div className="flex gap-1 rounded-xl border border-line/70 bg-tint/60 p-1 dark:border-darkBorder/70 dark:bg-darkBorder/30">
                      {['normal', 'abnormal', 'inconclusive'].map((o) => {
                        const on = outcome === o;
                        const hex = OUTCOME_META[o].hex;
                        return (
                          <button
                            key={o}
                            onClick={() => setOutcome(o)}
                            className="flex-1 rounded-lg py-1.5 text-[11px] font-bold capitalize transition duration-200"
                            style={on ? { backgroundColor: hex, color: '#fff', boxShadow: `0 4px 12px -6px ${hex}` } : undefined}
                          >
                            <span className={on ? '' : 'text-muted dark:text-darkMuted'}>{o}</span>
                          </button>
                        );
                      })}
                    </div>

                    <input
                      type="text"
                      value={valuesText}
                      onChange={(e) => setValuesText(e.target.value)}
                      placeholder="Values, e.g. p-tau181: 4.8, Aβ42/40: 0.052 (optional)"
                      className="h-9 w-full rounded-xl border border-line bg-white px-3 text-xs text-ink outline-none transition placeholder:text-muted/80 focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
                    />
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Clinical lab notes (optional)"
                      className="h-9 w-full rounded-xl border border-line bg-white px-3 text-xs text-ink outline-none transition placeholder:text-muted/80 focus:border-accent focus:ring-2 focus:ring-accent/20 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
                    />

                    <div className="flex flex-wrap items-center gap-2.5">
                      <Btn tone="primary" icon={Check} onClick={save} disabled={saving}>
                        {saving ? 'Saving…' : 'Save & Update Pathway'}
                      </Btn>
                      <Btn tone="quiet" onClick={() => setOpenSlot(null)} disabled={saving}>
                        Cancel
                      </Btn>
                      {localError && (
                        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-tierHigh">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {localError}
                        </span>
                      )}
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

/*
 * The audit trail as a timeline.
 *
 * A list of timestamps with a dot next to each one says "events happened"; a
 * rule with nodes on it says which. The newest event is the only one carrying
 * the accent, because "what changed last" is the question a trail is asked.
 */
function AuditSection({ patient }) {
  const history = [...(patient.history ?? [])].reverse();
  return (
    <section>
      <SectionLabel
        right={
          <span style={MONO} className="text-[11px] text-muted dark:text-darkMuted">
            {history.length} event{history.length === 1 ? '' : 's'}
          </span>
        }
      >
        Event & Reasoning Trail
      </SectionLabel>

      {history.length === 0 ? (
        <p className="mt-5 text-xs text-muted dark:text-darkMuted">No events recorded.</p>
      ) : (
        <ol className="relative mt-5 space-y-4 pl-6">
          <span
            aria-hidden="true"
            className="absolute bottom-1 left-[6px] top-1 w-px bg-gradient-to-b from-accent/60 via-line to-transparent dark:via-darkBorder"
          />
          {history.map((h, i) => (
            <li key={`${h.at}-${i}`} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-6 top-[3px] flex h-[15px] w-[15px] items-center justify-center rounded-full border-2 border-line bg-white dark:border-darkBorder dark:bg-darkCard"
                style={{
                  borderColor: i === 0 ? 'var(--accent)' : undefined,
                  boxShadow: i === 0 ? '0 0 0 3px var(--accent-ring-soft)' : undefined,
                }}
              >
                <span
                  className="h-[5px] w-[5px] rounded-full"
                  style={{ backgroundColor: i === 0 ? 'var(--accent)' : '#C7C4BC' }}
                />
              </span>
              <p
                className={`text-xs leading-relaxed ${
                  i === 0 ? 'font-semibold text-ink dark:text-darkText' : 'text-ink/85 dark:text-darkText/85'
                }`}
              >
                {h.text}
              </p>
              <p style={MONO} className="mt-1 flex items-center gap-2 text-[10px] text-muted dark:text-darkMuted">
                {h.at}
                {i === 0 && (
                  <span className="rounded-md bg-accent/10 px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.12em] text-accent">
                    latest
                  </span>
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/*
 * In-page destinations for the sticky command bar. The record is tall enough
 * (attribution, pathway, next step, measurements, audit trail) that naming its
 * parts at the top is what turns a scroll into a read.
 *
 * The `record-` prefix is load-bearing: App keeps the landing page mounted (and
 * hidden) behind an open record, and that page already owns `id="attribution"`
 * for its own jump link. Bare ids here would resolve to the hidden landing-page
 * band, so these anchors would scroll nowhere.
 */
const SECTION_ANCHORS = [
  { id: 'record-attribution', label: 'Attribution' },
  { id: 'record-pathway', label: 'Pathway' },
  { id: 'record-next-step', label: 'Next step' },
  { id: 'record-measurements', label: 'Measurements' },
  { id: 'record-audit', label: 'Audit' },
];

/*
 * A key cap. `fontFamily: inherit` because preflight hands <kbd> the monospace
 * stack, and JetBrains Mono has no arrow glyph — the hint would render as
 * fallback boxes in the one place it has to be legible.
 */
function Kbd({ children }) {
  return (
    <kbd
      style={{ fontFamily: 'inherit' }}
      className="rounded-[5px] border border-line bg-white px-1.5 py-0.5 text-[9.5px] font-bold text-muted shadow-[0_1px_0_rgba(19,21,26,0.05)] dark:border-darkBorder dark:bg-darkCard dark:text-darkMuted"
    >
      {children}
    </kbd>
  );
}

/*
 * A preset chip: the one control small enough to need its own string.
 *
 * Everything else on this page is either the shared `Btn` primitive (the two
 * commits and the two cancels) or sits inside the action track, where each
 * control states its own weight by material — flat, tinted, filled.
 */
const BTN_CHIP =
  'inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[10.5px] font-semibold text-ink transition duration-200 hover:border-accent/50 hover:bg-accent/5 hover:text-accent dark:border-darkBorder dark:bg-darkCard dark:text-darkText';

/*
 * A column of the record.
 *
 * Both columns used to be anonymous bordered `divide-y` wrappers, which left the
 * reader to infer which paper they were looking at. The header strip names each
 * dossier, carries its icon, and states the one number that column is about —
 * and the hairline gradient keeps the sections inside visibly related.
 */
function DossierCard({ icon: Icon, title, meta, tone = 'var(--accent)', children }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line/70 bg-white/70 shadow-soft dark:border-darkBorder/70 dark:bg-darkCard/60">
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${tone}, transparent)` }}
      />
      <div className="flex items-center justify-between gap-4 border-b border-line/60 bg-gradient-to-b from-tint/60 to-transparent px-6 py-3 dark:border-darkBorder/60 dark:from-darkBorder/30">
        <div className="flex items-center gap-2.5">
          <span
            className="relative flex h-7 w-7 items-center justify-center rounded-xl"
            style={{ color: tone }}
          >
            {/* A tinted fill without appending an alpha hex to the colour: `tone`
                can be a CSS variable now, which cannot take a `18` suffix. */}
            <span
              aria-hidden="true"
              className="absolute inset-0 rounded-xl"
              style={{ backgroundColor: tone, opacity: 0.12 }}
            />
            <Icon className="relative h-4 w-4" />
          </span>
          <p className="text-[12px] font-bold tracking-tight text-ink dark:text-darkText">{title}</p>
        </div>
        {meta}
      </div>
      <div className="divide-y divide-line/60 dark:divide-darkBorder/60">{children}</div>
    </div>
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
    /*
     * The skeleton is the masthead's own geometry — tile, eyebrow, identity,
     * lead, command bar — rather than three grey bars. Waiting for a record is
     * the one moment this page has no content, so the placeholder should at
     * least describe the shape of what is coming and not re-flow on arrival.
     */
    return (
      <div className="animate-pulse space-y-6">
        <div className="space-y-4">
          <div className="h-3 w-28 rounded-full bg-line/80 dark:bg-darkBorder" />
          <div className="flex items-center gap-4 border-b border-line/80 pb-6 dark:border-darkBorder/80">
            <div className="h-11 w-11 sm:h-[52px] sm:w-[52px] shrink-0 rounded-[18px] bg-line/70 dark:bg-darkBorder" />
            <div className="space-y-2.5">
              <div className="h-2.5 w-24 rounded-full bg-line/70 dark:bg-darkBorder" />
              <div className="h-7 w-44 rounded-lg bg-line/80 dark:bg-darkBorder" />
              <div className="h-3 w-72 rounded-full bg-line/60 dark:bg-darkBorder sm:w-[30rem]" />
            </div>
          </div>
        </div>
        <div className="h-9 rounded-xl bg-line/60 dark:bg-darkBorder" />
        <div className="grid items-start gap-8 lg:grid-cols-5">
          <div className="space-y-8 lg:col-span-3">
            <div className="h-56 rounded-2xl bg-line/70 dark:bg-darkBorder" />
            <div className="h-72 rounded-2xl bg-line/60 dark:bg-darkBorder" />
          </div>
          <div className="space-y-8 lg:col-span-2">
            <div className="h-96 rounded-2xl bg-line/60 dark:bg-darkBorder" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="animate-fade-up">
        <button
          onClick={onBack}
          className="group inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-muted transition hover:text-ink dark:text-darkMuted dark:hover:text-darkText"
        >
          <ArrowLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
          <span>Patient Worklist</span>
        </button>
        <div className="mx-auto max-w-md py-20 text-center">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl border border-tierHigh/25 bg-tierHigh/10 text-tierHigh">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <p className="mt-4 text-sm font-bold text-ink dark:text-darkText">This record could not be loaded</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted dark:text-darkMuted">{error}</p>
        </div>
      </div>
    );
  }

  const action = pipeline?.recommended_next ?? null;
  const advanceable = Boolean(action) && !/^(Schedule|Return)/.test(action.button);

  const tierHex = TIER_HEX[patient.risk_tier] || '#0D8282';
  const tierWord = TIER_LABEL[patient.risk_tier] ?? patient.risk_tier ?? 'Unbanded';
  const measuredPanels = ['blood', 'imaging', 'pet'].filter((slot) => patient[slot]?.status === 'completed').length;
  // Anchors are scrolled by hand rather than by `#id` hash links so the offset
  // can clear both sticky bars (the 72px app bar and this command bar) instead
  // of parking the section under them.
  const jumpToSection = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 132, behavior: 'smooth' });
  };

  return (
    /*
     * Spacing is explicit rather than `space-y-*`.
     *
     * The masthead pulls itself up into the page's own top padding (`-mt-5`):
     * the app bar is 75px of chrome already, and a masthead starting a further
     * 32px below it pushed the subject id and the first card under the fold for
     * no reason. That does not work under `space-y`: the hidden print block is
     * the container's first child, so the masthead is a *later* sibling, and the
     * `margin-top` space-y gives it simply cancels the pull-up. Explicit margins
     * on the three blocks below cannot fight each other.
     */
    <div className="animate-fade-up">
      {/*
       * Print-only record header.
       *
       * `@media print` hides every `header` element along with the app chrome,
       * and the masthead is one — so an exported consultation used to be pages
       * of attribution and audit trail with no subject anywhere on them. This is
       * the one block the export is allowed to keep. `hidden` is overridden by
       * the print rule's `display: block !important`.
       */}
      <div className="print-only hidden">
        <p style={MONO} className="text-base font-bold text-ink">
          Subject {patient.id} — NeuroPilot consultation record
        </p>
        <p className="mt-1 text-[11px] text-muted">
          {tierWord} priority · refined score {patient.score != null ? fmtScore(patient.score) : '—'} · stage{' '}
          {patient.stage} of 4 ({patient.stage_name}) · {measuredPanels} of 3 biomarker panels measured · exported{' '}
          {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
        </p>
      </div>

      {/* ================================================================ */}
      {/* Masthead — the same lockup as the worklist and the simulator      */}
      {/* ================================================================ */}
      <header className="relative -mt-5">
        {/* A soft accent wash behind the lockup. The block sat on flat paper
            with nothing behind it, which is most of why three lines of type
            read as plain; this gives the surface depth without adding a box. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -left-8 -top-5 h-36 w-[min(560px,100vw)] bg-[radial-gradient(58%_120%_at_22%_0%,var(--accent-wash-soft),transparent_72%)] dark:bg-[radial-gradient(58%_120%_at_22%_0%,var(--accent-wash-bright),transparent_72%)]"
        />

        {/* A record is reached from the queue, so the way back sits above the
            identity rather than inside it, where it used to compete with the
            subject id for the same line. */}
        <div className="relative flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <button
            onClick={onBack}
            className="group -ml-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11.5px] font-semibold text-muted transition duration-200 hover:bg-white hover:text-ink hover:shadow-soft dark:text-darkMuted dark:hover:bg-darkCard dark:hover:text-darkText"
          >
            <ArrowLeft className="h-3.5 w-3.5 transition-transform duration-200 group-hover:-translate-x-0.5" />
            <span>Patient Worklist</span>
          </button>

          {/* These are the keys App.jsx actually binds on this view. Naming them
              is what makes the queue navigable without going back for a mouse. */}
          <p className="hidden items-center gap-1.5 text-[10.5px] text-dust dark:text-darkMuted sm:flex">
            <Kbd>←</Kbd>
            <Kbd>→</Kbd>
            <span>adjacent subject</span>
            <span aria-hidden="true" className="mx-1 h-3 w-px bg-line dark:bg-darkBorder" />
            <Kbd>Esc</Kbd>
            <span>back to cohort</span>
          </p>
        </div>

        <div className="relative mt-1.5 flex flex-wrap items-end justify-between gap-x-8 gap-y-3 border-b border-line/80 pb-5 dark:border-darkBorder/80">
          <div className="flex items-center gap-4">
            {/* The tile is tinted by tier, not by the product accent: on a
                record page the first useful fact is which band this subject is
                in, and a colour the rest of the app already means something by
                says it before the sentence below does. */}
            <div
              className="relative flex h-11 w-11 sm:h-[52px] sm:w-[52px] shrink-0 items-center justify-center rounded-[18px] border"
              style={{
                borderColor: `${tierHex}40`,
                background: `linear-gradient(135deg, ${tierHex}26, ${tierHex}0A 62%, transparent)`,
              }}
              title={`${tierWord} priority`}
            >
              <IdCard className="h-[22px] w-[22px]" style={{ color: tierHex }} />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-[18px] ring-1 ring-inset ring-white/50 dark:ring-white/10"
              />
            </div>

            {/* Quoted by a full-height accent rule on its leading edge: three
                left-aligned lines with nothing holding them have no edge to
                hang from. */}
            <div className="relative pl-[18px]">
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 h-full w-px bg-gradient-to-b from-accent via-accent/35 to-transparent"
              />
              <div className="flex items-center gap-2.5">
                <span className="h-[3px] w-[3px] rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Subject record</p>
                <span aria-hidden="true" className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent" />
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                <h1
                  style={MONO}
                  className="text-[24px] font-black leading-[1.05] tracking-[-0.03em] text-ink dark:text-darkText sm:text-[36px]"
                >
                  {patient.id}
                </h1>
                <TierTag tier={patient.risk_tier} size="lg" />
              </div>

              {/* The lead sentence is the record's one-line abstract, and every
                  number in it is live off the served payload. */}
              <p className="mt-1.5 hidden max-w-[76ch] text-[13.5px] leading-relaxed text-muted sm:block dark:text-darkMuted">
                <strong style={MONO} className="text-[15px] font-black tabular-nums text-ink dark:text-darkText">
                  {patient.score != null ? fmtScore(patient.score) : '—'}
                </strong>{' '}
                predicted probability, banded{' '}
                <strong className="font-semibold text-ink dark:text-darkText">{tierWord}</strong> — now at{' '}
                <strong className="font-semibold text-ink dark:text-darkText">
                  stage {patient.stage} of 4{patient.stage_name ? ` (${patient.stage_name.toLowerCase()})` : ''}
                </strong>
                , with {measuredPanels} of 3 biomarker panels measured
                {patient.updated_at ? ` · updated ${patient.updated_at.substring(5, 16)}` : ''}.
              </p>

              {/*
               * Where the record came from.
               *
               * A chart imported from an EHR is FILED under a NeuroPilot number
               * (FHIR-0001) because an Epic-style resource id is unreadable on a
               * worklist — but renaming it must not hide it, so the source
               * system's own handle and the server it came from are shown here.
               * Absent for the cohort, which was ingested from a study dataset
               * rather than pulled from a live chart.
               */}
              {patient.external_ids?.ehr_patient_id && (
                <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10.5px] leading-relaxed text-muted dark:text-darkMuted">
                  <span aria-hidden="true" className="h-[3px] w-[3px] rounded-full bg-accent" />
                  <span>Pulled from the EHR record</span>
                  <span style={MONO} className="text-[10px] font-semibold text-ink dark:text-darkText">
                    {patient.external_ids.ehr_patient_id}
                  </span>
                  {patient.external_ids.ehr_iss && (
                    <span style={MONO} className="truncate text-dust dark:text-darkMuted">
                      {patient.external_ids.ehr_iss}
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </header>

      {/*
       * Command bar.
       *
       * Sticky, because the dossier under it is long: a reader who has scrolled
       * into the attribution table should still be able to jump to a named
       * section, step to the adjacent subject, or export the record without
       * scrolling back to the top.
       *
       * It only sticks from `xl`, and that is measured, not cautious. The app bar
       * is a single 75px row there; at 1024 it has already wrapped to 123px and
       * at 390 to 171px, so a bar pinned at a fixed offset would slide up under
       * it and disappear. Below `xl` this is an ordinary toolbar in the flow.
       */}
      <div className="no-print z-20 -mx-4 mt-5 border-b border-line/70 bg-paper/95 px-4 py-2 backdrop-blur-xl sm:-mx-6 sm:px-6 xl:sticky xl:top-[75px] dark:border-darkBorder/70 dark:bg-darkBg/95">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          {/* Pathway progress, compressed to four segments: the toolbar doubles
              as the status line, so the stage is readable from anywhere. */}
          <span
            className="flex shrink-0 items-center gap-1.5"
            role="img"
            aria-label={`Pathway stage ${patient.stage} of 4${patient.stage_name ? ` — ${patient.stage_name}` : ''}`}
          >
            {STAGES_SHORT.map((label, i) => {
              const step = i + 1;
              return (
                <span
                  key={label}
                  title={`${step}. ${label}`}
                  className="h-1.5 w-6 rounded-full transition-colors"
                  style={{
                    backgroundColor: step < patient.stage ? TIER_HEX.low : step === patient.stage ? 'var(--accent)' : '#E6E2DA',
                  }}
                />
              );
            })}
          </span>

          {/* The stage name only. "stage 4 of 4" is what the four segments
              immediately to its left already say, and the bar has one line's
              worth of width to fit three zones in. */}
          <p className="text-[11.5px] font-bold leading-none text-ink dark:text-darkText">{patient.stage_name}</p>

          <span aria-hidden="true" className="hidden h-4 w-px bg-line xl:block dark:bg-darkBorder" />

          <nav aria-label="Record sections" className="hidden items-center gap-0.5 xl:flex">
            {SECTION_ANCHORS.map((s) => (
              <button
                key={s.id}
                onClick={() => jumpToSection(s.id)}
                className="rounded-lg px-2 py-1 text-[11.5px] font-semibold text-muted transition duration-200 hover:bg-white hover:text-accent hover:shadow-[0_1px_0_rgba(19,21,26,0.04)] dark:text-darkMuted dark:hover:bg-darkCard dark:hover:text-accent"
              >
                {s.label}
              </button>
            ))}
          </nav>

          {/*
           * One action track, not three floating buttons.
           *
           * The well is the same recessed surface the app-bar navigation uses,
           * so the record's controls read as house chrome rather than as three
           * one-offs. Inside it the three levels of the hierarchy are stated by
           * material instead of by colour alone: quiet flat controls step
           * between subjects, a tinted control opens the projection, and the
           * record's output action is the only filled thing on the bar.
           */}
          <div className="ml-auto flex items-center gap-1 rounded-2xl border border-line/70 bg-tint/70 p-1 shadow-[inset_0_1px_2px_rgba(19,21,26,0.06)] dark:border-darkBorder dark:bg-darkBorderSubtle">
            {(onPrev || onNext) && (
              <div className="flex items-center">
                {onPrev && (
                  <button
                    onClick={onPrev}
                    disabled={!hasPrev}
                    title="Previous subject (←)"
                    className="group inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[11.5px] font-semibold text-ink transition duration-200 hover:bg-white hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:shadow-none dark:text-darkText dark:hover:bg-darkCard dark:disabled:hover:bg-transparent"
                  >
                    <ChevronLeft className="h-4 w-4 transition-transform duration-200 group-hover:-translate-x-0.5" />
                    <span className="hidden lg:inline">Prev</span>
                  </button>
                )}
                {onPrev && onNext && <span aria-hidden="true" className="h-5 w-px bg-line dark:bg-darkBorder" />}
                {onNext && (
                  <button
                    onClick={onNext}
                    disabled={!hasNext}
                    title="Next subject (→)"
                    className="group inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-[11.5px] font-semibold text-ink transition duration-200 hover:bg-white hover:shadow-soft disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:shadow-none dark:text-darkText dark:hover:bg-darkCard dark:disabled:hover:bg-transparent"
                  >
                    <span className="hidden lg:inline">Next</span>
                    <ChevronRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                  </button>
                )}
              </div>
            )}

            {progression?.model_available && onOpenProgression && (
              <button
                onClick={onOpenProgression}
                aria-label="Refined risk profile"
                title="Open the refined risk profile — observed vs projected trajectory"
                className="inline-flex h-9 items-center gap-2 rounded-xl border border-accent/25 bg-accent/10 px-2.5 text-[11.5px] font-semibold text-accent transition duration-200 hover:bg-accent/20 active:scale-[0.98]"
              >
                <TrendingUp className="h-4 w-4" />
                <span className="hidden lg:inline">Refined Risk Profile</span>
              </button>
            )}

            <button
              onClick={() => window.print()}
              aria-label="Export consultation report"
              title="Export consultation report (print / PDF)"
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-gradient-to-b from-accent to-accentHover px-3 text-[11.5px] font-bold text-white shadow-[0_8px_18px_-10px_var(--accent-glow-95)] ring-1 ring-inset ring-white/15 transition duration-200 hover:shadow-[0_10px_22px_-8px_var(--accent-glow-90)] active:scale-[0.98]"
            >
              <Printer className="h-4 w-4" />
              <span className="hidden lg:inline">Export record</span>
            </button>
          </div>
        </div>
      </div>

      <div className="mt-5 grid items-start gap-8 lg:grid-cols-5">
        <div className="space-y-8 lg:col-span-3">
          <HeroPanel tier={patient.risk_tier}>
            <ScoreSection patient={patient} />
          </HeroPanel>

          {/* Unified Clinical Decision Dossier */}
          <DossierCard
            icon={Activity}
            title="Decision dossier"
            tone="var(--accent)"
            meta={
              <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
                stage {patient.stage} of 4
              </span>
            }
          >
            <div id="record-attribution" className="p-4 sm:p-6">
              <ReasoningSection patient={patient} />
            </div>
            <div id="record-pathway" className="p-4 sm:p-6">
              <PipelineSection patient={patient} />
            </div>
            <div id="record-next-step" className="p-4 sm:p-6">
              <ActionSection
                action={action}
                advanceable={advanceable}
                onAdvance={onAdvance}
                busy={advanceBusy}
                error={advanceError}
              />
            </div>
          </DossierCard>
        </div>

        <div className="space-y-8 lg:col-span-2">
          {/* Unified Biomarker Profile & Audit Trail */}
          <DossierCard
            icon={ClipboardList}
            title="Biomarker profile & audit"
            tone={TIER_HEX[patient.risk_tier] || 'var(--accent)'}
            meta={
              <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
                {measuredPanels} of 3 on file
              </span>
            }
          >
            <div id="record-measurements" className="p-4 sm:p-6">
              <ProfileSection patient={patient} onRecordResult={onRecordResult} />
            </div>
            <div id="record-audit" className="p-4 sm:p-6">
              <AuditSection patient={patient} />
            </div>
          </DossierCard>
        </div>
      </div>
    </div>
  );
}