import { useMemo, useState } from 'react';
import { MONO, SectionLabel, StageIcon, STAGE_FILLS, useEnterProgress } from './widgets.jsx';
import { STAGES_SHORT } from '../lib.js';

/*
 * Where this cohort sits — one stacked column chart: stage load, split by priority.
 *
 * This replaces two full panels that together took 561px, which pushed the first
 * patient row 76px BELOW the fold: the page's purpose (a queue) was off screen
 * behind a summary of the queue.
 *
 * It also replaces the two separate charts that followed those panels (a ring for
 * priority mix, four bars for stage load), and the mosaic that briefly replaced
 * them in turn. The mosaic was the wrong shape for this data: half the
 * stage × tier pairs are almost empty (two Blood subjects are High priority), and
 * a joint count that small collapses to a two-pixel tile — which reads as a
 * rendering fault rather than as a fact. A stacked column says the same thing the
 * way a bar chart always does: a thin band means "almost none", which is true.
 *
 *   COLUMN HEIGHT = the stage's size, against the largest stage.
 *   BANDS         = its priority mix, worst at the top, in tier colours.
 *   The empty cap = the story. Cognitive is the biggest column by far and has no
 *   High band at all, because a cognitive score alone caps at Medium; the red
 *   that does exist sits on top of PET.
 *
 * ONE HOME PER NUMBER. Counts live on the filter cards in the page header, so
 * every figure on this chart is a share: of the cohort on the legend and the
 * column labels, of the largest stage on the axis. Joint counts are in the
 * tooltip, where they cost no ink.
 *
 * IT IS THE FILTER. A band is the most specific thing here, so clicking one
 * filters to that stage AND that tier; a column label filters the stage alone,
 * and the legend filters the tier alone. Click again to clear.
 */

const PLOT_H = 168; // the plot height — one number governs the whole chart
const COL_W = 76; // column width — the page shows one chart, so it can carry the width
const HEAD = 0.82; // the tallest column stops short of the top, leaving room for its label
const AXIS_TICKS = [100, 75, 50, 25, 0]; // % of the largest stage

// a tick's height, with the same headroom the columns keep
const yPct = (v) => 100 - v * HEAD;

