import { useMemo } from 'react';
import { MONO, SectionLabel, StageIcon, STAGE_FILLS, TIER_HEX, useEnterProgress } from './widgets.jsx';
import { STAGES_SHORT } from '../lib.js';

/*
 * Where this cohort sits — one compact strip, and the way into the list.
 *
 * This replaces two full panels that together took 561px, which pushed the first
 * patient row 76px BELOW the fold: the page's purpose (a queue) was off screen
 * behind a summary of the queue. Everything that mattered survives at roughly a
 * third of the height, and two things improve on the way:
 *
 *   1. ONE HOME PER NUMBER. The tier and stage counts are on the filter cards in
 *      the page header; repeating them here made every figure appear twice, 700px
 *      apart. This strip states SHARES only — the shape is the point of a
 *      composition graphic, and the counts are one click away on the cards.
 *
 *   2. IT IS THE FILTER. The panels used to describe the cohort while a separate
 *      row of near-identical cards filtered it. Here the segments ARE the list's
 *      filter: click a tier slice or a stage band and the list narrows. Click it
 *      again to clear.
 *
 * Arc lengths, band lengths and the entrance animation all come from the shared
 * primitives, so this strip moves in step with the rest of the application.
 */

const SIZE = 138;
const R = 54;
const SW = 16;
const GAP = 5;
const C = SIZE / 2;
const CIRC = 2 * Math.PI * R;

const lighten = (hex, amt = 0.32) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c) => Math.round(c + (255 - c) * amt);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
};

const TIERS = [
  { key: 'high', label: 'High', hex: TIER_HEX.high },
  { key: 'medium', label: 'Medium', hex: TIER_HEX.medium },
  { key: 'low', label: 'Low', hex: TIER_HEX.low },
];

