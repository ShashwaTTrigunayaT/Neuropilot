import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  Banknote,
  CheckCircle2,
  Compass,
  Cpu,
  Database,
  Download,
  Droplets,
  Gauge,
  GitBranch,
  GraduationCap,
  History,
  KeyRound,
  Layers,
  LineChart,
  ListTree,
  PackageCheck,
  Percent,
  Play,
  Repeat,
  Route,
  Ruler,
  Scan,
  Search,
  ShieldAlert,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  Target,
  TrendingUp,
  Upload,
  Users,
  Workflow,
} from 'lucide-react';
import AutoScrollShowcase from './AutoScrollShowcase.jsx';
import FeatureRadarChart, { FEATURE_LABEL, STAGE_OF } from './FeatureRadarChart.jsx';
import {
  Btn,
  JOINED_GRID,
  MONO,
  PANEL,
  RibbonStat,
  STAGE_FILLS,
  StageIcon,
} from './widgets.jsx';
import { fmtScore } from '../lib.js';

const STAGE_ORDER = ['1', '2', '3', '4'];

const STAGE_TITLE = {
  1: 'Cognition & clinical',
  2: 'Blood biomarkers',
  3: 'MRI volumetrics',
  4: 'PET imaging',
};

// The bands below the preview. Anything the preview already explains in full is
// deliberately not repeated here — these are the cohort's own numbers.
const JUMPS = [['attribution', 'Attribution']];

/*
 * The closing section's four moves.
 *
 * Each card is the SAME action as one of the buttons above it — hence the action
 * key, which is resolved against the handlers below — so the card can name its
 * button and click through to it. The correspondence is shown, not numbered: an
 * animated arrow rises from each card toward the row of buttons, and the card
 * prints the exact label it stands for.
 *
 * The model card is deliberately NOT restated here: the preview already carries
 * it, and repeating it made the page end on a spec sheet.
 */
const HANDOFF_STEPS = [
  [
    'queue',
    'Open the worklist',
    'Every subject in one queue, highest priority first. Rank keeps counting across pages, so the order itself is the recommendation.',
  ],
  [
    'autonomous',
    'Propose the next batch',
    'The approval-gated workup: the model proposes the next tests with its reasoning, and nothing is ordered until a clinician approves it.',
  ],
  [
    'simulator',
    'Test a what-if',
    'Move the measurements and watch the score, the tier and the attribution respond — before a single test is ordered on a real subject.',
  ],
  [
    'interop',
    'Hand it back',
    'Anything recorded leaves as a RiskAssessment on the hospital’s own system of record — never as a Condition, so nothing here quietly becomes a diagnosis.',
  ],
];

const auc = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');

/*
 * Fire once, when a block actually reaches the viewport.
 *
 * The hand-off arrows are the only thing on this page that keeps moving after it
 * has been read, and arrows already mid-flight when the reader arrives say
 * nothing at all. So they sit parked (`.is-idle`) until the closing section is
 * on screen, then start — staggered per card, so the four read as one gesture
 * passing left to right instead of four blinking icons. The observer is dropped
 * the moment it fires: nothing keeps watching the scroll after that.
 */
function useInView(ref, rootMargin = '0px 0px -15% 0px') {
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setSeen(true);
      return undefined;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref, seen, rootMargin]);

  return seen;
}

/*
 * The hand-off wiring.
 *
 * A wire is drawn from each button down to the card that stands for it, the way
 * a flow diagram wires its boxes together. Nothing here is estimated: both ends
 * are measured off the real elements (found by their `data-handoff` key) after
 * layout and again on every resize, so the wire lands on the button and the card
 * at whatever width, however the rows have wrapped. The SVG sits in the same
 * coordinate space as the wrapper it is anchored to, so the wires survive
 * scrolling without a single scroll listener.
 *
 * The wires are drawn from a fixed template, not from a spline between the two
 * points. A plain cubic curve takes its shape from the distance it has to span,
 * so the four wires came out with four different bends and the set read as four
 * unrelated arrows rather than one diagram. Instead every wire is the same
 * elbow: drop from the button, turn with the same corner radius, cross, turn
 * again, and make the same fixed-length entry into the card. Only the length of
 * the crossing varies, which is exactly the thing that is supposed to vary.
 */
