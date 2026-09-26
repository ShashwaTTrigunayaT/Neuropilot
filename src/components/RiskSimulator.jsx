import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  ChevronRight,
  FlaskConical,
  Loader2,
  Play,
  PlusCircle,
  RotateCcw,
  ScanLine,
  SlidersHorizontal,
} from 'lucide-react';
import { api } from '../api.js';
import { fmtPercent } from '../lib.js';
import TierTag from './TierTag.jsx';
import {
  HeroPanel,
  MONO,
  PANEL,
  RiskGauge,
  SectionLabel,
  STAGE_FILLS,
  STAGE_STRIP_GRID,
  TIER_HEX,
} from './widgets.jsx';

/* ------------------------------------------------------------------ */
/*  The 15 features the served ADNI model actually uses (FAQ removed).  */
/*  Blood / MRI / PET inputs are only sent when the corresponding      */
/*  stage is toggled "measured" — otherwise null, so the score shows    */
/*  the model's real behaviour on an un-ordered test.                  */
/* ------------------------------------------------------------------ */

const FACTOR_META = {
  age: { stage: 'Demographic', label: 'Age' },
  sex: { stage: 'Demographic', label: 'Sex' },
  education_years: { stage: 'Demographic', label: 'Education' },
  apoe_e4: { stage: 'Demographic', label: 'APOE ε4' },
  mmse: { stage: 'Cognitive', label: 'MMSE (latest)' },
  mmse_change: { stage: 'Cognitive', label: 'MMSE change' },
  adas_cog_13: { stage: 'Cognitive', label: 'ADAS-Cog 13' },
  // faq_total: REMOVED (label leakage — part of ADNI diagnostic algorithm)
  ptau217: { stage: 'Blood', label: 'p-tau217' },
  abeta4240: { stage: 'Blood', label: 'Aβ42/40' },
  nfl: { stage: 'Blood', label: 'NfL' },
  gfap: { stage: 'Blood', label: 'GFAP' },
  hippocampal_volume: { stage: 'MRI', label: 'Hippocampal volume' },
  hippocampal_icv_ratio: { stage: 'MRI', label: 'Hippocampus / ICV' },
  centiloids: { stage: 'PET', label: 'Amyloid PET (Centiloids)' },
  tau_meta_temporal: { stage: 'PET', label: 'Tau PET (SUVR)' },
};

// Feature defaults mirror the real ADNI cohort medians (ingest_adni.py), so a
// simulated patient starts from a realistic profile rather than a guess.
const COHORT_MEDIAN = {
  age: 73, sex: 'F', education_years: 16,
  mmse: 28, mmse_change: 0, adas_cog_13: 13.7,
  // faq_total: REMOVED
  ptau217: 0.185, abeta4240: 0.083, nfl: 15.2, gfap: 127,
  hippocampal_volume: 3.5, icv: 1520,
  centiloids: 14, tau_meta_temporal: 1.21,
};

const STAGE_COLORS = {
  Cognitive: '#0D8282',
  Blood: '#3B82F6',
  MRI: '#8B5CF6',
  PET: '#EC4899',
  Demographic: '#6E7175',
};

/*
 * The four stages, as the workbench's own pathway.
 *
 * The page used to make the reader scroll four panels to find out which tests
 * are on file — the single most important fact about a simulated subject, and
 * the one the toggles change. This states it at the top, in the order and the
 * colours the rest of the app uses, and names the value the model is actually
 * reading from each stage rather than just "on".
 *
 * It is also where staging is CONTROLLED. The toggles used to be repeated on
 * every section header, which meant two controls for one piece of state and a
 * reader who had to know which one was authoritative; here the pathway owns it,
 * and each section below states its own status without offering a second switch.
 */
const STAGE_STRIP = [
  {
    n: 1,
    key: 'cognitive',
    name: 'Cognition',
    always: true,
    read: (f) => `MMSE ${f.mmse}/30 · ADAS-Cog ${Number(f.adas_cog_13).toFixed(1)}`,
  },
  {
    n: 2,
    key: 'blood',
    name: 'Blood panel',
    read: (f) => `p-tau217 ${Number(f.ptau217).toFixed(3)} · Aβ42/40 ${Number(f.abeta4240).toFixed(3)}`,
  },
  {
    n: 3,
    key: 'mri',
    name: 'MRI volumetrics',
    read: (f) =>
      `Hippocampus ${Number(f.hippocampal_volume).toFixed(2)} cm³ · ratio ${(f.hippocampal_volume / f.icv).toFixed(5)}`,
  },
  {
    n: 4,
    key: 'pet',
    name: 'PET imaging',
    read: (f) =>
      `Centiloids ${Number(f.centiloids).toFixed(1)} · Tau ${Number(f.tau_meta_temporal).toFixed(3)} SUVR`,
  },
];

function formatFactorValue(f) {
  const v = f.value;
  if (v === null || v === undefined) return 'not on file';
  switch (f.feature) {
    case 'sex':
      return v === 1 ? 'Male' : 'Female';
    case 'apoe_e4':
      return v === 1 ? 'ε4 carrier' : 'non-carrier';
    case 'age':
    case 'education_years':
      return `${Math.round(v)} yrs`;
    case 'mmse':
      return `${Math.round(v)}/30`;
    case 'mmse_change':
      return `${v > 0 ? '+' : ''}${v} pts`;
    case 'adas_cog_13':
      return `${Number(v).toFixed(1)} pts`;
    // faq_total: REMOVED
    case 'ptau217':
      return `${Number(v).toFixed(3)} pg/mL`;
    case 'nfl':
    case 'gfap':
      return `${Number(v).toFixed(1)} pg/mL`;
    case 'abeta4240':
      return Number(v).toFixed(3);
    case 'hippocampal_volume':
      return `${Number(v).toFixed(2)} cm³`;
    case 'hippocampal_icv_ratio':
      return Number(v).toFixed(5);
    case 'centiloids':
      return `${Number(v).toFixed(1)} CL`;
    case 'tau_meta_temporal':
      return `${Number(v).toFixed(3)} SUVR`;
    default:
      return typeof v === 'number' ? v.toFixed(2) : String(v);
  }
}