const lighten = (hex, amt = 0.32) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c) => Math.round(Math.min(255, Math.max(0, c + (255 - c) * amt)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
};

// each band is lit from the top, so the stack has a light source
const BAND_FILL = (hex) => `linear-gradient(180deg, ${lighten(hex, 0.22)} 0%, ${hex} 52%, ${lighten(hex, -0.12)} 100%)`;

/*
 * The chart's own palette: purple, fuchsia, pink — one family, darkest = most
 * urgent. The red / amber / green tier colours are the app's risk language and
 * still mark risk everywhere else (tags, dots, the header cards); on this chart
 * they read as a traffic light, which fights the shape. Depth in a single family
 * carries the same ranking — the deepest band is the one to act on — and lets the
 * columns read as one object.
 */
const PURPLE = '#6D28D9'; // deep — High
const TIERS = [
  { key: 'high', label: 'High', hex: PURPLE },
  { key: 'medium', label: 'Medium', hex: '#C026D3' }, // fuchsia
  { key: 'low', label: 'Low', hex: '#F472B6' }, // pink
];

const GROUP_LABEL = 'text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted dark:text-darkMuted';

export default function CohortComposition({
  patients = [],
  tierFilter = 'all',
  stageFilter = 0,
  onSelectTier,
  onSelectStage,
}) {
  const t = useEnterProgress();
  const [hover, setHover] = useState(null); // the readout that replaces the group label while reading

  const { columns, tierTotals } = useMemo(() => {
    const n = Math.max(patients.length, 1);
    const pct = (c) => (c / n) * 100;

    const raw = [1, 2, 3, 4].map((s) => {
      const rows = patients.filter((p) => p.stage === s);
      const count = rows.length;
      return {
        stage: s,
        short: STAGES_SHORT[s - 1] ?? `Stage ${s}`,
        hex: STAGE_FILLS[s - 1] || '#0D8282',
        count,
        share: pct(count),
        tiers: TIERS.map((x) => {
          const c = rows.filter((p) => p.risk_tier === x.key).length;
          return { ...x, count: c, within: count ? (c / count) * 100 : 0, cohort: pct(c) };
        }),
      };
    });

    const peak = Math.max(...raw.map((c) => c.count), 1);

    return {
      columns: raw.map((c) => ({ ...c, rel: (c.count / peak) * 100 })),
      tierTotals: TIERS.map((x) => {
        const c = patients.filter((p) => p.risk_tier === x.key).length;
        return { ...x, count: c, share: pct(c) };
      }),
    };
  }, [patients]);

  const toggleTier = (key) => onSelectTier?.(tierFilter === key ? null : key);
  const toggleStage = (s) => onSelectStage?.(stageFilter === s ? 0 : s);

  const selectBoth = (tier, stage) => {
    const bothOn = tierFilter === tier && stageFilter === stage;
    onSelectTier?.(bothOn ? null : tier);
    onSelectStage?.(bothOn ? 0 : stage);
  };

  return (
    <section>
      <SectionLabel
        right={
          <span className="text-[10.5px] text-muted dark:text-darkMuted">
            click a band, a column or the legend to filter the list below
          </span>
        }
      >
        Where this cohort sits
      </SectionLabel>

      {/* the legend IS the tier filter, and it states each tier's share of the cohort */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        {hover ? (
          <p className="flex items-center gap-2 text-[11.5px] font-semibold text-ink dark:text-darkText">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: hover.hex }} />
            {hover.tier} priority · {hover.short}
            <span style={MONO} className="font-bold tabular-nums text-muted dark:text-darkMuted">
              {hover.count.toLocaleString()} subjects
            </span>
          </p>
        ) : (
          <p className={GROUP_LABEL}>
            Priority mix by stage
            <span className="ml-2 font-medium normal-case tracking-normal text-dust dark:text-darkMuted">
              column height = share of the largest stage
            </span>
          </p>
        )}

        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          {tierTotals.map((x) => {
            const on = tierFilter === x.key;
            const dim = tierFilter !== 'all' && !on;
            return (
              <button
                key={x.key}
                type="button"
                onClick={() => toggleTier(x.key)}
                title={`${x.label} priority — ${x.count.toLocaleString()} subjects (${x.share.toFixed(0)}%)`}
                className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold transition ${
                  on
                    ? 'bg-accent/10 text-accent'
                    : 'text-muted hover:text-ink dark:text-darkMuted dark:hover:text-darkText'
                } ${dim ? 'opacity-45' : 'opacity-100'}`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full"
                  style={{
                    background: `radial-gradient(circle at 32% 28%, ${lighten(x.hex, 0.5)}, ${x.hex} 62%, ${lighten(x.hex, -0.28)})`,
                    boxShadow: `0 1px 2px ${x.hex}55`,
                  }}
                />
                {x.label}
                <span style={MONO} className="font-bold tabular-nums">
                  {Math.round(x.share * t)}%
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* ================================================= the columns ==== */}
      <div className="mt-2.5 flex gap-3">
        {/* the axis: how tall a column is, as a share of the largest stage */}
        <div className="relative w-9 shrink-0" style={{ height: PLOT_H }}>
          {AXIS_TICKS.map((v) => (
            <span
              key={v}
              className="absolute right-0 flex -translate-y-1/2 items-center gap-1"
              style={{ top: `${yPct(v)}%` }}
            >
              <span style={MONO} className="text-[10.5px] tabular-nums text-dust dark:text-darkMuted">
                {v}
              </span>
              <span className="h-px w-2 bg-line dark:bg-darkBorder" />
            </span>
          ))}
        </div>

        <div className="min-w-0 flex-1">
          <div className="relative" style={{ height: PLOT_H }}>
            {/* the page has one chart now, so it gets the light: a violet-to-pink
                floor wash behind the columns, the only one on the page */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -inset-x-8 -top-8 bottom-0 bg-[radial-gradient(62%_72%_at_50%_102%,rgba(109,40,217,0.11),rgba(236,72,153,0.07)_52%,transparent_80%)] dark:bg-[radial-gradient(62%_72%_at_50%_102%,rgba(139,92,246,0.2),rgba(236,72,153,0.12)_52%,transparent_80%)]"
            />

            {/* the scale, drawn behind the columns */}
            {AXIS_TICKS.map((v) => (
              <span
                key={v}
                aria-hidden="true"
                className={`pointer-events-none absolute inset-x-0 border-t ${
                  v === 0 ? 'border-line dark:border-darkBorder' : 'border-dashed border-line/70 dark:border-darkBorder/60'
                }`}
                style={{ top: `${yPct(v)}%` }}
              />
            ))}

            <div className="absolute inset-0 flex items-end">
              {columns.map((col) => {
                const colDim = stageFilter !== 0 && stageFilter !== col.stage;
                return (
                  // h-full matters: the column's own % height has no definite parent otherwise
                  <div key={col.stage} className="relative flex h-full flex-1 items-end justify-center">
                    {/* the light the column stands in, spilled onto the page */}
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute bottom-0 left-1/2 rounded-[50%] blur-md"
                      style={{
                        width: COL_W + 26,
                        height: 14,
                        background: `radial-gradient(closest-side, ${PURPLE}4d, transparent 74%)`,
                        transform: 'translateX(-50%) translateY(7px)',
                        opacity: colDim ? 0.3 : 1,
                      }}
                    />

                    {/* the column's own value, above its cap — ink, so it does not read as a fourth band */}
                    <span
                      className="absolute inset-x-0 text-center leading-none"
                      style={{ bottom: `calc(${col.rel * HEAD}% + 4px)`, opacity: colDim ? 0.4 : 1 }}
                    >
                      <span
                        style={MONO}
                        className="text-[13.5px] font-black tabular-nums text-ink dark:text-darkText"
                      >
                        {Math.round(col.share * t)}%
                      </span>
                    </span>

                    <div
                      className="relative flex w-full flex-col overflow-hidden rounded-[10px] ring-1 ring-inset ring-black/[0.07] transition-transform duration-300 hover:-translate-y-0.5 dark:ring-white/[0.08]"
                      style={{
                        maxWidth: COL_W,
                        height: `${col.rel * HEAD * t}%`,
                        boxShadow: `0 16px 26px -18px ${PURPLE}bb, 0 2px 6px -4px ${PURPLE}66`,
                        opacity: colDim ? 0.42 : 1,
                      }}
                    >
                      {col.tiers.map((tile, i) => {
                        if (!tile.count) return null; // no High band at Cognitive — the story
                        const on = tierFilter === tile.key && stageFilter === col.stage;
                        const dim = (tierFilter !== 'all' && tierFilter !== tile.key) || colDim;
                        return (
                          <button
                            key={tile.key}
                            type="button"
                            onClick={() => selectBoth(tile.key, col.stage)}
                            title={`${tile.label} priority · ${col.short} — ${tile.count.toLocaleString()} subjects (${tile.cohort.toFixed(0)}% of the cohort, ${tile.within.toFixed(0)}% of ${col.short})`}
                            className={`relative w-full transition duration-200 hover:brightness-[1.06] ${
                              i > 0 ? 'border-t-2 border-paper dark:border-darkBg' : ''
                            }`}
                            style={{
                              flex: `${tile.within} 1 0%`,
                              minHeight: 3, // a two-subject band is still a fact
                              background: BAND_FILL(tile.hex),
                              // the top band carries the light, the rest sit under it
                              boxShadow:
                                i === 0
                                  ? 'inset 0 1px 0 rgba(255,255,255,0.42)'
                                  : 'inset 0 1px 0 rgba(255,255,255,0.22)',
                              opacity: dim ? 0.36 : 1,
                              outline: on ? `2px solid ${tile.hex}` : 'none',
                              outlineOffset: on ? -2 : 0,
                            }}
                            onMouseEnter={() => setHover({ tier: tile.label, short: col.short, count: tile.count, hex: tile.hex })}
                            onMouseLeave={() => setHover(null)}
                          />
                        );
                      })}

                      {/* one diagonal sheen over the whole stack, so it reads as a solid */}
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-0"
                        style={{
                          background:
                            'linear-gradient(142deg, rgba(255,255,255,0.3) 0%, rgba(255,255,255,0.07) 34%, rgba(255,255,255,0) 58%)',
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* the column labels, one per column, centred under it */}
          <div className="mt-3 flex">
            {columns.map((col) => {
              const on = stageFilter === col.stage;
              const dim = stageFilter !== 0 && !on;
              return (
                <button
                  key={col.stage}
                  type="button"
                  onClick={() => toggleStage(col.stage)}
                  title={`${col.short} (stage ${col.stage}) — ${col.count.toLocaleString()} subjects (${col.share.toFixed(0)}% of the cohort)`}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg px-1 py-1 transition ${
                    on
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted hover:text-ink dark:text-darkMuted dark:hover:text-darkText'
                  }`}
                  style={{ opacity: dim ? 0.5 : 1 }}
                >
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
                    style={{ background: `${col.hex}1f` }}
                  >
                    <StageIcon stage={col.stage} hex={col.hex} />
                  </span>
                  <span className="truncate text-[13px] font-semibold">{col.short}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
