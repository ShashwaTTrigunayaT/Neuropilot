import { useMemo } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Gauge,
  ShieldCheck,
  Siren,
  Users,
} from 'lucide-react';
import FeatureRadarChart from './FeatureRadarChart.jsx';
import RiskDistributionChart from './RiskDistributionChart.jsx';
import StageProgressionChart from './StageProgressionChart.jsx';
import {
  Btn,
  JOINED_GRID,
  MONO,
  PANEL,
  PatientTable,
  Pill,
  RibbonStat,
  SectionLabel,
  TIER_HEX,
} from './widgets.jsx';
import { fmtScore } from '../lib.js';

const SHORTLIST_SIZE = 8;
const TIER_RANK = { high: 0, medium: 1, low: 2 };
const STAGE_ORDER = ['1', '2', '3', '4'];

const auc = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');

export default function Overview({
  patients,
  modelInfo = null,
  onSelect,
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

  // Priority list: tier FIRST, then score inside a tier. A patient whose score is
  // high but whose tier is capped (no biomarker on file yet -- "awaiting
  // confirmation") must not lead a list labelled "Top Priority", or the ordering
  // contradicts the tier printed next to it.
  const shortlist = useMemo(
    () => [...patients]
      .sort((a, b) => (
        (TIER_RANK[a.risk_tier] ?? 3) - (TIER_RANK[b.risk_tier] ?? 3) || (b.final_score ?? b.score) - (a.final_score ?? a.score)
      ))
      .slice(0, SHORTLIST_SIZE),
    [patients]
  );

  const total = patients.length;
  const elevated = counts.high + counts.medium;
  const elevatedPct = total ? Math.round((elevated / total) * 100) : 0;

  // Attribution of the model the API actually serves, read straight from its
  // card -- so this panel can never describe a different model family than the
  // one producing the scores on the page.
  const servedImportance = modelInfo?.global_importance || [];
  const featureCount = modelInfo?.features?.length || servedImportance.length;
  const stageShare = STAGE_ORDER
    .map((k) => modelInfo?.stage_importance?.[k])
    .filter((s) => s && typeof s.share_pct === 'number');

  return (
    <div className="space-y-11 animate-fade-up">
      {/* ---------------------------------------------------------------- */}
      {/* Hero: what this is and what it is for                             */}
      {/* ---------------------------------------------------------------- */}
      <section className={`${PANEL} relative overflow-hidden`}>
        <div
          className="pointer-events-none absolute inset-x-0 -top-24 h-56"
          style={{ background: 'radial-gradient(55% 100% at 50% 0%, rgba(13,130,130,0.14), transparent 72%)' }}
        />
        <div className="relative p-7 lg:p-9">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="accent">
              <Activity className="h-3 w-3" /> Cohort overview
            </Pill>
            <Pill tone="muted">
              <ShieldCheck className="h-3 w-3" /> Decision support · non-diagnostic
            </Pill>
          </div>

          <h1 className="mt-5 max-w-3xl text-[31px] font-black leading-[1.08] tracking-tight text-ink dark:text-darkText sm:text-[40px]">
            Who needs the next test — and why.
          </h1>

          <p className="mt-4 max-w-2xl text-[13.5px] leading-relaxed text-muted dark:text-darkMuted">
            NeuroPilot ranks the cohort by refined progression risk across the four diagnostic
            stages — cognition, blood biomarkers, MRI volumetrics and PET — and explains every
            point of the score. Specialists work a ranked queue instead of re-reading charts, and
            each subject carries the evidence behind its position.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-2.5">
            <Btn tone="primary" onClick={onShowAll} className="px-4 py-2.5 text-[12px]">
              Review the priority queue
              <ArrowRight className="h-3.5 w-3.5" />
            </Btn>
            {onViewChange && (
              <Btn tone="ghost" onClick={() => onViewChange('autonomous')} className="px-4 py-2.5 text-[12px]">
                Autonomous Neuro
              </Btn>
            )}
            {onOpenSimulator && (
              <Btn tone="quiet" onClick={onOpenSimulator} className="px-4 py-2.5 text-[12px]">
                Risk simulator
              </Btn>
            )}
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Cohort at a glance: one ribbon, five cells, hairline dividers     */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-3">
        <SectionLabel
          right={
            <span className="text-[11px] text-muted dark:text-darkMuted">
              <strong style={MONO} className="font-semibold text-ink dark:text-darkText">{elevatedPct}%</strong> elevated
            </span>
          }
        >
          Cohort at a glance
        </SectionLabel>

        <div className={`${JOINED_GRID} sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5`}>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat
              icon={Users}
              label="Subjects"
              value={total.toLocaleString()}
              hint="scored by the refined model"
            />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat
              icon={Siren}
              label="High priority"
              value={counts.high.toLocaleString()}
              tone="bad"
              hint="biomarker evidence on file"
            />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat
              icon={AlertCircle}
              label="Medium"
              value={counts.medium.toLocaleString()}
              tone="warn"
              hint="awaiting the next stage"
            />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat
              icon={CheckCircle2}
              label="Low"
              value={counts.low.toLocaleString()}
              tone="ok"
              hint="stable on current evidence"
            />
          </div>
          <div className="bg-white dark:bg-darkCard">
            <RibbonStat
              icon={Gauge}
              label="Mean refined risk"
              value={fmtScore(meanRisk)}
              tone="accent"
              hint="cohort average, 0–1"
            />
          </div>
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Analytics: the two charts, untrapped, sharing a row               */}
      {/* ---------------------------------------------------------------- */}
      <section className="border-t border-line pt-8 dark:border-darkBorder">
        <div className="grid items-stretch gap-10 lg:grid-cols-2">
          <RiskDistributionChart patients={patients} />
          <StageProgressionChart patients={patients} />
        </div>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Feature attribution, straight from the served card                */}
      {/* ---------------------------------------------------------------- */}
      {servedImportance.length > 0 && (
        <section className="space-y-4 border-t border-line pt-8 dark:border-darkBorder">
          <SectionLabel
            right={
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone="muted">{featureCount} features</Pill>
                <Pill tone="accent">{auc(modelInfo?.test_auc)} AUROC</Pill>
              </div>
            }
          >
            {modelInfo?.label || 'Refined model'} — feature attribution
          </SectionLabel>

          <FeatureRadarChart data={servedImportance} />

          {/* Per-stage share of attribution: the same weighting the score was
              built from, aggregated to the stage a clinician can order. */}
          {stageShare.length > 0 && (
            <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-1 text-[10.5px] text-dust dark:text-darkMuted">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em]">
                Stage share of attribution
              </span>
              {stageShare.map((s, i) => (
                <span key={s.name || i} className="flex items-baseline gap-1.5">
                  <span style={MONO} className="text-[9px]">0{i + 1}</span>
                  {s.name}
                  <span style={MONO} className="font-semibold text-muted dark:text-darkMuted">
                    {s.share_pct}%
                  </span>
                </span>
              ))}
            </p>
          )}
        </section>
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Priority shortlist                                                */}
      {/* ---------------------------------------------------------------- */}
      <section className="space-y-4 border-t border-line pt-8 dark:border-darkBorder">
        <SectionLabel
          right={
            <Btn tone="quiet" onClick={onShowAll}>
              View all {total.toLocaleString()}
              <ArrowRight className="h-3.5 w-3.5" />
            </Btn>
          }
        >
          Top priority patients
        </SectionLabel>

        <p className="text-[11.5px] leading-relaxed text-muted dark:text-darkMuted">
          Ordered by tier first, then by refined score — so the tier printed beside a subject always
          matches its position.{' '}
          <strong style={{ ...MONO, color: TIER_HEX.high }} className="font-semibold">
            {counts.high.toLocaleString()}
          </strong>{' '}
          in High tier.
        </p>

        <div className={`${PANEL} overflow-hidden`}>
          {shortlist.length === 0 ? (
            <p className="px-5 py-16 text-center text-xs text-muted dark:text-darkMuted">No patients loaded.</p>
          ) : (
            <PatientTable rows={shortlist} compact onSelect={onSelect} />
          )}
        </div>
      </section>
    </div>
  );
}