const PRESETS = [
  {
    name: 'High Risk (Suspected AD)',
    desc: 'Rapid decline, advanced amyloid + tau burden, severe atrophy',
    features: {
      age: 78,
      sex: 'F',
      education_years: 12,
      mmse: 21,
      mmse_change: -4,
      adas_cog_13: 30,
      // faq_total: REMOVED (label leakage)
      apoe_e4: true,
      ptau217: 0.75,
      abeta4240: 0.058,
      nfl: 38,
      gfap: 320,
      hippocampal_volume: 2.05,
      icv: 1420,
      centiloids: 95,
      tau_meta_temporal: 1.72,
    },
    stages: { blood: true, mri: true, pet: true },
  },
  {
    name: 'Borderline (MCI Watch)',
    desc: 'Mild decline, borderline plasma panel, MRI/PET not yet ordered',
    features: {
      age: 72,
      sex: 'M',
      education_years: 16,
      mmse: 26,
      mmse_change: -1,
      adas_cog_13: 14,
      // faq_total: REMOVED (label leakage)
      apoe_e4: true,
      ptau217: 0.28,
      abeta4240: 0.078,
      nfl: 26,
      gfap: 230,
      hippocampal_volume: 2.45,
      icv: 1580,
      centiloids: 30,
      tau_meta_temporal: 1.28,
    },
    stages: { blood: true, mri: false, pet: false },
  },
  {
    name: 'Low Risk (Healthy Aging)',
    desc: 'Normal cognition, clean plasma panel, preserved volumes',
    features: {
      age: 67,
      sex: 'F',
      education_years: 18,
      mmse: 29,
      mmse_change: 0,
      adas_cog_13: 5,
      // faq_total: REMOVED (label leakage)
      apoe_e4: false,
      ptau217: 0.09,
      abeta4240: 0.105,
      nfl: 11,
      gfap: 95,
      hippocampal_volume: 3.75,
      icv: 1400,
      centiloids: -5,
      tau_meta_temporal: 1.1,
    },
    stages: { blood: true, mri: true, pet: false },
  },
];