function HandoffLinks({ containerRef, seen }) {
  const [links, setLinks] = useState([]);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const measure = () => {
      const base = container.getBoundingClientRect();
      const byKey = new Map();
      container.querySelectorAll('[data-handoff]').forEach((el) => {
        const key = el.getAttribute('data-handoff');
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(el);
      });

      const next = [];
      byKey.forEach((els, key) => {
        const [btn, card] = els; // order in the DOM: button row, then the card
        if (!btn || !card) return;
        const b = btn.getBoundingClientRect();
        const c = card.getBoundingClientRect();
        const x1 = Math.round(b.left + b.width / 2 - base.left);
        const y1 = Math.round(b.bottom - base.top);
        const x2 = Math.round(c.left + c.width / 2 - base.left);
        const y2 = Math.round(c.top - base.top) - 2;

        // Identical on every wire: the corner radius, the entry into the card,
        // and the minimum length of the crossing between the two corners.
        const RUN = 12; // the vertical entry into the card, arrowhead included
        const R = 9; // corner radius — never scaled down, or one wire reads as a different arrow
        const MIN_RUN = R * 2; // a crossing shorter than this cannot hold two corners

        const dx = x2 - x1;
        const sx = dx < 0 ? -1 : 1;
        // Risk simulator sits almost exactly above its own card (8px of offset),
        // and clamping the radius there made that one wire visibly tighter than
        // the rest. Instead the wire LEAVES the button a few pixels off centre —
        // invisible on a 200px button — so every crossing is at least two radii
        // and all four arrows are the same shape.
        const short = Math.abs(dx) < MIN_RUN ? (MIN_RUN - Math.abs(dx)) / 2 : 0;
        const ax = x1 - sx * short;
        const bx = x2 + sx * short; // both ends budge by the same few pixels
        const yCross = y2 - RUN;

        // Too little vertical room to turn at all: a straight drop is the honest
        // shape there (narrow viewports, where a row has stacked).
        const elbow =
          yCross - R <= y1
            ? `M ${ax} ${y1} L ${bx} ${y2}`
            : `M ${ax} ${y1}` +
              ` L ${ax} ${yCross - R}` +
              ` Q ${ax} ${yCross} ${ax + sx * R} ${yCross}` +
              ` L ${bx - sx * R} ${yCross}` +
              ` Q ${bx} ${yCross} ${bx} ${yCross + R}` +
              ` L ${bx} ${y2}`;

        next.push({ key, d: elbow });
      });

      setLinks(next);
      setBox({ w: base.width, h: base.height });
    };

    measure();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (ro) ro.observe(container);
    window.addEventListener('resize', measure);
    return () => {
      if (ro) ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [containerRef]);

  if (!links.length) return null;

  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute left-0 top-0 z-20"
      width={box.w}
      height={box.h}
      viewBox={`0 0 ${box.w} ${box.h}`}
      fill="none"
    >
      <defs>
        {/* one arrowhead, so every wire ends the same way */}
        <marker
          id="handoff-head"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="5.5"
          markerHeight="5.5"
          orient="auto"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#0D8282" />
        </marker>
      </defs>
      {links.map((l, i) => (
        <g key={l.key}>
          {/* the wire itself: always there, so the mapping reads even if motion is off */}
          <path
            d={l.d}
            stroke="#0D8282"
            strokeOpacity="0.3"
            strokeWidth="1.4"
            markerEnd="url(#handoff-head)"
          />
          {/* the travelling dashes: the click, moving button → card */}
          <path
            d={l.d}
            className={`handoff-link transition-opacity ${seen ? '' : 'is-idle'}`}
            style={{ animationDelay: `${i * 130}ms`, strokeOpacity: seen ? 0.85 : undefined }}
            stroke="#0D8282"
            strokeWidth="1.4"
            strokeLinecap="round"
          />
        </g>
      ))}
    </svg>
  );
}

// One icon weight for every preview point, so the panels look like one document
// instead of ten slides designed separately. Stage-coloured icons are passed in
// as nodes instead of through this helper.
const ptIcon = (Icon) => <Icon className="h-3.5 w-3.5 shrink-0 text-accent/70" />;

/* ------------------------------------------------------------------ */
/*  Band scaffolding                                                   */
/* ------------------------------------------------------------------ */
/*
 * Full-bleed bands: the BACKGROUND spans the viewport, the content sits on the
 * same rail as the header and footer, so a long page still lines up with the
 * navigation above it.
 */
function Band({ id, tint = false, className = '', inner = '', children }) {
  return (
    <section
      id={id}
      className={`w-full scroll-mt-24 border-t border-line dark:border-darkBorder ${
        tint ? 'bg-tint/50 dark:bg-darkCard/40' : ''
      } ${className}`}
    >
      <div className={`mx-auto w-full max-w-6xl px-6 py-14 lg:py-16 ${inner}`}>{children}</div>
    </section>
  );
}