export default function CohortComposition({
  patients = [],
  tierFilter = 'all',
  stageFilter = 0,
  onSelectTier,
  onSelectStage,
}) {
  const t = useEnterProgress();

  const { total, tiers, stages, elevated } = useMemo(() => {
    const n = patients.length;
    const countOf = (key) => patients.filter((p) => p.risk_tier === key).length;
    const pctOf = (c) => (n ? (c / n) * 100 : 0);

    const tierRows = TIERS.map((x) => ({ ...x, count: countOf(x.key), pct: pctOf(countOf(x.key)) }));

    const stageRows = [1, 2, 3, 4].map((s) => {
      const rows = patients.filter((p) => p.stage === s);
      const count = rows.length;
      return {
        stage: s,
        short: STAGES_SHORT[s - 1] ?? `Stage ${s}`,
        count,
        pct: pctOf(count),
        avg: count ? rows.reduce((sum, p) => sum + (p.final_score ?? p.score), 0) / count : 0,
        hex: STAGE_FILLS[s - 1] || '#0D8282',
      };
    });

    const peak = Math.max(...stageRows.map((s) => s.count), 1);

    return {
      total: n,
      tiers: tierRows,
      stages: stageRows.map((s) => ({ ...s, rel: Math.max((s.count / peak) * 100, s.count ? 4 : 0) })),
      elevated: pctOf(countOf('high') + countOf('medium')),
    };
  }, [patients]);

  // ring arcs, walked so each segment starts where the last ended
  let walked = 0;
  const arcs = tiers.map((x) => {
    const arc = { ...x, len: Math.max((x.pct / 100) * CIRC, 5), offset: walked };
    walked += arc.len;
    return arc;
  });

  const toggleTier = (key) => onSelectTier?.(tierFilter === key ? null : key);
  const toggleStage = (s) => onSelectStage?.(stageFilter === s ? 0 : s);

  return (
    <section>
      <SectionLabel
        right={
          <span className="text-[10.5px] text-muted dark:text-darkMuted">
            click a slice or a band to filter the list below
          </span>
        }
      >
        Where this cohort sits
      </SectionLabel>

      <div className="mt-4 flex flex-col gap-6 lg:flex-row lg:items-center lg:gap-9">
        {/* -------------------------------------------------------------- ring */}
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -inset-4 rounded-full opacity-75 blur-2xl"
            style={{
              background: `radial-gradient(circle at 30% 24%, ${TIER_HEX.low}55, transparent 62%), radial-gradient(circle at 78% 80%, ${TIER_HEX.high}44, transparent 58%)`,
            }}
          />
          <svg
            viewBox={`0 0 ${SIZE} ${SIZE}`}
            className="relative h-full w-full -rotate-90"
            style={{ filter: 'drop-shadow(0 6px 14px rgba(13,130,130,0.2))' }}
          >
            <defs>
              {tiers.map((x) => (
                <linearGradient key={x.key} id={`cc-${x.key}`} x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={lighten(x.hex, 0.45)} />
                  <stop offset="60%" stopColor={x.hex} />
                  <stop offset="100%" stopColor={lighten(x.hex, -0.14)} />
                </linearGradient>
              ))}
            </defs>
            <circle cx={C} cy={C} r={R} fill="none" strokeWidth={SW} className="stroke-line/45 dark:stroke-darkBorder/55" />
            {arcs.map((a) => {
              const dim = tierFilter !== 'all' && tierFilter !== a.key;
              return (
                <circle
                  key={a.key}
                  cx={C}
                  cy={C}
                  r={R}
                  fill="none"
                  stroke={`url(#cc-${a.key})`}
                  strokeWidth={SW}
                  strokeOpacity={dim ? 0.35 : 1}
                  strokeDasharray={`${Math.max(a.len * t - GAP, 0)} ${CIRC - Math.max(a.len * t - GAP, 0)}`}
                  strokeDashoffset={-(a.offset * t)}
                  style={{ transition: 'stroke-opacity 200ms ease' }}
                />
              );
            })}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <p style={MONO} className="text-[24px] font-black leading-none tabular-nums text-accent">
              {Math.round(elevated * t)}%
            </p>
            <p className="mt-1 text-[8.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">
              elevated
            </p>
          </div>
        </div>

        {/* -------------------------------------------- tiers, then stage bands */}
        <div className="min-w-0 flex-1">
          {/* one continuous measure; each slice filters for its own tier */}
          <div className="flex h-3.5 w-full overflow-hidden rounded-full bg-line/30 ring-1 ring-inset ring-black/[0.04] dark:bg-darkBorder/40 dark:ring-white/[0.05]">
            {tiers.map((x) => {
              const dim = tierFilter !== 'all' && tierFilter !== x.key;
              return (
                <button
                  key={x.key}
                  type="button"
                  onClick={() => toggleTier(x.key)}
                  title={`${x.label} priority — ${x.count.toLocaleString()} subjects (${x.pct.toFixed(0)}%)`}
                  className="h-full transition-opacity duration-200 hover:opacity-100"
                  style={{
                    width: `${x.pct * t}%`,
                    opacity: dim ? 0.3 : 1,
                    background: `linear-gradient(180deg, ${lighten(x.hex, 0.35)}, ${x.hex})`,
                  }}
                />
              );
            })}
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            {tiers.map((x) => {
              const on = tierFilter === x.key;
              return (
                <button
                  key={x.key}
                  type="button"
                  onClick={() => toggleTier(x.key)}
                  className={`flex items-center gap-1.5 rounded-lg px-1.5 py-0.5 text-[10.5px] font-semibold transition ${
                    on ? 'bg-accent/10 text-accent' : 'text-muted hover:text-ink dark:text-darkMuted dark:hover:text-darkText'
                  }`}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: x.hex }} />
                  {x.label}
                  <span style={MONO} className="font-bold tabular-nums">
                    {x.pct.toFixed(0)}%
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 space-y-2">
            {stages.map((s) => {
              const on = stageFilter === s.stage;
              const dim = stageFilter !== 0 && !on;
              return (
                <button
                  key={s.stage}
                  type="button"
                  onClick={() => toggleStage(s.stage)}
                  title={`Stage ${s.stage} — ${s.short}: ${s.count.toLocaleString()} subjects (${s.pct.toFixed(0)}%), average priority ${s.avg.toFixed(2)}`}
                  className={`grid w-full grid-cols-[104px_1fr_40px] items-center gap-3 rounded-lg py-0.5 text-left transition-opacity duration-200 ${
                    dim ? 'opacity-45' : 'opacity-100'
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border"
                      style={{ background: on ? `${s.hex}26` : `${s.hex}14`, borderColor: on ? `${s.hex}66` : `${s.hex}30` }}
                    >
                      <StageIcon stage={s.stage} hex={s.hex} />
                    </span>
                    <span className="truncate text-[11px] font-semibold text-ink dark:text-darkText">{s.short}</span>
                  </span>

                  <span className="relative h-3.5 w-full overflow-hidden rounded-full bg-line/25 dark:bg-darkBorder/40">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${s.rel * t}%`,
                        background: `linear-gradient(100deg, ${lighten(s.hex, 0.38)} 0%, ${s.hex} 70%)`,
                        boxShadow: `0 4px 12px -6px ${s.hex}99, inset 0 1px 0 rgba(255,255,255,0.3)`,
                      }}
                    />
                  </span>

                  <span style={MONO} className="text-right text-[10.5px] font-bold tabular-nums text-muted dark:text-darkMuted">
                    {Math.round(s.pct * t)}%
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
