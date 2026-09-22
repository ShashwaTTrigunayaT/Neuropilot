import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Ban,
  CheckCircle2,
  ExternalLink,
  Layers,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Users,
} from 'lucide-react';
import {
  Btn,
  MONO,
  MetricTile,
  PANEL,
  PANEL_PAD,
  Pill,
  RibbonStat,
  STAGE_LABELS,
  SectionLabel,
} from './widgets.jsx';
import { API_BASE, api } from '../api.js';

const fmt = (v, digits = 2) => (typeof v === 'number' ? v.toFixed(digits) : '—');
const signed = (v) => (typeof v === 'number' ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}` : '—');

/* What a proposed action is expected to do, in one word. The verdict is
 * deliberately blunt: "order only" and "no change" are legitimate outcomes that
 * the clinician should see before approving, not something to dress up. */
const IMPACT = {
  reclassifies: { tone: 'bad', label: 'Changes tier' },
  material: { tone: 'accent', label: 'Material' },
  marginal: { tone: 'warn', label: 'Marginal' },
  none: { tone: 'muted', label: 'No change' },
  'order-only': { tone: 'muted', label: 'Order only' },
};

const BATCH_SIZES = [5, 8, 12, 20];

function TierChip({ tier }) {
  const tone = tier === 'high' ? 'bad' : tier === 'medium' ? 'warn' : 'ok';
  return <Pill tone={tone}>{tier}</Pill>;
}

function Proposal({ action, approved, onToggle, onOpenPatient, isTop }) {
  const impact = IMPACT[action.impact] || IMPACT.none;
  const climbed = action.rank_delta > 0;
  const slipped = action.rank_delta < 0;

  return (
    <article className={`${PANEL} overflow-hidden transition-all ${approved ? 'ring-2 ring-accent/40' : 'opacity-70'}`}>
      <header className="flex items-start gap-3.5 p-4">
        <button
          type="button"
          onClick={onToggle}
          aria-pressed={approved}
          aria-label={approved ? `Remove ${action.patient_id} from the approved batch` : `Approve ${action.patient_id}`}
          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition ${
            approved
              ? 'border-accent bg-accent text-white'
              : 'border-line dark:border-darkBorder hover:border-accent'
          }`}
        >
          {approved && <CheckCircle2 className="h-3.5 w-3.5" />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <button
              type="button"
              onClick={() => onOpenPatient(action.patient_id)}
              className="text-[13px] font-bold text-ink underline-offset-2 hover:text-accent hover:underline dark:text-darkText"
            >
              {action.patient_id}
            </button>
            <span style={MONO} className="text-[11px] text-muted dark:text-darkMuted">
              rank #{action.rank}
            </span>
            {isTop && <Pill tone="accent">Top of queue</Pill>}
            <Pill tone={impact.tone}>{impact.label}</Pill>
            {action.result_on_file && <Pill tone="ok">No-cost</Pill>}
          </div>

          <p className="mt-1.5 text-[12px] font-medium text-ink dark:text-darkText">{action.test}</p>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted dark:text-darkMuted">
            <span>
              priority{' '}
              <span style={MONO} className="text-ink dark:text-darkText">
                {fmt(action.priority_score)} → {fmt(action.projected_priority_score)}
              </span>{' '}
              <span style={MONO}>{signed(action.priority_delta)}</span>
            </span>
            <span className="inline-flex items-center gap-1.5">
              <TierChip tier={action.tier_before} />
              <ArrowRight className="h-3 w-3" />
              <TierChip tier={action.tier_after} />
            </span>
            {(climbed || slipped) && (
              <span style={MONO} className={climbed ? 'text-tierLow' : 'text-tierMedium'}>
                queue #{action.rank} → #{action.projected_rank}
              </span>
            )}
          </div>
        </div>
      </header>

      {/* The reasoning is the product. Not a tooltip, not a modal — the same
        * three questions a clinician would ask before signing the order. */}
      <ul className="divide-y divide-line/60 border-t border-line/60 dark:divide-darkBorder/60 dark:border-darkBorder/60">
        {action.rationale.map((r) => (
          <li
            key={r.label}
            className="grid gap-1 px-4 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3 sm:px-5"
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
              {r.label}
            </span>
            <span className="text-[11.5px] leading-relaxed text-ink dark:text-darkText">{r.text}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/*
 * One unattended step, rendered the way the approvable batch renders one.
 *
 * The loop used to print a single condensed line per tick, which left the most
 * important question — "why did it do that?" — unanswerable while it ran. Each
 * row now carries the same three facts a proposal does (which subject, which
 * test, why), plus what the model EXPECTED before acting next to what actually
 * happened, so agreement or surprise is visible on the row itself.
 */
function LoopStep({ step }) {
  const [open, setOpen] = useState(false);
  if (!step) return null;
  const expected = step.expected || {};
  const impact = IMPACT[expected.impact] || (step.result_on_file ? IMPACT.none : IMPACT['order-only']);

  const projected = expected.projected_priority_score;
  const agreed =
    typeof projected === 'number' &&
    typeof step.priority_score_after === 'number' &&
    Math.abs(projected - step.priority_score_after) < 0.005;
  const rankMoved = step.rank_before !== step.rank_after && step.rank_after != null;

  return (
    <li className="overflow-hidden rounded-xl border border-line/70 bg-white/70 dark:border-darkBorder/70 dark:bg-darkCard/70">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-3 pt-2.5">
        <button
          type="button"
          onClick={() => step.rationale?.length && setOpen((o) => !o)}
          className="text-[11.5px] font-bold text-ink underline-offset-2 hover:text-accent dark:text-darkText"
        >
          {step.id}
        </button>
        <span className="text-[10.5px] text-muted dark:text-darkMuted">
          {step.stage_before_name || `Stage ${step.stage_before}`} →{' '}
          {step.stage_after_name || `Stage ${step.stage_after}`}
        </span>
        <Pill tone={impact.tone}>{impact.label}</Pill>
        {step.rationale?.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto text-[10.5px] font-semibold text-accent hover:underline"
          >
            {open ? 'Hide why' : 'Why?'}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 px-3 pb-2.5 pt-1 text-[10.5px] text-muted dark:text-darkMuted">
        <span>
          priority{' '}
          <span style={MONO} className="text-ink dark:text-darkText">
            {fmt(step.priority_score_before)} → {fmt(step.priority_score_after)}
          </span>
        </span>
        <span>
          official{' '}
          <span style={MONO} className="text-ink dark:text-darkText">
            {fmt(step.official_score_before)} → {fmt(step.official_score_after)}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <TierChip tier={step.tier_before || 'low'} />
          <ArrowRight className="h-3 w-3" />
          <TierChip tier={step.tier_after} />
        </span>
        {rankMoved && (
          <span style={MONO} className={step.rank_after < step.rank_before ? 'text-tierLow' : 'text-tierMedium'}>
            queue #{step.rank_before} → #{step.rank_after}
          </span>
        )}
        <span>
          {step.result_on_file
            ? `real ${step.outcome || ''} result incorporated`
            : 'ordered — no result in this cohort, official score held'}
        </span>
        {typeof projected === 'number' && (
          <span className={agreed ? 'text-accent' : 'text-tierMedium'}>
            {agreed ? '✓ as projected' : `projected ${fmt(projected)}`}
            {expected.projected_rank && rankMoved ? ` · #${expected.projected_rank}` : ''}
          </span>
        )}
      </div>

      {open && step.rationale?.length > 0 && (
        <ul className="divide-y divide-line/60 border-t border-line/60 dark:divide-darkBorder/60 dark:border-darkBorder/60">
          {step.rationale.map((r) => (
            <li
              key={r.label}
              className="grid gap-1 px-3 py-2 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3"
            >
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
                {r.label}
              </span>
              <span className="text-[11px] leading-relaxed text-ink dark:text-darkText">{r.text}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/*
 * A dedicated log surface, not an inline list.
 *
 * The rows used to extend the page itself: every step added ~76 px of document
 * height, so the loop visibly pushed the console down while it ran and the
 * document could only ever grow. A log is a fixed viewport onto a stream, so it
 * gets its own bounded scroll region: the page geometry is identical after the
 * first step and after the fiftieth, and reading back through a run is ordinary
 * scrolling instead of hunting up the page.
 *
 * Ordered oldest -> newest like a terminal and auto-following the tail — but
 * only while the reader is already at the bottom, so scrolling up to study a
 * step is never yanked away by the next tick.
 */
const LOG_TAIL_SLACK = 40;

function StepLog({ steps, running, busy }) {
  const bodyRef = useRef(null);
  const followRef = useRef(true);
  const [atTail, setAtTail] = useState(true);

  // `steps` arrives newest-first (the global indicator strip reads [0]); a log
  // reads the other way round.
  const ordered = useMemo(() => [...steps].reverse(), [steps]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [ordered]);

  const onScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    const tail = el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_TAIL_SLACK;
    followRef.current = tail;
    setAtTail(tail);
  };

  const jumpToLatest = () => {
    const el = bodyRef.current;
    followRef.current = true;
    setAtTail(true);
    if (el) el.scrollTop = el.scrollHeight;
  };

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-line/70 bg-tint/60 dark:border-darkBorder/70 dark:bg-darkBg/60">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-line/70 bg-white/70 px-3.5 py-2 dark:border-darkBorder/70 dark:bg-darkCard/70">
        {running ? (
          <>
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-accent" />
            </span>
            <p className="text-[11.5px] font-bold text-accent">Live log</p>
          </>
        ) : (
          <p className="text-[11.5px] font-bold text-ink dark:text-darkText">Run log</p>
        )}
        <span style={MONO} className="text-[10.5px] text-muted dark:text-darkMuted">
          {steps.length} step{steps.length === 1 ? '' : 's'}
        </span>
        {busy && running && <span className="text-[10.5px] font-medium text-accent">working…</span>}
        {steps.length > 0 && (
          <span className="ml-auto hidden text-[10.5px] text-muted dark:text-darkMuted sm:inline">
            oldest → newest · expand a row for its reasoning
          </span>
        )}
      </div>

      {/*
       * Fixed height: the panel is the same size at step 1 and step 50, in the
       * room the side-by-side layout frees up. Deliberately NOT `flex-1` — in a
       * column flex container that sets flex-basis: 0%, which overrides `height`
       * and let the body grow with its content (the whole point being not to).
       */}
      <div
        ref={bodyRef}
        onScroll={onScroll}
        className="h-[24rem] shrink-0 overflow-y-auto p-3 lg:h-[32rem]"
      >
        {ordered.length === 0 ? (
          <p className="px-1 py-8 text-center text-[11px] text-muted dark:text-darkMuted">
            {running ? 'Selecting the first subject…' : 'No steps recorded yet.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {ordered.map((l) => (
              <LoopStep key={l.id} step={l.step} />
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line/70 px-3.5 py-2 dark:border-darkBorder/70">
        <p className="text-[10.5px] text-muted dark:text-darkMuted">
          Every action is also written to the subject&apos;s own audit trail, independent of this view.
        </p>
        {!atTail && ordered.length > 0 && (
          <button
            type="button"
            onClick={jumpToLatest}
            className="shrink-0 text-[10.5px] font-semibold text-accent hover:underline"
          >
            Jump to latest ↓
          </button>
        )}
      </div>
    </div>
  );
}

function Ledger({ result }) {
  if (!result) return null;
  const { executed = [], skipped = [] } = result;

  return (
    <div className={`${PANEL} animate-fade-up overflow-hidden`}>
      <div className="border-b border-line/70 px-5 py-4 dark:border-darkBorder/70">
        <SectionLabel
          size="sm"
          right={
            <div className="flex flex-wrap items-center gap-2.5">
              <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                plan {result.plan_id || '—'}
              </span>
              <Pill tone={executed.length ? 'ok' : 'muted'}>
                {result.executed_count} of {result.approved_count} executed
              </Pill>
            </div>
          }
        >
          Last approved batch
        </SectionLabel>
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <MetricTile label="Executed" value={result.executed_count} hint="steps applied" />
          <MetricTile label="Skipped" value={result.skipped_count} hint="state had moved" />
          <MetricTile label="Queue remaining" value={result.queue_remaining} hint="still awaiting a test" />
          <MetricTile label="Cohort" value={result.total} hint="subjects served" />
        </div>
      </div>
      <div className="px-5 py-4">
        {executed.length > 0 ? (
          <ul className="space-y-2">
            {executed.map((e) => (
              <li
                key={e.patient_id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-line/70 bg-tint/50 px-3 py-2 text-[11px] dark:border-darkBorder/70 dark:bg-darkBorderSubtle"
              >
                <span className="font-bold text-ink dark:text-darkText">{e.patient_id}</span>
                <span className="text-muted dark:text-darkMuted">
                  Stage {e.stage_before} → {e.stage_after} · {e.test}
                </span>
                <span style={MONO} className="text-muted dark:text-darkMuted">
                  priority {fmt(e.priority_score_before)} → {fmt(e.priority_score_after)}
                </span>
                <span style={MONO} className="text-muted dark:text-darkMuted">
                  official {fmt(e.official_score_before)} → {fmt(e.official_score_after)}
                </span>
                <TierChip tier={e.tier_after} />
                {e.rank_before !== e.rank_after && (
                  <span style={MONO} className="text-accent">
                    queue #{e.rank_before} → #{e.rank_after}
                  </span>
                )}
                <span
                  className={`text-[10.5px] ${e.result_on_file ? 'text-accent' : 'text-muted dark:text-darkMuted'}`}
                >
                  {e.result_on_file
                    ? 'real result on file — incorporated'
                    : 'ordered — no result in this cohort, official score unchanged'}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-muted dark:text-darkMuted">
            No subject advanced — every approved action was refused, see the skips below.
          </p>
        )}

        {skipped.length > 0 && (
          <div className="mt-3.5">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-tierMedium">
              {skipped.length} skipped — re-checked against live state
            </p>
            <ul className="mt-1.5 space-y-1">
              {skipped.map((s) => (
                <li key={s.patient_id} className="flex flex-wrap items-baseline gap-x-2 text-[11px]">
                  <Ban className="h-3 w-3 shrink-0 text-tierMedium" />
                  <span className="font-semibold text-ink dark:text-darkText">{s.patient_id}</span>
                  <span className="text-muted dark:text-darkMuted">{s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

export default function AutonomousTriage({
  onOpenPatient,
  onToast,
  onRefresh,
  autopilot,
  onToggleAutopilot,
  autoBusy,
  autoLog,
}) {
  const [limit, setLimit] = useState(8);
  const [plan, setPlan] = useState(null);
  const [planStatus, setPlanStatus] = useState('idle');
  const [planError, setPlanError] = useState('');
  const [approved, setApproved] = useState(() => new Set());
  const [execStatus, setExecStatus] = useState('idle');
  const [execError, setExecError] = useState('');
  const [ledger, setLedger] = useState(null);

  const loadPlan = useCallback(async (size) => {
    setPlanStatus('loading');
    setPlanError('');
    try {
      const next = await api.workupPlan(size);
      setPlan(next);
      // Default to the model's full recommendation; the clinician's job is to
      // refuse what doesn't belong, not to retype what does.
      setApproved(new Set(next.actions.map((a) => a.patient_id)));
      setPlanStatus('ready');
    } catch (err) {
      setPlanError(err.message);
      setPlanStatus('error');
    }
  }, []);

  useEffect(() => {
    loadPlan(limit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadPlan]);

  const toggle = (id) =>
    setApproved((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const actions = plan?.actions ?? [];
  const selected = useMemo(
    () => actions.filter((a) => approved.has(a.patient_id)),
    [actions, approved]
  );
  const allSelected = actions.length > 0 && selected.length === actions.length;

  const execute = async () => {
    if (!selected.length) return;
    setExecStatus('loading');
    setExecError('');
    try {
      const result = await api.workupExecute(
        selected.map((a) => a.patient_id),
        plan?.plan_id
      );
      setLedger(result);
      setExecStatus('ready');
      await onRefresh?.();
      await loadPlan(limit);
      onToast?.(
        'Approved batch executed',
        `${result.executed_count} step${result.executed_count === 1 ? '' : 's'} applied` +
          (result.skipped_count ? ` · ${result.skipped_count} skipped (state moved)` : '') +
          `. Queue ${result.queue_remaining} remaining.`,
        result.executed_count ? 'success' : 'error'
      );
    } catch (err) {
      setExecError(err.message);
      setExecStatus('error');
      onToast?.('Execution failed', err.message, 'error');
    }
  };

  const cohort = plan?.cohort;

  return (
    <div className="space-y-8 animate-fade-up">
      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <SectionLabel>Autonomous Neuro</SectionLabel>
          <h1 className="mt-1 text-lg font-black tracking-tight text-ink dark:text-darkText">
            Approval-gated cohort workup
          </h1>
          <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-muted dark:text-darkMuted">
            The model ranks the cohort and proposes the next batch of tests with its reasoning.
            Proposals are computed on{' '}
            <span className="font-semibold text-ink dark:text-darkText">copies of the record</span>, so
            reading a plan cannot order anything — tests are ordered only for the subjects a clinician
            approves.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={`${API_BASE}/docs`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-[11px] font-semibold text-ink dark:text-darkText"
          >
            OpenAPI <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
          <a
            href={`${API_BASE}/model/info`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-[11px] font-semibold text-ink dark:text-darkText"
          >
            <Layers className="h-3.5 w-3.5" /> Model card
            <ExternalLink className="h-3 w-3 opacity-60" />
          </a>
        </div>
      </div>

      {/* ── Cohort ribbon: one panel instead of four competing cards ──── */}
      {cohort && (
        <div
          className={`${PANEL} divide-y divide-line dark:divide-darkBorder sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4`}
        >
          <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
            <RibbonStat
              icon={Users}
              label="Awaiting workup"
              value={(cohort.awaiting_workup ?? 0).toLocaleString()}
              tone="accent"
              hint={`of ${(cohort.total ?? 0).toLocaleString()} subjects served`}
            />
          </div>
          <div className="lg:border-r lg:border-line dark:lg:border-darkBorder">
            <RibbonStat
              icon={CheckCircle2}
              label="Pathway complete"
              value={(cohort.complete ?? 0).toLocaleString()}
              tone="ok"
              hint="Stage 4 reached"
            />
          </div>
          <div className="sm:border-r sm:border-line dark:sm:border-darkBorder">
            <RibbonStat
              icon={AlertTriangle}
              label="High tier"
              value={(cohort.tier_counts?.high ?? 0).toLocaleString()}
              tone="bad"
              hint="Corroborated by a biomarker"
            />
          </div>
          <div>
            <RibbonStat
              icon={Activity}
              label="Medium / low"
              value={`${(cohort.tier_counts?.medium ?? 0).toLocaleString()} / ${(cohort.tier_counts?.low ?? 0).toLocaleString()}`}
              tone="muted"
              hint="Cognition-led, awaiting confirmation"
            />
          </div>
        </div>
      )}

      {/* ── Pipeline position: a quiet one-liner, not a headline ─────── */}
      {cohort && (
        <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 text-[10.5px] text-dust dark:text-darkMuted">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
            Pipeline position
          </span>
          {STAGE_LABELS.map((label, i) => {
            const count = cohort.stage_counts?.[String(i + 1)] ?? 0;
            const share = cohort.total ? Math.round((count / cohort.total) * 100) : 0;
            return (
              <span key={label} className="flex items-baseline gap-1.5">
                <span style={MONO} className="text-[9px]">
                  0{i + 1}
                </span>
                {label}
                <span style={MONO} className="font-semibold text-muted dark:text-darkMuted">
                  {count.toLocaleString()}
                </span>
                <span>({share}%)</span>
              </span>
            );
          })}
          <span className="ml-auto">
            {(cohort.awaiting_workup ?? 0).toLocaleString()} awaiting a test
          </span>
        </p>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Proposed batch                                                    */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-4">
        <SectionLabel
          right={
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-0.5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard p-0.5">
                {BATCH_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    title={`Propose ${size} actions`}
                    onClick={() => {
                      setLimit(size);
                      loadPlan(size);
                    }}
                    style={MONO}
                    className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold transition ${
                      limit === size
                        ? 'bg-accent text-white shadow-soft'
                        : 'text-muted hover:text-ink dark:text-darkMuted dark:hover:text-darkText'
                    }`}
                  >
                    {size}
                  </button>
                ))}
              </div>
              <Btn tone="quiet" onClick={() => loadPlan(limit)} disabled={planStatus === 'loading'}>
                {planStatus === 'loading' ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Re-plan
              </Btn>
            </div>
          }
        >
          Proposed next batch
        </SectionLabel>

        <p className="text-[12px] leading-relaxed text-muted dark:text-darkMuted">
          The model walks the live priority queue from the top and projects each candidate&apos;s next
          indicated test — including what it expects the re-score to do. Deselect anything you disagree
          with; only the approved subjects are acted on.
        </p>

        {planStatus === 'error' && (
          <div className="flex items-center gap-2.5 rounded-2xl border border-tierHigh/35 bg-tierHigh/5 px-4 py-3">
            <AlertCircle className="h-4 w-4 text-tierHigh" />
            <p className="text-[12px] text-ink dark:text-darkText">{planError}</p>
          </div>
        )}

        {planStatus === 'loading' && !plan && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-28 animate-pulse rounded-2xl bg-line dark:bg-darkBorder" />
            ))}
          </div>
        )}

        {planStatus !== 'loading' && plan && actions.length === 0 && (
          <div className="rounded-2xl border border-line/70 bg-white/60 px-5 py-6 text-center dark:border-darkBorder/70 dark:bg-darkCard/60">
            <CheckCircle2 className="mx-auto h-6 w-6 text-tierLow" />
            <p className="mt-2 text-[12.5px] font-semibold text-ink dark:text-darkText">
              Nothing to propose
            </p>
            <p className="mx-auto mt-1 max-w-lg text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
              {plan.reason}
            </p>
          </div>
        )}

        {actions.length > 0 && (
          <>
            {plan && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-y border-line/50 px-1 py-2 text-[11px] text-muted dark:border-darkBorder/50 dark:text-darkMuted">
                <span style={MONO} className="font-semibold text-ink/80 dark:text-darkText/80">
                  {plan.summary.proposed} proposed
                </span>
                <span>· {plan.summary.no_cost} no-cost</span>
                <span>· {plan.summary.orders_only} order-only</span>
                <span>
                  · {plan.summary.reclassifications} tier change
                  {plan.summary.reclassifications === 1 ? '' : 's'}
                </span>
                <span
                  className="ml-auto flex items-center gap-1.5 text-[10.5px] text-dust dark:text-darkMuted"
                  title={`Nothing is written by planning. Plan ${plan.plan_id}, generated ${plan.generated_at}.`}
                >
                  <ShieldCheck className="h-3 w-3 shrink-0" /> read-only plan {plan.plan_id}
                </span>
              </div>
            )}

            <div className="space-y-3">
              {actions.map((a, i) => (
                <Proposal
                  key={a.patient_id}
                  action={a}
                  isTop={i === 0}
                  approved={approved.has(a.patient_id)}
                  onToggle={() => toggle(a.patient_id)}
                  onOpenPatient={onOpenPatient}
                />
              ))}
            </div>

            {/* Approval gate */}
            <div className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line dark:border-darkBorder bg-white/95 dark:bg-darkCard/95 px-4 py-3 shadow-lift backdrop-blur-xl">
              <div className="flex items-center gap-3">
                <Pill tone={selected.length ? 'accent' : 'muted'}>
                  {selected.length} of {actions.length} approved
                </Pill>
                <button
                  type="button"
                  onClick={() =>
                    setApproved(allSelected ? new Set() : new Set(actions.map((a) => a.patient_id)))
                  }
                  className="text-[11px] font-semibold text-accent hover:underline"
                >
                  {allSelected ? 'Clear all' : 'Select all'}
                </button>
              </div>

              <div className="flex items-center gap-2.5">
                {execError && (
                  <span className="max-w-xs truncate text-[11px] text-tierHigh" title={execError}>
                    {execError}
                  </span>
                )}
                <Btn
                  tone="primary"
                  onClick={execute}
                  disabled={!selected.length || execStatus === 'loading'}
                  className="px-4 py-2.5 text-[12px]"
                >
                  {execStatus === 'loading' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Approve &amp; execute{selected.length ? ` ${selected.length}` : ''}
                </Btn>
              </div>
            </div>
          </>
        )}

        <Ledger result={ledger} />
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Supervised instant mode (the ungated mode, kept available)        */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-4">
        <SectionLabel
          right={
            <div className="flex flex-wrap items-center gap-2.5">
              <code style={MONO} className="text-[10px] text-muted dark:text-darkMuted">
                POST /workup/next
              </code>
              {autopilot ? (
                <Pill tone="accent">working the queue</Pill>
              ) : autoLog?.length ? (
                <Pill tone="muted">last run · {autoLog.length} steps</Pill>
              ) : null}
            </div>
          }
        >
          Supervised instant mode
        </SectionLabel>

        {/*
         * Two columns: the explanation and its single control on the left, the
         * log on the right taking the full height. Side-by-side is what makes
         * the run legible — the log gets real vertical room instead of a few
         * hundred pixels squeezed under the copy, and the control stays visible
         * next to the stream it drives.
         */}
        <div className={PANEL_PAD}>
          <div className="grid gap-5 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <p className="text-[12.5px] font-semibold text-ink dark:text-darkText">
                Step the queue continuously, one subject at a time
              </p>
              <p className="text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
                The same policy as the batch above, without the approval gate: the model picks the
                highest-priority subject, runs its next indicated test, re-scores and re-ranks. Use the
                batch flow when a decision needs a human signature; use this to watch the policy work.
              </p>
              <p className="text-[11px] text-muted dark:text-darkMuted">
                The cohort updates in place — the page does not re-render underneath you. Stop from the
                header, from the button here, or with{' '}
                <kbd className="rounded border border-line bg-tint px-1.5 py-0.5 font-semibold dark:border-darkBorder dark:bg-darkBorderSubtle">
                  Esc
                </kbd>
                .
              </p>

              <Btn
                tone={autopilot ? 'danger' : 'primary'}
                icon={autopilot ? Square : Play}
                onClick={onToggleAutopilot}
                disabled={autoBusy && !autopilot}
                className="w-full py-2.5 text-[12px]"
              >
                {autopilot ? 'Stop run (Esc)' : 'Start run'}
              </Btn>

              <div className="rounded-xl border border-line/70 bg-tint/50 px-3 py-2.5 dark:border-darkBorder/70 dark:bg-darkBorderSubtle/50">
                <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
                  Reading the log
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted dark:text-darkMuted">
                  One row per step, oldest first: the subject and its rank, the stage transition,
                  priority and official score before → after, the test, and what the model
                  <span className="font-semibold text-ink dark:text-darkText"> projected before acting</span>{' '}
                  beside what actually happened. Expand any row for the full reasoning.
                </p>
              </div>
            </div>

            {/*
             * The log panel is always mounted, on both sides of a run. It used
             * to appear only while `autopilot` was true, so pressing Stop threw
             * away the evidence of what had just run. Its height is fixed, so the
             * page geometry is identical at step 1 and step 50.
             */}
            <StepLog steps={autoLog || []} running={autopilot} busy={autoBusy} />
          </div>
        </div>
      </section>
    </div>
  );
}