function featuresFromPatient(p) {
  const cog = p.cognitive || {};
  const blood = p.blood || {};
  const imaging = p.imaging || {};
  const pet = p.pet || {};
  const latest = cog.latest ?? COHORT_MEDIAN.mmse;
  const prior = cog.prior ?? latest;
  return {
    features: {
      age: p.age || COHORT_MEDIAN.age,
      sex: p.sex || COHORT_MEDIAN.sex,
      education_years: p.education_years ?? COHORT_MEDIAN.education_years,
      mmse: latest,
      mmse_change: Math.round((latest - prior) * 10) / 10,
      adas_cog_13: p.adas_cog_13 ?? COHORT_MEDIAN.adas_cog_13,
      // faq_total: REMOVED (label leakage)
      apoe_e4: p.apoe_e4 === true,
      ptau217: blood.pTau217 ?? COHORT_MEDIAN.ptau217,
      abeta4240: blood.abeta4240 ?? COHORT_MEDIAN.abeta4240,
      nfl: blood.nfl ?? COHORT_MEDIAN.nfl,
      gfap: blood.gfap ?? COHORT_MEDIAN.gfap,
      hippocampal_volume: imaging.hippocampalVolumeCm3 ?? COHORT_MEDIAN.hippocampal_volume,
      icv: imaging.icvCm3 ?? COHORT_MEDIAN.icv,
      centiloids: pet.centiloids ?? COHORT_MEDIAN.centiloids,
      tau_meta_temporal: pet.tauMetaTemporalSuvr ?? COHORT_MEDIAN.tau_meta_temporal,
    },
    stages: {
      blood: blood.status === 'completed',
      mri: imaging.status === 'completed',
      pet: pet.status === 'completed',
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Controls                                                           */
/* ------------------------------------------------------------------ */

/**
 * The staging switch, used once per stage in the pathway above.
 *
 * Off is a first-class state here, not an empty input: an un-ordered test is
 * sent to the model as missing, so the button says what that means for the
 * score rather than just "off".
 */
function StageToggle({ on, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={
        on
          ? 'Results included in scoring — click to simulate "test not ordered"'
          : 'Simulates a test that has not been ordered — model falls back to its learned default'
      }
      className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] transition ${
        on ? 'text-accent' : 'text-muted dark:text-darkMuted'
      }`}
    >
      {on ? <CheckCircle2 className="h-3 w-3" /> : <PlusCircle className="h-3 w-3" />}
      {on ? 'On file' : 'Not ordered'}
    </button>
  );
}

/**
 * One measurement, with its clinical cutoff marked ON the track.
 *
 * The cutoff used to exist only as a word in the caption underneath ("0.40
 * (Cutoff)"), which meant the reader had to look at a label, then at the number,
 * then work out on which side of the cutoff they had landed. The tick removes
 * that arithmetic: it is drawn exactly where the value falls, so "is this
 * subject past the threshold" is answered by the position of the thumb.
 *
 * A disabled slider is locked, not faded — dimming is the card's job, because
 * two independent 40%s multiply into a panel nobody can read.
 */
function Slider({ label, value, display, min, max, step = 1, marks, tick, disabled, onChange }) {
  const pct = (n) => Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100));
  return (
    <div className={disabled ? 'pointer-events-none' : ''}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] font-medium text-ink dark:text-darkText">{label}</span>
        <span style={MONO} className="text-[11.5px] font-bold tabular-nums text-accent">
          {display}
        </span>
      </div>

      <div className="relative mt-2.5">
        {tick != null && (
          <span
            aria-hidden="true"
            // 16px and offset 2px: exactly the height of the track, so the mark
            // reads as a threshold ON the slider rather than a line beside it.
            className="pointer-events-none absolute top-[2px] z-20 h-4 w-px bg-tierMedium/80"
            style={{ left: `${pct(tick)}%` }}
          />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(Number(e.target.value))}
          className="relative z-10 m-0 w-full cursor-pointer accent-accent disabled:cursor-not-allowed"
        />
      </div>

      {marks && (
        <div style={MONO} className="mt-1 flex justify-between text-[10px] text-muted dark:text-darkMuted">
          {marks.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One stage of the workbench: numbered, stage-coloured, and honest about being
 * off. The spine keeps the four cards keyed to the pathway above even when the
 * header has scrolled away, and a card whose stage is not ordered is dashed and
 * dimmed as a whole — the measurements are still there to be edited, they are
 * simply not in the score.
 */
function StageCard({ n, title, icon: Icon, on, always, children }) {
  const hex = STAGE_FILLS[n - 1];
  return (
    <section
      className={`relative overflow-hidden rounded-2xl border shadow-soft ${
        on
          ? 'border-line bg-white dark:border-darkBorder dark:bg-darkCard'
          : 'border-dashed border-line/80 bg-white/60 dark:border-darkBorder/80 dark:bg-darkCard/50'
      }`}
    >
      {/* the spine: the card stays keyed to its pathway step even scrolled away */}
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-[3px]"
        style={{ background: hex, opacity: on ? 1 : 0.35 }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line/70 px-5 py-3 dark:border-darkBorder/70">
        <span
          style={{ ...MONO, color: hex, borderColor: `${hex}44`, background: `linear-gradient(135deg, ${hex}1f, ${hex}0a)` }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[11px] font-black tabular-nums"
        >
          {n}
        </span>
        <h2 className="flex items-center gap-2 text-[13.5px] font-bold tracking-[-0.01em] text-ink dark:text-darkText">
          {Icon && <Icon className="h-3.5 w-3.5" style={{ color: hex }} />}
          {title}
        </h2>
        {/*
         * Status only — the switch lives in the pathway above.
         *
         * Two controls for one state is how a page ends up disagreeing with
         * itself, and the reader has no way to know which one the model obeyed.
         */}
        <span
          className={`ml-auto text-[9.5px] font-bold uppercase tracking-[0.12em] ${
            always || on ? 'text-accent' : 'text-muted dark:text-darkMuted'
          }`}
        >
          {always ? 'always on file' : on ? 'on file' : 'not ordered'}
        </span>
      </div>
      <div className={`px-5 py-5 ${on ? '' : 'opacity-45'}`}>{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/*  Score response                                                     */
/* ------------------------------------------------------------------ */

const SPARK_W = 280;
const SPARK_H = 56;
// Fixed 0–1 domain on purpose: the tier bands only mean anything if the axis is
// the same every time, so the line is allowed to look nearly flat when the edits
// are small rather than being rescaled into excitement.
const yOf = (score) => SPARK_H - 8 - score * (SPARK_H - 20);

function ScoreSparkline({ history, height = 56, hint = true }) {
  const pts = history.slice(-24);
  if (pts.length < 2) {
    // The hint belongs in the rail, where it explains an empty plot. In the
    // dock there is no room for it — a sentence in a 96px column wrapped into
    // ten lines and inflated the floating card to half the viewport.
    if (!hint) return null;
    return (
      <p className="mt-2 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
        Move a measurement or switch a stage — the score&apos;s response is plotted here, against the
        two tier thresholds.
      </p>
    );
  }

  const step = SPARK_W / (pts.length - 1);
  const coords = pts.map((h, i) => [i * step, yOf(h.score)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      preserveAspectRatio="none"
      style={{ height }}
      className="mt-2 w-full"
      role="img"
      aria-label={`Score response across ${pts.length} edits, currently ${fmtPercent(last.score)}`}
    >
      <defs>
        <linearGradient id="simSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.26" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* the served thresholds: 0.70 High, 0.40 Medium */}
      {[0.7, 0.4].map((b) => (
        <line
          key={b}
          x1="0"
          x2={SPARK_W}
          y1={yOf(b)}
          y2={yOf(b)}
          stroke="currentColor"
          className="text-line dark:text-darkBorder"
          strokeWidth="1"
          strokeDasharray="4 5"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      <path d={`${line} L ${SPARK_W} ${SPARK_H} L 0 ${SPARK_H} Z`} fill="url(#simSparkFill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        cx={coords[coords.length - 1][0]}
        cy={coords[coords.length - 1][1]}
        r="3.2"
        fill={TIER_HEX[last.tier] || '#0D8282'}
        stroke="#fff"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/*
 * Has the result rail scrolled above the app bar?
 *
 * Sticky alone cannot answer the user's actual need here. A sticky box is
 * trapped inside its containing block, and the rail's block is the workbench
 * row — which ends as soon as the last stage card does. Below that the score
 * scrolls away with everything else, which is exactly when someone is dragging
 * the MRI and PET sliders and most wants to watch the number.
 *
 * So the rail is measured directly: once its top goes above the bar, a docked
 * copy of the readout appears and follows the page. One rect read per frame at
 * most, and the listener is passive, so it costs nothing while scrolling.
 */
function useRailDocked(ref, offset = 72) {
  const [docked, setDocked] = useState(false);

  useEffect(() => {
    let frame = 0;
    const read = () => {
      frame = 0;
      const el = ref.current;
      if (!el) return;
      setDocked(el.getBoundingClientRect().top < offset);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ref, offset]);

  return docked;
}

/*
 * The docked score.
 *
 * Deliberately not a second gauge: at this size the number, the tier and the
 * direction of travel are the whole message, and the response plot is repeated
 * small so the shape of the last edits is still readable without looking away
 * from the measurement being edited.
 *
 * It is collapsible, and the page reserves room for it (see `pb-28` on the
 * wrapper below). A floating card that cannot be dismissed and is not accounted
 * for in the layout is a card that covers whatever it happens to sit on — which
 * is exactly what the first version did to the attribution panel and the footer.
 * It is `no-print` because it is a scrolling convenience, and a printed record
 * would show the same number twice.
 */
function ScoreDock({ result, tier, delta, history, onJump }) {
  const [open, setOpen] = useState(true);

  return (
    /*
     * Aligned to the content column, not to the window: the same `mx-auto
     * max-w-6xl px-6` rail the page uses, so the card sits flush with the right
     * edge of the workbench instead of floating 24px past it at wide widths.
     */
    <div className="no-print pointer-events-none fixed inset-x-0 bottom-4 z-40">
      <div className="mx-auto flex w-full max-w-6xl justify-center px-6 sm:justify-end">
      <div className="pointer-events-auto flex items-center gap-3 rounded-2xl border border-line bg-white/95 px-3.5 py-2.5 shadow-float backdrop-blur dark:border-darkBorder dark:bg-darkCard/95">
        <span
          aria-hidden="true"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: TIER_HEX[tier] || '#0D8282' }}
        />
        <div className="leading-none">
          <p style={MONO} className="text-[17px] font-black tabular-nums text-ink dark:text-darkText">
            {fmtPercent(result.score)}
          </p>
          <p
            className="mt-1 text-[9.5px] font-bold uppercase tracking-[0.14em]"
            style={{ color: TIER_HEX[tier] || '#0D8282' }}
          >
            {tier} risk
          </p>
        </div>

        {open && (
          <>
            {delta !== null && delta !== 0 && (
              <span
                style={MONO}
                className={`text-[10.5px] font-bold tabular-nums ${
                  delta > 0 ? 'text-tierHigh' : 'text-tierLow'
                }`}
              >
                {delta > 0 ? `▲ +${delta}` : `▼ ${delta}`}
              </span>
            )}

            {history.length >= 2 && (
              <div className="hidden w-24 sm:block">
                <ScoreSparkline history={history} height={34} hint={false} />
              </div>
            )}

            <button
              type="button"
              onClick={onJump}
              className="ml-1 rounded-lg border border-line px-2.5 py-1.5 text-[10.5px] font-semibold text-muted transition hover:border-accent/40 hover:text-accent dark:border-darkBorder dark:text-darkMuted"
            >
              Full result
            </button>
          </>
        )}

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? 'Collapse the running score' : 'Expand the running score'}
          className="rounded-lg border border-line p-1.5 text-muted transition hover:border-accent/40 hover:text-accent dark:border-darkBorder dark:text-darkMuted"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : '-rotate-90'}`}
          />
        </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function RiskSimulator({ initialPatient = null, onSelectPatient }) {
  const startFrom = useCallback(
    () =>
      initialPatient
        ? featuresFromPatient(initialPatient)
        : { features: { ...PRESETS[0].features }, stages: { ...PRESETS[0].stages } },
    [initialPatient]
  );

  const [{ features, stages }, setSimState] = useState(startFrom);
  const railRef = useRef(null);

  const [scoring, setScoring] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [autoScore, setAutoScore] = useState(true);
  // Every scored vector, oldest first, so the rail can show what the last edits
  // did to the number — a workbench that only ever shows the current score
  // cannot answer "which way is this subject moving".
  const [history, setHistory] = useState([]);

  const runScore = useCallback(async (feat) => {
    setScoring(true);
    setError('');
    try {
      const f = feat.features;
      // Stage-gated exactly like the pipeline: a stage that has not been ordered
      // sends null, so XGBoost takes its native missing-value branch. The MRI
      // ratio is derived from the two measured inputs rather than asked for
      // twice (it is an exact function of them).
      const payload = {
        age: f.age,
        sex: f.sex === 'M' ? 1 : 0,
        education_years: f.education_years,
        apoe_e4: f.apoe_e4 ? 1 : 0,
        mmse: f.mmse,
        mmse_change: f.mmse_change,
        adas_cog_13: f.adas_cog_13,
        // faq_total: REMOVED (label leakage)
        ptau217: feat.stages.blood ? f.ptau217 : null,
        abeta4240: feat.stages.blood ? f.abeta4240 : null,
        nfl: feat.stages.blood ? f.nfl : null,
        gfap: feat.stages.blood ? f.gfap : null,
        hippocampal_volume: feat.stages.mri ? f.hippocampal_volume : null,
        hippocampal_icv_ratio: feat.stages.mri ? f.hippocampal_volume / f.icv : null,
        centiloids: feat.stages.pet ? f.centiloids : null,
        tau_meta_temporal: feat.stages.pet ? f.tau_meta_temporal : null,
      };
      const res = await api.scorePatient(payload);
      setResult(res);
      setHistory((h) => {
        const prev = h[h.length - 1];
        // Dragging a slider fires a score every 250ms; identical results would
        // fill the plot with a flat line of duplicates and hide the real edits.
        if (prev && Math.abs(prev.score - res.score) < 0.0005 && prev.tier === res.risk_tier) return h;
        return [...h, { score: res.score, tier: res.risk_tier }].slice(-24);
      });
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
    setHistory([]); // a new scenario, not a continuation of the last one
  };

  const reset = () => {
    setSimState(startFrom());
    setHistory([]);
  };

  const tier = result ? result.risk_tier : 'medium';

  /*
   * The drivers of this score.
   *
   * /patients/score returns the largest contributors already ranked by |SHAP|
   * (its contract, not this view's choice), so the panel does not re-sort them —
   * that would be a second opinion about an answer that already exists. What it
   * does need is the SCALE of the bars, and that was previously recomputed inside
   * the row loop: every row measured the list, on every render, for a number none
   * of them could change. It is one number, so it is computed once.
   */
  const drivers = result?.factors || [];
  const maxContribution = useMemo(
    () => Math.max(0.05, ...drivers.map((f) => Math.abs(f.contribution))),
    [drivers]
  );

  // How much of the pathway is on file, for the header's live summary: a stage
  // that has not been ordered is sent to the model as missing, so this count is
  // the honest description of the score beside it.
  const measured = 1 + ['blood', 'mri', 'pet'].filter((k) => stages[k]).length;

  // Movement since the previous scored vector, in probability points.
  const delta = useMemo(() => {
    if (history.length < 2) return null;
    const a = history[history.length - 2].score;
    const b = history[history.length - 1].score;
    return Math.round((b - a) * 1000) / 10;
  }, [history]);

  /*
   * The next step, as a stage number AND the sentence that explains it.
   *
   * Both come out of one memo on purpose: the protocol used to return only the
   * sentence, and the card that shows it then had to re-derive which stage that
   * sentence was about in order to colour itself — two copies of the same
   * branch, one of them guaranteed to drift. `stage: 0` means nothing is left to
   * order, which is also what tells the card to wear neutral grey.
   */
  const { stage: nextStage, text: protocol, label: protocolLabel } = useMemo(() => {
    if (tier === 'low') {
      return {
        stage: 0,
        label: 'No escalation',
        text: 'Stage 1 complete: Low risk. Schedule routine follow-up cognitive evaluation in 12 months.',
      };
    }
    if (!stages.blood) {
      return {
        stage: 2,
        label: 'Next step · Stage 2',
        text: 'Order Stage 2: plasma panel (p-tau217, Aβ42/40, NfL, GFAP) to confirm pathology.',
      };
    }
    if (!stages.mri) {
      return {
        stage: 3,
        label: 'Next step · Stage 3',
        text: 'Blood panel complete — order Stage 3: MRI volumetrics (hippocampal volume, ICV-normalised) to quantify neurodegeneration.',
      };
    }
    if (!stages.pet) {
      return {
        stage: 4,
        label: 'Next step · Stage 4',
        text: 'MRI complete — order Stage 4: PET (Centiloids + tau SUVR) to quantify molecular burden before specialist referral.',
      };
    }
    return {
      stage: 0,
      // "Pathway complete" and "no escalation" are different outcomes — a
      // low-risk subject has not finished a workup, they do not need one — and
      // one label for both would have claimed the wrong thing about half the
      // time.
      label: 'Pathway complete',
      text: 'Full 4-stage workup complete — refer to specialist memory clinic for diagnostic confirmation.',
    };
  }, [tier, stages]);

  // Stage number → is its measurement on file. One map, so the four cards and
  // the pathway above cannot disagree about which stages are in the score.
  const onFile = { 1: true, 2: stages.blood, 3: stages.mri, 4: stages.pet };

  const railDocked = useRailDocked(railRef);

  // Scroll the reader back to the rail when they ask for the full result — the
  // app bar is 56px tall, so the offset keeps the top of the card clear of it.
  const jumpToResult = () => {
    const el = railRef.current;
    if (!el) return;
    window.scrollTo({ top: window.scrollY + el.getBoundingClientRect().top - 96, behavior: 'smooth' });
  };

  return (
    /*
     * `pb-28` is conditional and is the other half of the docked readout: while
     * the dock is on screen the page reserves a lane for it, so the last rows of
     * the attribution panel and the footer can always be scrolled clear of it
     * instead of being permanently covered.
     */
    <div className={`animate-fade-up space-y-6 ${result && railDocked ? 'pb-28' : ''}`}>
      {/* ================================================================ */}
      {/* Masthead — same structure as the worklist                         */}
      {/* ================================================================ */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-line/80 pb-6 dark:border-darkBorder/80">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 sm:h-[52px] sm:w-[52px] items-center justify-center rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/20 to-accent/5 text-accent shadow-sm dark:from-accent/25 dark:to-accent/10">
            <SlidersHorizontal className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <span className="h-[3px] w-[3px] rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow)]" />
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">
                What-if workbench
              </p>
              <span
                aria-hidden="true"
                className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent"
              />
            </div>
            <h1 className="mt-2 text-[26px] font-black leading-[1.0] tracking-[-0.035em] text-ink dark:text-darkText sm:text-[40px]">
              Clinical Risk Simulator
            </h1>
            <p className="mt-2 hidden text-[13.5px] leading-relaxed text-muted sm:block dark:text-darkMuted">
              <strong
                style={MONO}
                className="text-[15px] font-black tabular-nums text-ink dark:text-darkText"
              >
                {measured}
              </strong>{' '}
              of 4 stages on file
              {initialPatient?.id ? (
                <>
                  {' '}
                  — seeded from subject{' '}
                  <button
                    type="button"
                    onClick={() => onSelectPatient?.(initialPatient.id)}
                    className="font-semibold text-accent underline decoration-accent/40 underline-offset-2 transition hover:decoration-accent"
                  >
                    {initialPatient.id}
                  </button>
                </>
              ) : (
                ' — a test that has not been ordered is sent to the model as missing'
              )}
              , so this score is what the pipeline would produce for this subject today.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/*
           * The auto-predict checkbox is drawn as a switch, because that is what
           * it is: a mode that keeps the score current while you drag, not a term
           * to agree to. Off, scoring happens only when Calculate is pressed.
           */}
          <button
            type="button"
            role="switch"
            aria-checked={autoScore}
            onClick={() => setAutoScore((v) => !v)}
            className="inline-flex items-center gap-2.5 rounded-xl border border-line bg-white px-3 py-2 text-[11.5px] font-semibold text-ink transition hover:border-accent/40 dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
          >
            <span
              className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition ${
                autoScore ? 'bg-accent' : 'bg-line dark:bg-darkBorder'
              }`}
            >
              <span
                className={`absolute h-3 w-3 rounded-full bg-white shadow-sm transition-all ${
                  autoScore ? 'left-[15px]' : 'left-[3px]'
                }`}
              />
            </span>
            Live scoring
          </button>

          <button
            type="button"
            onClick={reset}
            title={initialPatient ? 'Restore the subject’s own measurements' : 'Restore the default scenario'}
            className="inline-flex items-center gap-1.5 rounded-xl border border-line bg-white px-3 py-2 text-[11.5px] font-semibold text-muted transition hover:text-ink dark:border-darkBorder dark:bg-darkCard dark:text-darkMuted dark:hover:text-darkText"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Reset
          </button>

          <button
            onClick={() => runScore({ features, stages })}
            disabled={scoring}
            className="inline-flex items-center gap-2 rounded-xl border border-transparent bg-accent px-4 py-2 text-[11.5px] font-semibold text-white shadow-soft transition hover:bg-accentHover disabled:opacity-50"
          >
            {scoring ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Scoring…
              </>
            ) : (
              <>
                <Play className="h-3 w-3 fill-current" />
                Score this vector
              </>
            )}
          </button>
        </div>
      </header>

      {/* ================================================================ */}
      {/* The pathway — state and control, in stage order                   */}
      {/* ================================================================ */}
      <div>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <SectionLabel size="sm">Escalation pathway</SectionLabel>
            <p className="mt-1.5 text-[11.5px] text-muted dark:text-darkMuted">
              Cognition is always on file. Switch a later stage off to simulate a test that has not
              been ordered — the model then scores that subject with the value missing.
            </p>
          </div>
          <p style={MONO} className="text-[11px] tabular-nums text-muted dark:text-darkMuted">
            {measured} / 4 on file
          </p>
        </div>

        {/*
         * The same framed grid the stat ribbons use. `data-np-keep` is what
         * holds the frame together on a phone: the mobile theme strips card
         * chrome from non-interactive surfaces, which took this strip's
         * background with it — the 1px grid gap then showed the page instead of
         * a hairline, and the four cells read as four separate boxes.
         */}
        <div className={`mt-3 ${STAGE_STRIP_GRID}`} data-np-keep="">
          {STAGE_STRIP.map((s) => {
            const on = s.always || stages[s.key];
            const hex = STAGE_FILLS[s.n - 1];
            return (
              <div
                key={s.key}
                className="flex flex-col bg-white/85 p-4 text-left dark:bg-darkCard/85"
              >
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: hex, opacity: on ? 1 : 0.35 }}
                  />
                  <p style={MONO} className="text-[9.5px] font-bold tabular-nums tracking-[0.12em] text-muted dark:text-darkMuted">
                    0{s.n}
                  </p>
                  <p className="text-[12.5px] font-bold text-ink dark:text-darkText">{s.name}</p>
                </div>

                <p
                  style={MONO}
                  className="mt-2 text-[10.5px] leading-relaxed tabular-nums text-muted dark:text-darkMuted"
                >
                  {on ? s.read(features) : 'scored as a missing value'}
                </p>

                <div className="mt-auto pt-3">
                  {s.always ? (
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em] text-accent">
                      <CheckCircle2 className="h-3 w-3" />
                      Always on file
                    </span>
                  ) : (
                    <StageToggle on={stages[s.key]} onClick={() => toggleStage(s.key)} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Workbench (left) + live result rail (right)                       */}
      {/* ================================================================ */}
      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-7">
          {/* Scenarios */}
          <div>
            <SectionLabel size="sm">Starting scenarios</SectionLabel>
            {/*
             * One row of three at EVERY width.
             *
             * `grid-cols-3` rather than `sm:grid-cols-3` on purpose: the phone
             * theme rewrites any `sm:grid-cols-*` group to two columns, which
             * broke the three scenarios into two-plus-one and left the third
             * orphaned on its own line. Three equal choices belong on one line,
             * so they are three columns on a phone too. The descriptions are
             * already dropped on phones by the prose rule, and the Load cue is
             * shown rather than hover-gated, since a phone never hovers.
             */}
            <div className="mt-3 grid grid-cols-3 gap-2 sm:gap-3">
              {PRESETS.map((p, idx) => {
                const IconComp = idx === 0 ? AlertTriangle : idx === 1 ? Activity : CheckCircle2;
                const hex = [TIER_HEX.high, TIER_HEX.medium, TIER_HEX.low][idx];
                return (
                  <button
                    key={p.name}
                    onClick={() => applyPreset(p)}
                    className="group relative flex flex-col overflow-hidden rounded-2xl border border-line bg-white p-2.5 text-left shadow-soft transition hover:-translate-y-0.5 hover:border-accent/40 sm:p-3.5 dark:border-darkBorder dark:bg-darkCard"
                  >
                    <span
                      aria-hidden="true"
                      className="absolute inset-x-0 top-0 h-[3px]"
                      style={{ background: hex }}
                    />
                    <div className="flex items-start gap-1.5 text-[11px] font-bold leading-tight text-ink sm:text-[12px] dark:text-darkText">
                      <IconComp className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: hex }} />
                      <span className="min-w-0">{p.name}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
                      {p.desc}
                    </p>
                    <span className="mt-auto inline-flex items-center gap-1 pt-2 text-[9.5px] font-bold uppercase tracking-[0.1em] text-accent md:pt-2.5 md:text-[10px] md:opacity-0 md:transition md:group-hover:opacity-100">
                      Load
                      <ChevronRight className="h-3 w-3" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <StageCard n={1} title="Cognition & demographics" on={onFile[1]} always>
            <div className="grid gap-5 sm:grid-cols-2">
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
                <span className="block text-[11.5px] font-medium text-ink dark:text-darkText">
                  Sex
                </span>
                <div className="mt-2 flex gap-2">
                  {['F', 'M'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => updateField('sex', s)}
                      className={`flex-1 rounded-lg border py-1.5 text-[11.5px] font-semibold transition ${
                        features.sex === s
                          ? 'border-accent bg-accent text-white shadow-soft'
                          : 'border-line bg-white text-ink dark:border-darkBorder dark:bg-darkCard dark:text-darkText'
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
              <div>
                <span className="block text-[11.5px] font-medium text-ink dark:text-darkText">
                  APOE genotype (ε4 allele)
                </span>
                <div className="mt-2 flex gap-2">
                  {[
                    [false, 'non-carrier'],
                    [true, 'ε4 carrier'],
                  ].map(([val, lab]) => (
                    <button
                      key={lab}
                      type="button"
                      onClick={() => updateField('apoe_e4', val)}
                      className={`flex-1 rounded-lg border py-1.5 text-[11px] font-semibold transition ${
                        features.apoe_e4 === val
                          ? 'border-accent bg-accent text-white shadow-soft'
                          : 'border-line bg-white text-ink dark:border-darkBorder dark:bg-darkCard dark:text-darkText'
                      }`}
                    >
                      {lab}
                    </button>
                  ))}
                </div>
              </div>
              <Slider
                label="Latest MMSE"
                value={features.mmse}
                display={`${features.mmse} / 30`}
                min={10}
                max={30}
                tick={24}
                marks={['10 (severe)', '24 (cutoff)', '30 (normal)']}
                onChange={(v) => updateField('mmse', v)}
              />
              <Slider
                label="MMSE change vs baseline"
                value={features.mmse_change}
                display={`${features.mmse_change > 0 ? '+' : ''}${features.mmse_change} pts`}
                min={-8}
                max={3}
                tick={0}
                marks={['-8 (decline)', '0', '+3 (stable)']}
                onChange={(v) => updateField('mmse_change', v)}
              />
              <Slider
                label="ADAS-Cog 13"
                value={features.adas_cog_13}
                display={`${Number(features.adas_cog_13).toFixed(1)} / 85`}
                min={0}
                max={70}
                step={0.5}
                tick={13.7}
                marks={['0 (normal)', '13.7 (cohort median)', '70 (severe)']}
                onChange={(v) => updateField('adas_cog_13', v)}
              />
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
              Cognition is free to collect, so it is the only stage present for every subject — and it
              carries the largest single share of this model&apos;s attribution. A cognition-only
              score is a lead to confirm, never a conclusion.
            </p>
          </StageCard>

          <StageCard
            n={2}
            title="Blood biomarker panel"
            icon={FlaskConical}
            on={onFile[2]}
          >
            <div className="grid gap-5 sm:grid-cols-2">
              <Slider
                label="p-tau217 (plasma)"
                value={features.ptau217}
                display={`${Number(features.ptau217).toFixed(3)} pg/mL`}
                min={0.03}
                max={1.5}
                step={0.005}
                tick={0.4}
                marks={['0.09 (CN median)', '0.40 (cutoff)', '1.5 (high)']}
                disabled={!stages.blood}
                onChange={(v) => updateField('ptau217', v)}
              />
              <Slider
                label="Aβ42/40 ratio"
                value={features.abeta4240}
                display={Number(features.abeta4240).toFixed(3)}
                min={0.04}
                max={0.16}
                step={0.001}
                tick={0.075}
                marks={['0.04 (low)', '0.075 (cutoff)', '0.16 (normal)']}
                disabled={!stages.blood}
                onChange={(v) => updateField('abeta4240', v)}
              />
              <Slider
                label="NfL (neuroaxonal injury)"
                value={features.nfl}
                display={`${Number(features.nfl).toFixed(1)} pg/mL`}
                min={2}
                max={80}
                step={0.5}
                tick={24.4}
                marks={['2', '24.4 (cutoff)', '80 (high)']}
                disabled={!stages.blood}
                onChange={(v) => updateField('nfl', v)}
              />
              <Slider
                label="GFAP (astrocyte activation)"
                value={features.gfap}
                display={`${Number(features.gfap).toFixed(1)} pg/mL`}
                min={20}
                max={600}
                step={1}
                tick={217}
                marks={['20', '217 (cutoff)', '600 (high)']}
                disabled={!stages.blood}
                onChange={(v) => updateField('gfap', v)}
              />
            </div>
          </StageCard>

          <StageCard n={3} title="MRI volumetrics" icon={Brain} on={onFile[3]}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Slider
                label="Hippocampal volume (mean L/R)"
                value={features.hippocampal_volume}
                display={`${Number(features.hippocampal_volume).toFixed(2)} cm³`}
                min={1.6}
                max={4.3}
                step={0.05}
                marks={['1.6 (atrophy)', '2.5 (p5)', '4.3 (preserved)']}
                disabled={!stages.mri}
                onChange={(v) => updateField('hippocampal_volume', v)}
              />
              <Slider
                label="Intracranial volume (head-size control)"
                value={features.icv}
                display={`${Math.round(features.icv)} cm³`}
                min={1000}
                max={2000}
                step={10}
                marks={['1000', '1520 (median)', '2000']}
                disabled={!stages.mri}
                onChange={(v) => updateField('icv', v)}
              />
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
              The model reads the ratio{' '}
              <span style={MONO} className="font-semibold text-ink dark:text-darkText">
                {stages.mri ? (features.hippocampal_volume / features.icv).toFixed(5) : 'not on file'}
              </span>{' '}
              — normalising by head size removes a confound that raw volumes carry.
            </p>
          </StageCard>

          <StageCard n={4} title="PET tracer status" icon={ScanLine} on={onFile[4]}>
            <div className="grid gap-5 sm:grid-cols-2">
              <Slider
                label="Amyloid burden (Centiloids)"
                value={features.centiloids}
                display={`${Number(features.centiloids).toFixed(1)} CL`}
                min={-20}
                max={180}
                tick={24}
                marks={['-20 (none)', '24 (Aβ+ cutoff)', '180 (high)']}
                disabled={!stages.pet}
                onChange={(v) => updateField('centiloids', v)}
              />
              <Slider
                label="Tau burden (temporal meta SUVR)"
                value={features.tau_meta_temporal}
                display={`${Number(features.tau_meta_temporal).toFixed(3)} SUVR`}
                min={0.9}
                max={2.4}
                step={0.01}
                tick={1.3}
                marks={['0.9', '1.30 (cutoff)', '2.4 (high)']}
                disabled={!stages.pet}
                onChange={(v) => updateField('tau_meta_temporal', v)}
              />
            </div>
            <p className="mt-4 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
              The last and least available step: it separates amyloid deposition from tau pathology,
              and it is ordered last because by then it is the only test left that can change
              management.
            </p>
          </StageCard>
        </div>

        {/*
         * Live result rail.
         *
         * The sticky wrapper is the INNER element, not the grid item. A grid item
         * is its own containing block for sticky positioning, so putting `sticky`
         * on the item made it pin only as far as its own box could travel and then
         * scroll away — the score vanished exactly when the reader reached the
         * lower measurements. The outer item is left to stretch to the height of
         * the workbench beside it, and the inner wrapper sticks inside that height.
         */}
        <div className="lg:col-span-5">
          <div ref={railRef} className="space-y-5 lg:sticky lg:top-20">
          {error ? (
            <div className="rounded-2xl border border-tierHigh/40 bg-tierHigh/10 p-6 text-tierHigh">
              <p className="text-sm font-semibold">Inference error</p>
              <p className="mt-1 text-xs">{error}</p>
              <button
                type="button"
                onClick={() => runScore({ features, stages })}
                className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-tierHigh/40 bg-white/60 px-3 py-1.5 text-[11px] font-semibold transition hover:bg-white"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Try again
              </button>
            </div>
          ) : !result ? (
            <div className={`${PANEL} flex items-center gap-3 p-6`}>
              <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
              <p className="text-xs text-muted dark:text-darkMuted">
                Scoring the current vector…
              </p>
            </div>
          ) : (
            <>
              <HeroPanel tier={tier}>
                <div className="flex flex-col items-center text-center">
                  <RiskGauge score={result.score} tier={tier} />
                  <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                    <TierTag tier={tier} size="lg" />
                    <span
                      style={MONO}
                      className="text-xs font-bold tabular-nums text-muted dark:text-darkMuted"
                    >
                      {fmtPercent(result.score)}
                    </span>
                    {delta !== null && delta !== 0 && (
                      <span
                        style={MONO}
                        title="Change since the previous scored vector"
                        className={`text-[10.5px] font-bold tabular-nums ${
                          delta > 0 ? 'text-tierHigh' : 'text-tierLow'
                        }`}
                      >
                        {delta > 0 ? `▲ +${delta}` : `▼ ${delta}`} pts
                      </span>
                    )}
                  </div>
                  {scoring && (
                    <p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-muted dark:text-darkMuted">
                      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                      re-scoring
                    </p>
                  )}
                </div>

                {/* Score response */}
                <div className="mt-5 rounded-xl border border-line/60 bg-white/70 p-3.5 backdrop-blur dark:border-darkBorder/60 dark:bg-darkCard/70">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">
                      Score response to your edits
                    </p>
                    <span style={MONO} className="text-[10px] tabular-nums text-muted dark:text-darkMuted">
                      {history.length} reading{history.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <ScoreSparkline history={history} />
                  <p className="mt-1.5 text-[10px] text-muted dark:text-darkMuted">
                    Dashed bands are the served thresholds — 0.70 High, 0.40 Medium.
                  </p>
                </div>

                {/*
                 * The next step, coloured by the stage it names.
                 *
                 * This is the answer to "so what do I order?", and the four stages
                 * already have four colours everywhere else in the app, so the card
                 * wears the colour of the step it recommends (or settles back to
                 * neutral once the pathway is complete).
                 */}
                <div
                  className="mt-5 rounded-xl border border-line/60 bg-white/70 p-4 backdrop-blur dark:border-darkBorder/60 dark:bg-darkCard/70"
                  style={nextStage ? { borderColor: `${STAGE_FILLS[nextStage - 1]}59` } : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 rounded-full"
                      style={{ background: nextStage ? STAGE_FILLS[nextStage - 1] : '#6E7175' }}
                    />
                    <span
                      className="text-[10px] font-bold uppercase tracking-[0.14em]"
                      style={{ color: nextStage ? STAGE_FILLS[nextStage - 1] : undefined }}
                    >
                      {protocolLabel}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted dark:text-darkMuted">
                    {protocol}
                  </p>
                </div>
              </HeroPanel>

              {/* Attribution */}
              <div className={`${PANEL} p-5`}>
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
                  What moved this score
                </SectionLabel>

                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  {['Cognitive', 'Blood', 'MRI', 'PET'].map((name) => (
                    <span
                      key={name}
                      className="inline-flex items-center gap-1.5 text-[10px] text-muted dark:text-darkMuted"
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: STAGE_COLORS[name] }}
                      />
                      {name}
                    </span>
                  ))}
                </div>

                <p className="mt-2.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
                  The measurements doing most of the work on this score, biggest first: the model&apos;s
                  own SHAP values for the vector it was just handed. A row marked{' '}
                  <span className="font-semibold text-ink dark:text-darkText">model default</span> is a
                  test that was not ordered, so the model fell back to the branch it learned for a
                  missing value.
                </p>

                <div className="mt-4 space-y-3">
                  {drivers.length === 0 ? (
                    <p className="text-xs text-muted dark:text-darkMuted">
                      Calculating feature importances…
                    </p>
                  ) : (
                    drivers.map((f, i) => {
                      const meta = FACTOR_META[f.feature] || { stage: 'Other', label: f.feature };
                      const isDefault = f.value === null || f.value === undefined;
                      const isUp = f.contribution > 0;
                      const abs = Math.abs(f.contribution);
                      const widthPct = Math.min(100, Math.max(8, (abs / maxContribution) * 100));
                      const color = isUp ? TIER_HEX.high : TIER_HEX.low;

                      return (
                        <div
                          key={`${f.feature}-${i}`}
                          className={`space-y-1 ${isDefault ? 'opacity-55' : ''}`}
                        >
                          <div className="flex items-baseline justify-between gap-3 text-xs">
                            <span className="truncate font-medium text-ink dark:text-darkText">
                              <span
                                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                                style={{ backgroundColor: STAGE_COLORS[meta.stage] || '#6E7175' }}
                              />
                              {meta.label}
                              <span
                                style={MONO}
                                className="ml-1 text-[10.5px] text-muted dark:text-darkMuted"
                              >
                                · {formatFactorValue(f)}
                              </span>
                              {isDefault && (
                                <span className="ml-1.5 rounded border border-line px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted dark:border-darkBorder dark:text-darkMuted">
                                  model default
                                </span>
                              )}
                            </span>
                            <span className="font-bold text-[11px]" style={{ ...MONO, color }}>
                              {isUp ? '+' : '−'}
                              {abs.toFixed(3)}
                            </span>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
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
          )}
          </div>
        </div>
      </div>

      {/*
       * The readout that follows the reader down the rest of the workbench.
       *
       * It is PORTALLED to the body, and that is load-bearing: this page's root
       * carries `animate-fade-up`, whose keyframes animate `transform`, and a
       * transformed ancestor becomes the containing block for `position: fixed`
       * descendants. Left in place the card anchored itself to the bottom of the
       * page content — measured at 378px from the top of an 800px viewport
       * instead of hugging the viewport — so it only appeared once the reader had
       * already scrolled to the very bottom, which is the opposite of the point.
       */}
      {result &&
        railDocked &&
        typeof document !== 'undefined' &&
        createPortal(
          <ScoreDock
            result={result}
            tier={tier}
            delta={delta}
            history={history}
            onJump={jumpToResult}
          />,
          document.body
        )}
    </div>
  );
}