function BandHead({ eyebrow, title, lede, right, wide = false }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-6">
      <div className={wide ? 'max-w-4xl' : 'max-w-2xl'}>
        {eyebrow && (
          <p className="text-[10.5px] font-bold uppercase tracking-[0.18em] text-accent">{eyebrow}</p>
        )}
        <h2 className="mt-2.5 text-[23px] font-bold leading-[1.15] tracking-tight text-ink dark:text-darkText sm:text-[29px]">
          {title}
        </h2>
        {lede && (
          <p className="mt-3.5 text-[13px] leading-relaxed text-muted dark:text-darkMuted">{lede}</p>
        )}
      </div>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ */

export default function Overview({
  patients,
  modelInfo = null,
  dataSource = '',
  onShowAll,
  onOpenSimulator,
  onViewChange,
}) {
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    patients.forEach((p) => {
      if (c[p.risk_tier] !== undefined) c[p.risk_tier] += 1;
    });
    return c;
  }, [patients]);

  const meanRisk = useMemo(
    () => (patients.length ? patients.reduce((a, p) => a + (p.final_score ?? p.score), 0) / patients.length : 0),
    [patients]
  );

  const total = patients.length;
  const elevated = counts.high + counts.medium;
  const elevatedPct = total ? Math.round((elevated / total) * 100) : 0;
  // Share of the cohort, for the ribbon's proportion bars — a count means little
  // without the denominator beside it.
  const share = (n) => (total ? (n / total) * 100 : 0);

  // Everything below is read from the card of the model the API actually serves,
  // so the preview can never describe a different model than the one scoring.
  const features = modelInfo?.features || [];
  const featureCount = features.length;
  const thresholds = modelInfo?.thresholds || { high: 0.7, medium: 0.4 };
  const servedImportance = modelInfo?.global_importance || [];
  const nTrain = modelInfo?.n_train;
  const stage1Auc = modelInfo?.test_auc_stage1_only;

  // Keyed by REAL stage number, not by position: a card missing one stage's
  // attribution must not shift the remaining shares onto the wrong stages.
  const stageShare = useMemo(() => {
    const out = {};
    STAGE_ORDER.forEach((key) => {
      const s = modelInfo?.stage_importance?.[key];
      if (s && typeof s.share_pct === 'number') out[Number(key)] = s;
    });
    return out;
  }, [modelInfo]);

  // The served model's own features, grouped onto the stages a clinician orders
  // — so "what each stage measures" is generated, never asserted.
  const stageFeatures = useMemo(() => {
    const byStage = { 1: [], 2: [], 3: [], 4: [] };
    features.forEach((name) => {
      const stage = STAGE_OF[name];
      if (stage) byStage[stage].push(FEATURE_LABEL[name] || name);
    });
    return byStage;
  }, [features]);

  const shareOf = (stage) => stageShare[stage]?.share_pct;
  const featsOf = (stage, fallback) => (stageFeatures[stage].length ? stageFeatures[stage].join(' · ') : fallback);
  const importanceTotal = servedImportance.reduce((a, f) => a + (f.mean_abs_shap || 0), 0) || 1;
  const source = dataSource ? dataSource.split('+')[0] : 'served';

  // Declared up here (before the empty-cohort return) so the hook order cannot
  // change when the cohort is empty.
  const handoffRef = useRef(null);
  const handoffSeen = useInView(handoffRef);

  /*
   * The preview: the whole system, one full-screen panel per capability, each
   * explained deeply enough that a reader already knows what is behind it before
   * they click. Order is deliberate — provenance first, because that is the
   * first thing a sceptic should check.
   */
  const previewPanels = useMemo(() => [
    {
      id: 'neuropilot',
      accent: '#0D8282',
      tone: 'accent',
      badge: 'the whole system',
      eyebrow: 'NeuroPilot',
      title: 'What NeuroPilot is',
      lede: 'NeuroPilot turns an Alzheimer’s cohort into a ranked escalation queue. It scores every subject across the four stages of a workup, shows what each point of that score is made of, states plainly what the evidence cannot yet support, and proposes the next test that would change the answer — then waits for a clinician to approve it. Nothing is diagnosed, and nothing is written into a chart by the software alone.',
      highlights: [
        `${total.toLocaleString()} real ADNI subjects — no mock row anywhere in the pipeline`,
        'One refined model scores all four stages, trained on follow-up outcome',
        'Three scores per patient: official (measured), provisional (estimated), priority (ranking)',
        'FHIR R4 in and out, with SMART launch from the EHR',
        'Autonomous Neuro proposes; approval stays a human step',
      ],
      onOpen: onShowAll,
      openLabel: 'Open the queue',
      points: [
        {
          icon: ptIcon(Target),
          label: 'The problem it solves',
          detail: 'A cohort arrives as a list, and the work is deciding who gets the next test — not reading it. Two subjects can share a score and need opposite actions: one is missing the evidence that would settle them, the other is fully worked up and waiting. A snapshot cannot tell those apart. NeuroPilot makes that call ordered and arguable.',
        },
        {
          icon: ptIcon(Workflow),
          label: 'What it does, end to end',
          detail: 'It ingests the cohort, scores every subject with the served model, decomposes each score into named contributions, and gates each pathway by what has actually been measured. That one pass produces the queue, the record, the escalation protocol, the outlook and the autonomous proposal — all off one model and one rule engine, so they cannot contradict each other.',
        },
        {
          icon: ptIcon(PackageCheck),
          label: 'What comes out of it',
          detail: 'A ranked queue with a stated tiebreak; a single-screen record per patient; three separate scores, so an estimate never passes for a result; attribution grouped by orderable stage; a projected trajectory; an approval-gated console; FHIR R4 in both directions.',
        },
        {
          icon: ptIcon(ShieldAlert),
          label: 'Where it draws the line',
          detail: 'It never asserts a diagnosis — output travels as a RiskAssessment, never a Condition. It never fabricates a measurement: a missing value stays missing, and the model is NaN-native rather than imputed. It never lets the label leak, and it never acts alone: proposals are read-only until a human approves them.',
        },
      ],
    },
    {
      id: 'data',
      accent: '#1EB980',
      tone: 'ok',
      badge: `${total.toLocaleString()} subjects`,
      eyebrow: 'Provenance',
      title: 'Real ADNI data, not a demo set',
      lede: 'Every number on this page is computed from the de-identified ADNI release — the same public cohort researchers train on. There is no mock patient, no invented row, and no placeholder score anywhere in the pipeline.',
      highlights: [
        `${total.toLocaleString()} subjects loaded from the "${source}" cohort and scored at startup`,
        'Training and test split by subject, never by visit',
        'Label-derived columns (CDR, FAQ) removed before training',
      ],
      onOpen: onShowAll,
      openLabel: 'See the cohort',
      points: [
        {
          icon: ptIcon(Database),
          label: 'The cohort',
          value: total.toLocaleString(),
          detail: `${total.toLocaleString()} subjects are loaded and re-scored from the served model every time the API starts, so what you are reading is that model's output rather than a cached table. Cognition is on file for all of them; blood, MRI and PET are on file for fewer — that unevenness is a property of the cohort, and it is handled rather than hidden.`,
        },
        {
          icon: ptIcon(Layers),
          label: 'The measurement vector',
          value: String(featureCount),
          detail: `${featureCount} features across four modalities: ${featsOf(1, 'the cognitive and clinical baseline')} from cognition and demographics; ${featsOf(2, 'plasma assays')} from blood; ${featsOf(3, 'structural volumetry')} from MRI; ${featsOf(4, 'molecular imaging')} from PET.`,
        },
        {
          icon: ptIcon(GraduationCap),
          label: 'Trained on',
          value: nTrain ? nTrain.toLocaleString() : '—',
          detail: `${nTrain ? nTrain.toLocaleString() : '—'} sessions, split by subject: no patient appears in both training and test. ADNI's own diagnostic-algorithm columns were dropped from the feature set first, because a model that can read the answer is not predicting anything.`,
        },
        {
          icon: ptIcon(Target),
          label: 'Held-out AUROC',
          value: auc(modelInfo?.test_auc),
          valueColor: '#0D8282',
          detail: `${auc(modelInfo?.test_auc)} on data it never saw${stage1Auc ? `, and ${auc(stage1Auc)} on the cognition-only subgroup — the group most of a real cohort actually belongs to` : ''}. The model card publishes its own limitations beside these numbers instead of quarantining them in a repository.`,
        },
      ],
    },
    {
      id: 'stages',
      accent: '#0D8282',
      tone: 'accent',
      badge: '4 stages',
      eyebrow: 'The escalation protocol',
      title: 'Four stages, ordered cheapest first',
      lede: 'An Alzheimer’s workup is priced by escalation: a cognitive scale costs nothing, a plasma panel costs a draw, an MRI costs a scanner slot, PET costs a tracer. NeuroPilot uses that order as a gate rather than a suggestion.',
      highlights: [
        'Stage 1 runs for every subject by default',
        'Cost and invasiveness rise at every step',
        'A later stage contributes nothing until the pathway reaches it',
      ],
      onOpen: onShowAll,
      openLabel: 'Walk the pathway',
      points: STAGE_ORDER.map((key) => {
        const stage = Number(key);
        const share = shareOf(stage);
        return {
          icon: <StageIcon stage={stage} hex={STAGE_FILLS[stage - 1]} />,
          label: STAGE_TITLE[stage],
          value: share != null ? `${share}%` : null,
          bar: share,
          tone: STAGE_FILLS[stage - 1],
          detail: {
            1: `Reads ${featsOf(1, 'the cognitive battery and the clinical baseline')}. Free to collect, so it is the only stage present for every subject — and it carries ${share != null ? `${share}%` : 'a share'} of the model’s total attribution, which is why a cognition-only score is a lead to confirm, not a conclusion.`,
            2: `Reads ${featsOf(2, 'the plasma panel')} from a blood draw: amyloid status and neurodegeneration without a scanner. Ordered when cognition alone cannot separate a subject from the rest of the cohort — the cheapest test that can change a conclusion.`,
            3: `Reads ${featsOf(3, 'structural volumetry')} — the first step that needs a scanner slot and a radiologist’s time. It answers a structural question the plasma panel cannot: how much tissue has actually been lost, and whether that loss is out of proportion to head size.`,
            4: `Reads ${featsOf(4, 'molecular imaging')} — confirmatory imaging, the most expensive and least available step. It finally separates amyloid deposition from tau pathology, and it is ordered last because by then it is the only test left that can change management.`,
          }[stage],
        };
      }),
    },
    {
      id: 'scoring',
      accent: '#0D8282',
      tone: 'muted',
      badge: `${featureCount} features`,
      eyebrow: 'Scoring',
      title: 'One patient, three numbers',
      lede: 'The design decision the whole system rests on: what has been measured, what the model estimates is missing, and the blend used only to decide who is seen first. They are kept strictly apart so an estimate can never pass for a result.',
      highlights: [
        'The tier comes from measured evidence only',
        'An estimate carries at most 30% of the ranking',
        'A test ordered but not returned changes nothing',
      ],
      onOpen: onOpenSimulator || onShowAll,
      openLabel: 'Try it in the simulator',
      points: [
        {
          icon: ptIcon(ShieldCheck),
          label: 'Official score',
          value: 'sets the tier',
          detail: 'The model run on measured evidence only, gated by the ordered pathway. This is the clinical score: it decides the risk tier, it is what a clinician acts on, and ordering a test does not move it. Only a returned result with a real value can.',
        },
        {
          icon: ptIcon(Sparkles),
          label: 'Provisional score',
          value: 'display only',
          valueColor: '#0D8282',
          detail: '48 plausible completions of the stages still missing, each sampled from the cohort’s own measured distributions and pushed back through the served model. It answers “what if the next tests came back?” — and it is never written into a record as an observation, so it cannot be mistaken for one.',
        },
        {
          icon: ptIcon(Gauge),
          label: 'Priority score',
          value: 'orders the queue',
          valueColor: '#D9822B',
          detail: 'official + 0.30 × confidence × (estimate − official). Confidence falls as the plausible completions disagree with each other, so a subject whose missing stage is genuinely unpredictable gets almost none of the estimate’s pull. It orders the queue; it never sets a tier.',
        },
        {
          icon: ptIcon(SlidersHorizontal),
          label: 'Tier thresholds',
          value: 'config',
          detail: `low < ${thresholds.medium.toFixed(2)} · medium ${thresholds.medium.toFixed(2)}–${thresholds.high.toFixed(2)} · high ≥ ${thresholds.high.toFixed(2)}. These are configuration rather than model output, so a service can move its High cut-off without retraining anything — and a subject with no biomarker evidence on file is held at the tier its measured evidence supports.`,
        },
      ],
    },
    {
      id: 'evidence',
      accent: '#0D8282',
      tone: 'accent',
      badge: 'SHAP',
      eyebrow: 'Explainability',
      title: 'Every point is traceable',
      lede: 'A ranking a clinician cannot interrogate is a ranking they will not use. Each score decomposes into named contributions that appear at the cohort level, the stage level and on the individual record — and on a single record the same quantity is recomputed for that patient, with its sign, so the page can say which way it pushed.',
      highlights: [
        'Feature-level attribution on every record',
        'Grouped by the stage a clinician can actually order',
        'Computed tree-path-dependently — correct where features are missing',
      ],
      onOpen: onOpenSimulator || onShowAll,
      openLabel: 'Watch the attribution move',
      points: servedImportance.slice(0, 4).map((f) => {
        const share = ((f.mean_abs_shap || 0) / importanceTotal) * 100;
        // The attribution rows carry the icon of the stage the feature belongs to,
        // so the top of the list doubles as a statement about which modalities
        // are actually driving this model.
        const stage = STAGE_OF[f.feature] || 1;
        return {
          icon: <StageIcon stage={stage} hex={STAGE_FILLS[stage - 1]} />,
          label: FEATURE_LABEL[f.feature] || f.feature,
          value: `${share.toFixed(0)}%`,
          bar: share,
          tone: '#0D8282',
          detail: `Mean |SHAP| ${Number(f.mean_abs_shap || 0).toFixed(3)} — the average size of this feature’s effect across the cohort, with the stage it belongs to marked by its icon.`,
        };
      }),
    },
    {
      id: 'record',
      accent: '#0D8282',
      tone: 'accent',
      badge: 'one record',
      eyebrow: 'The patient page',
      title: 'One record, four stages, no tabs',
      lede: 'The page a clinician actually works in: the pathway, the evidence, the attribution and the next indicated test on a single screen — with nothing hidden behind a tab that could be missed at two in the morning.',
      highlights: [
        'Stage status at a glance: on file, next, or gated',
        'Measured result and model estimate, always labelled',
        'One click from any factor to the view that explains it',
      ],
      onOpen: onShowAll,
      openLabel: 'Open a record',
      points: [
        {
          icon: ptIcon(Route),
          label: 'The pathway ladder',
          detail: 'All four stages on one rail, each marked on file, next indicated, or not yet ordered. Ordering the next test moves the pathway forward; if the file already holds that result it is incorporated immediately and the official score re-runs on it. If it does not, the slot is ordered and the official score deliberately stays where it was.',
        },
        {
          icon: ptIcon(ListTree),
          label: 'Attribution in place',
          detail: 'The factors that produced this subject’s score, listed with the direction and size of each effect — and grouped by the stage it came from, so a clinician can see whether the ranking is being driven by measured evidence or by an estimate of what is still missing. Estimated contributions are labelled as estimates.',
        },
        {
          icon: ptIcon(Ruler),
          label: 'Every value against its range',
          detail: 'Each measurement is shown with its unit and its position against the range the pipeline treats as normal, so an abnormal value is visible as abnormal rather than as a number to be looked up somewhere else. A stage that has not been ordered shows its estimated values under a clear heading, with a button to record the real result when it arrives.',
        },
        {
          icon: ptIcon(Stethoscope),
          label: 'The next indicated test',
          detail: 'The rule engine’s recommendation with the gate that produced it, taken from the same logic Autonomous Neuro plans with — so the recommendation on the record and the proposal in the console can never disagree. The progression view sits one click away for the trajectory behind it.',
        },
      ],
    },
    {
      id: 'simulator',
      accent: '#D9822B',
      tone: 'warn',
      badge: 'what-if',
      eyebrow: 'Risk simulator',
      title: 'Change a feature, watch the score move',
      lede: 'The fastest way to see what the model actually responds to: set the real feature vector by hand — including switching whole stages on and off — and watch the score and its attribution recompute on the spot.',
      highlights: [
        'The real feature vector, not a toy subset of it',
        'Per-stage toggles mirror the ordered pathway',
        'Same served model, so nothing here is a special case',
      ],
      onOpen: onOpenSimulator || onShowAll,
      openLabel: 'Open the simulator',
      points: [
        {
          icon: ptIcon(Users),
          label: 'Demographics and cognition',
          detail: 'Age, biological sex, years of education and the cognitive measures, entered in the ranges the cohort actually spans rather than in arbitrary ones. This is the block that matters most, because it is the only stage present for every subject — so it is also the best place to see how quickly a cognition-only score stops being informative.',
        },
        {
          icon: ptIcon(Droplets),
          label: 'Blood biomarkers',
          detail: `The plasma panel — ${featsOf(2, 'amyloid and neurodegeneration assays')} — entered in the units the ingestion pipeline reads. Switch the stage off to see what the score looks like without any blood evidence at all, which is the situation most of a real cohort is actually in.`,
        },
        {
          icon: ptIcon(Scan),
          label: 'MRI and PET',
          detail: `Structural volumetry (${featsOf(3, 'hippocampal measures')}) and molecular imaging (${featsOf(4, 'amyloid and tau')}), each toggleable. Because the pathway is a gate, switching PET on while MRI is off is not a state a patient can reach — the simulator exercises the same gate the queue does.`,
        },
        {
          icon: ptIcon(Cpu),
          label: 'Pressed against the served model',
          detail: 'Every change goes through the same prediction and explanation path the queue uses, so a number here cannot disagree with a number on a patient record. That is the point of the view: not to explore a different model, but to see this one’s behaviour with the inputs the cohort cannot supply.',
        },
      ],
    },
    {
      id: 'autonomy',
      accent: '#0D8282',
      tone: 'ok',
      badge: 'approval-gated',
      eyebrow: 'Autonomy',
      title: 'Autonomous Neuro proposes; a clinician decides',
      lede: 'The system walks its own priority queue, works out which single test would most change each subject’s standing, and states its reasoning in full — then stops. Nothing is ordered, recorded or scored until a human approves it.',
      highlights: [
        'Planning runs on a copy of each record, so it cannot act',
        'Approved actions are re-checked against live state first',
        'Every executed step is written into the audit trail',
      ],
      onOpen: onViewChange ? () => onViewChange('autonomous') : undefined,
      openLabel: 'Open the console',
      points: [
        {
          icon: ptIcon(Search),
          label: 'Why this subject',
          detail: 'Its rank in the queue, its priority score and its tier — and, if anything sits above it, why nothing above it has an indicated test. The selection is stated rather than implied, so a reviewer can disagree with it on the evidence instead of having to reverse-engineer it.',
        },
        {
          icon: ptIcon(GitBranch),
          label: 'Why this test',
          detail: 'The rule engine’s own gate text, quoted verbatim rather than paraphrased. If the gate says a subject cannot reach PET before the MRI is on file, that sentence is what appears in the proposal — the reason is the system’s, not a summariser’s.',
        },
        {
          icon: ptIcon(Banknote),
          label: 'Cost to the patient',
          detail: 'Whether the result is already sitting on file — in which case the action is zero-cost and orders nothing new — or whether a real order has to be placed. Cost is part of the proposal because prioritisation that ignores it is just a sorted list.',
        },
        {
          icon: ptIcon(TrendingUp),
          label: 'Expected effect',
          detail: 'The projected score, tier and queue position before and after, so a batch can be judged on what it would actually buy. If the honest answer is that eight tests move nobody, the plan says so before approval — and an approved action is re-checked against live state and skipped with a stated reason if the subject’s pathway moved in the meantime.',
        },
      ],
    },
    {
      id: 'outlook',
      accent: '#8B5CF6',
      tone: 'accent',
      badge: 'trajectory',
      eyebrow: 'Progression outlook',
      title: 'And where the subject is heading',
      lede: 'Alzheimer’s is progressive and currently incurable, so who gets worse next is the decision that matters. The outlook view puts the measured path and the projected continuation on one axis instead of reporting a single snapshot.',
      highlights: [
        'Measured stage scores marked on the trajectory',
        'A projected score and cognition for the next assessment',
        'The probability of the clinical phase itself advancing',
      ],
      onOpen: onShowAll,
      openLabel: 'Open a record',
      points: [
        {
          icon: ptIcon(History),
          label: 'Measured',
          detail: 'The score at every stage already completed, plotted on the trajectory and annotated with the risk tier it sat in at the time. The past is shown rather than replaced by the projection, so a clinician can see whether the subject has been drifting consistently or whether today is a step change.',
        },
        {
          icon: ptIcon(LineChart),
          label: 'Projected',
          detail: 'The expected score and cognition at the next assessment, produced by the refined model family that ranks the queue — the same one, not a second opinion from a different codebase. It is a direction with a stated uncertainty, not a promise of a number.',
        },
        {
          icon: ptIcon(Percent),
          label: 'Probability',
          detail: 'The chance the clinical phase itself advances, which is deliberately separated from the chance the score gets worse. A score can worsen without a stage changing, and conflating the two is how a screening tool starts to sound like a diagnosis.',
        },
        {
          icon: ptIcon(Compass),
          label: 'Drivers',
          detail: 'Which of the subject’s own measurements move that projection, so the forecast is attributable rather than asserted. A trajectory a clinician cannot interrogate is one they will discount, so every driver is named and every estimate is labelled as an estimate.',
        },
      ],
    },
    {
      id: 'interop',
      accent: '#3B82F6',
      tone: 'muted',
      badge: 'FHIR R4',
      eyebrow: 'Interoperability',
      title: 'FHIR R4, in and out',
      lede: 'NeuroPilot sits on the hospital’s system of record rather than beside it. Model output leaves as a RiskAssessment — decision support by definition — and never as a Condition, so nothing here can quietly become a diagnosis in the chart.',
      highlights: [
        'Export: Patient, Observation, RiskAssessment, AuditEvent',
        'Ingest: any Bundle, mapped then re-scored by the served model',
        'Launch: SMART on FHIR with PKCE, tokens held server-side',
      ],
      onOpen: onViewChange ? () => onViewChange('interop') : undefined,
      openLabel: 'Open interoperability',
      points: [
        {
          icon: ptIcon(Upload),
          label: 'Export',
          detail: 'Patient, Observation, RiskAssessment and AuditEvent, versioned as FHIR R4, plus a full-record operation per subject so a hospital can pull everything NeuroPilot holds in one call. RiskAssessments carry the score, the tier and the attribution basis, which means the reasoning travels with the number rather than staying in this UI.',
        },
        {
          icon: ptIcon(Download),
          label: 'Inbound ingestion',
          detail: 'A transaction, collection or document Bundle is mapped onto the internal record and the served model re-scores the subject on it. Ingestion is atomic: a resource it cannot map, or a value with the wrong UCUM unit, rejects the whole bundle with an OperationOutcome that names every offender — so a partial write can never leave a patient scored on half a result.',
        },
        {
          icon: ptIcon(Repeat),
          label: 'Bidirectional',
          detail: 'Orders leave as ServiceRequests and results return as DiagnosticReports that close the order — the same internal path a result typed into the UI takes. Outbound push to a hospital server is a deliberate switch, never a default, because writing into a chart is not something software should do quietly.',
        },
        {
          icon: ptIcon(KeyRound),
          label: 'SMART launch',
          detail: 'OAuth2 with PKCE, launched from the EHR so the session binds to the patient the clinician already has open. Access and refresh tokens are held server-side, never handed to the browser. In India the consent path is ABDM: purpose-bound, time-bounded, encrypted end to end.',
        },
      ],
    },
  ], [
    counts,
    dataSource,
    featureCount,
    importanceTotal,
    modelInfo,
    nTrain,
    onOpenSimulator,
    onShowAll,
    onViewChange,
    servedImportance,
    source,
    stage1Auc,
    stageFeatures,
    stageShare,
    thresholds,
    total,
  ]);

  if (!total) {
    return (
      <div className={`${PANEL} mx-auto max-w-lg p-8 text-center`}>
        <p className="text-sm font-semibold text-ink dark:text-darkText">No patients loaded.</p>
        <p className="mt-1.5 text-xs text-muted dark:text-darkMuted">
          The cohort the API serves is empty, so there is nothing to rank yet.
        </p>
      </div>
    );
  }

  /*
   * Cards ↔ buttons, resolved in one place.
   *
   * The row of actions in the closing section and the four cards under it are the
   * same four moves, so they are defined once and bound to each other here: a
   * card names the button it stands for ("same as") and clicks through to it, and
   * the button carries the card's number. The handlers come from App, so a card
   * can never drift out of step with the control it claims to be.
   */
  const handoff = {
    queue: { label: `${total.toLocaleString()} patients`, run: onShowAll },
    autonomous: {
      label: 'Autonomous Neuro',
      run: onViewChange ? () => onViewChange('autonomous') : null,
    },
    simulator: { label: 'Risk simulator', run: onOpenSimulator || null },
    interop: { label: 'Interoperability', run: onViewChange ? () => onViewChange('interop') : null },
  };

  return (
    <div className="animate-fade-up">
      {/* ================================================================ */}
      {/* THE PREVIEW — full screen, sliding on its own, nothing above it   */}
      {/* ================================================================ */}
      <section
        className="relative flex w-full flex-col overflow-hidden"
        style={{ height: 'calc(100dvh - 3.5rem)' }}
      >
        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-[520px]"
          style={{ background: 'radial-gradient(64% 100% at 50% 0%, rgba(13,130,130,0.15), transparent 70%)' }}
        />
        <div className="relative flex min-h-0 flex-1 flex-col justify-center py-3">
          <AutoScrollShowcase panels={previewPanels} />
        </div>
      </section>

      

      {/* ================================================================ */}
      {/* Live cohort state — numbers the preview does not carry            */}
      {/* ================================================================ */}
      <Band inner="!py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="flex items-center gap-2 text-[10.5px] font-bold uppercase tracking-[0.16em] text-accent">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              Live cohort state
            </p>
            <p className="mt-2 text-[12px] text-muted dark:text-darkMuted">
              <strong style={MONO} className="font-bold text-ink dark:text-darkText">{elevatedPct}%</strong> elevated —
              high or medium priority · served from the {source} cohort
            </p>
          </div>
          <Btn tone="quiet" onClick={onShowAll} className="px-3.5 py-2">
            Open the queue
            <ArrowRight className="h-3.5 w-3.5" />
          </Btn>
        </div>

        <div className={`${JOINED_GRID} mt-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5`}>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat icon={Users} label="Subjects" value={total.toLocaleString()} tone="accent" hint="scored by the refined model" />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat icon={Siren} label="High priority" value={counts.high.toLocaleString()} tone="bad" bar={share(counts.high)} hint="biomarker evidence on file" />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat icon={AlertCircle} label="Medium" value={counts.medium.toLocaleString()} tone="warn" bar={share(counts.medium)} hint="awaiting the next stage" />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat icon={CheckCircle2} label="Low" value={counts.low.toLocaleString()} tone="ok" bar={share(counts.low)} hint="stable on current evidence" />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat icon={Gauge} label="Mean priority" value={fmtScore(meanRisk)} tone="accent" bar={meanRisk * 100} hint="cohort average, 0–1" />
          </div>
        </div>
      </Band>

      {/* ================================================================ */}
      {/* What the ranking is made of — the served model's own attribution   */}
      {/* ================================================================ */}
      {servedImportance.length > 0 && (
        <Band id="attribution" tint>
          <BandHead
            eyebrow="Attribution"
            title="What the ranking is actually made of."
            lede={`Every feature the refined model reads — ${featureCount} of them, grouped by the stage a clinician can order — sized by its mean |SHAP| across the cohort. The spokes sit on a square-root scale because the underlying values span two orders of magnitude; that is stated on the chart rather than left silent.`}
            right={
              <div className="flex flex-wrap gap-1.5">
                {STAGE_ORDER.map((key) => {
                  const stage = Number(key);
                  const s = stageShare[stage];
                  if (!s) return null;
                  return (
                    <span
                      key={key}
                      className="inline-flex items-center gap-1.5 rounded-full border border-line/70 bg-white px-2.5 py-1 text-[10.5px] font-semibold text-ink shadow-soft dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
                    >
                      <span className="h-2 w-2 rounded-full" style={{ background: STAGE_FILLS[stage - 1] }} />
                      {STAGE_TITLE[stage]}
                      <span style={MONO} className="font-bold">
                        {s.share_pct}%
                      </span>
                    </span>
                  );
                })}
              </div>
            }
          />
          <div className="mt-8">
            <FeatureRadarChart data={servedImportance} />
          </div>
        </Band>
      )}

      {/* ================================================================ */}
      {/* Closing                                                           */}
      {/* ================================================================ */}
      <section className="w-full border-t border-line dark:border-darkBorder">
        <div className="relative w-full overflow-hidden">
          <div
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(70% 130% at 50% 120%, rgba(13,130,130,0.18), transparent 70%)' }}
          />
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[240px]"
            style={{ background: 'radial-gradient(50% 100% at 50% 0%, rgba(13,130,130,0.07), transparent 72%)' }}
          />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent dark:via-accent/30" />
          <div className="relative mx-auto w-full max-w-6xl px-6 py-16 text-center lg:py-20">
            <div className="flex items-center justify-center gap-2.5">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
              <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Hand-off</p>
              <span aria-hidden="true" className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent" />
            </div>
            <h2 className="mx-auto mt-4 max-w-3xl text-[30px] font-black leading-[1.02] tracking-[-0.035em] text-ink dark:text-darkText sm:text-[42px]">
              Work the queue, not the charts.
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[13px] leading-relaxed text-muted dark:text-darkMuted">
              Start at the top of the list — or open the console and let the system tell you what it
              would order next, and why.
            </p>

            {/*
             * The four actions and the four cards that explain them, wired to
             * each other.
             *
             * This wrapper is the flow diagram's coordinate space: the connector
             * layer measures both rows inside it and draws a line from every
             * button down to the card that stands for it. Each element carries its
             * `data-handoff` key, so a card can never end up wired to the wrong
             * button — the key is the same one that resolves the handler.
             *
             * A handler the host view did not pass drops its button, and the wire
             * to that card is simply not drawn: nothing lands on an inert card.
             */}
            <div ref={handoffRef} className="relative">
              <HandoffLinks containerRef={handoffRef} seen={handoffSeen} />

              <div className="relative z-10 mt-8 flex flex-wrap items-center justify-center gap-2.5">
                {[
                  ['queue', 'primary', Users, 'px-6 py-3 text-[12.5px] shadow-glow-teal'],
                  ['autonomous', 'ghost', Play, 'px-5 py-3 text-[12px]'],
                  ['simulator', 'quiet', SlidersHorizontal, 'px-5 py-3 text-[12px]'],
                  ['interop', 'ghost', Workflow, 'px-5 py-3 text-[12px]'],
                ].map(([key, tone, Icon, cls]) => {
                  const cta = handoff[key];
                  if (!cta.run) return null;
                  return (
                    <Btn
                      key={key}
                      data-handoff={key}
                      tone={tone}
                      onClick={cta.run}
                      className={cls}
                    >
                      <Icon className={tone === 'primary' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                      {cta.label}
                      {tone === 'primary' && <ArrowRight className="h-3.5 w-3.5" />}
                    </Btn>
                  );
                })}
              </div>

              {/*
               * What those four buttons above actually do — one card each.
               *
               * A joined grid (hairlines come from the gap showing the line-coloured
               * backdrop through it) keeps the four cells reading as one strip — the
               * same structure the status ribbon and the phase rail use. Each cell is
               * set left while the block around it stays centred, because a centred
               * sentence in a narrow cell is harder to read than a flush one.
               *
               * The gap between this grid and the button row above is deliberately
               * wider than the page's normal rhythm: it is the lane the connectors
               * travel down, and they need room to be read as lines rather than as
               * arrows glued to the buttons.
               */}
              <div className="relative z-10 mx-auto mt-14 grid w-full max-w-4xl gap-px overflow-hidden rounded-2xl border border-line/70 bg-line/60 text-left dark:border-darkBorder/70 dark:bg-darkBorder/60 sm:grid-cols-2 lg:grid-cols-4">
                {HANDOFF_STEPS.map(([key, title, body]) => {
                  const cta = handoff[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      data-handoff={key}
                      onClick={cta.run || undefined}
                      disabled={!cta.run}
                      title={cta.run ? `Same as “${cta.label}” above` : undefined}
                      className="group/handoff flex h-full flex-col bg-white/85 p-4 text-left backdrop-blur-sm transition hover:bg-white disabled:cursor-default dark:bg-darkCard/85 dark:hover:bg-darkCard"
                    >
                      <div className="flex items-center gap-2">
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70" />
                        <span aria-hidden="true" className="h-px flex-1 bg-gradient-to-r from-accent/35 to-transparent" />
                      </div>
                      <p className="mt-2.5 text-[12.5px] font-bold tracking-[-0.01em] text-ink dark:text-darkText">
                        {title}
                      </p>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
                        {body}
                      </p>
                      <span className="mt-auto flex items-center gap-1.5 pt-3">
                        <span
                          style={MONO}
                          className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted"
                        >
                          Wired to
                        </span>
                        <span style={MONO} className="text-[10.5px] font-bold text-accent">
                          {cta.label}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/*
             * No model card in the UI.
             *
             * The preview already introduces the model, its feature count and
             * its held-out AUROC; repeating those numbers here made the page end
             * on a spec sheet. The closing section's job is the hand-off, so the
             * strip below is about where to go, not what was trained.
             */}
            <div className="mt-9 w-full border-t border-line/60 pt-5 dark:border-darkBorder/60">
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted dark:text-darkMuted">
                  On this page
                </p>
                {JUMPS.map(([id, label]) => (
                  <a
                    key={id}
                    href={`#${id}`}
                    className="inline-flex items-center gap-1.5 rounded-full border border-line/80 bg-white/70 px-3 py-1.5 text-[11px] font-semibold text-ink transition hover:border-accent/50 hover:text-accent dark:border-darkBorder dark:bg-darkCard/60 dark:text-darkText"
                  >
                    <ArrowDown className="h-3 w-3 text-accent" />
                    {label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
