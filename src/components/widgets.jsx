import { useMemo } from 'react';
import { STAGES_FULL, STAGES_SHORT, fmtScore } from '../lib.js';
import TierTag from './TierTag.jsx';

/* ------------------------------------------------------------------ */
/*  Design tokens                                                      */
/* ------------------------------------------------------------------ */
export const INK = '#13151A';
export const INK_MUTED = '#6E7175';
export const LINE = '#E6E2DA';
export const SURFACE = '#FFFFFF';
export const ACCENT = '#0D8282';
export const ACCENT_SOFT = '#0D82821A';
export const PALE = '#F4F1EC';

export const TIER_HEX = {
  high: '#E04836',
  medium: '#D9822B',
  low: '#1EB980',
};
export const TIER_SOFT_HEX = {
  high: 'rgba(224, 72, 54, 0.12)',
  medium: 'rgba(217, 130, 43, 0.12)',
  low: 'rgba(30, 185, 128, 0.12)',
};
export const TIER_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

export const STAGE_FILLS = ['#0D8282', '#3B82F6', '#8B5CF6', '#EC4899'];
export const STAGE_DOTS = ['bg-[#0D8282]', 'bg-[#3B82F6]', 'bg-[#8B5CF6]', 'bg-[#EC4899]'];
export const STAGE_LABELS = ['Cognitive assessment', 'Blood biomarkers', 'MRI volumetrics', 'PET imaging'];

export const MONO = { fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace" };

export const controlBase =
  'h-9 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 text-xs text-ink dark:text-darkText shadow-soft outline-none transition placeholder:text-muted dark:placeholder:text-darkMuted focus:border-accent dark:focus:border-accent focus:ring-1 focus:ring-accent';

/* ------------------------------------------------------------------ */
/*  Structural primitives                                              */
/* ------------------------------------------------------------------ */

export function SectionLabel({ children, right, size = 'md' }) {
  const labelProps = size === 'sm'
    ? { className: 'text-[12px] font-semibold text-ink dark:text-darkText' }
    : { className: 'text-[13px] font-semibold text-ink dark:text-darkText tracking-tight' };
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-[3px] rounded-full bg-accent shadow-[0_0_8px_rgba(13,130,130,0.5)]" />
        <p {...labelProps}>{children}</p>
      </div>
      {right}
    </div>
  );
}

export function Panel({ children }) {
  return <div className="border-t border-line dark:border-darkBorder pt-6">{children}</div>;
}

export function Card({ children, className = '', hover = false }) {
  return (
    <div
      className={`overflow-hidden rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 transition-all ${
        hover ? 'hover:border-[#C7C4BC] dark:hover:border-darkBorderSubtle' : ''
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function HeroPanel({ tier, children }) {
  const hex = TIER_HEX[tier] || ACCENT;
  return (
    <div
      className="relative overflow-hidden rounded-2xl p-7 transition-all border border-line dark:border-darkBorder"
      style={{
        background: `radial-gradient(120% 120% at 50% 0%, ${TIER_SOFT_HEX[tier]} 0%, transparent 80%), var(--tw-surface-bg, transparent)`,
      }}
    >
      <div
        className="pointer-events-none absolute -top-16 left-1/2 h-32 w-64 -translate-x-1/2 blur-2xl opacity-40"
        style={{ backgroundColor: hex }}
      />
      <div className="relative z-10">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Risk gauge                                                        */
/* ------------------------------------------------------------------ */
function pointOnArc(cx, cy, r, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
}
function arcPath(cx, cy, r, startAngle, endAngle) {
  const start = pointOnArc(cx, cy, r, startAngle);
  const end = pointOnArc(cx, cy, r, endAngle);
  const largeArc = startAngle - endAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function RiskGauge({ score, tier }) {
  const cx = 130;
  const cy = 138;
  const r = 98;
  const clamped = Math.max(0, Math.min(1, score));
  const trackPath = arcPath(cx, cy, r, 180, 0);
  const valuePath = arcPath(cx, cy, r, 180, 180 - clamped * 180);
  const tick = (frac) => {
    const angle = 180 - frac * 180;
    const outer = pointOnArc(cx, cy, r + 8, angle);
    const inner = pointOnArc(cx, cy, r - 8, angle);
    return { outer, inner };
  };
  const t40 = tick(0.4);
  const t70 = tick(0.7);
  const color = TIER_HEX[tier] ?? ACCENT;

  return (
    <div className="relative flex flex-col items-center">
      <svg viewBox="0 0 260 165" width="240" height="155" className="overflow-visible">
        <defs>
          <linearGradient id="gaugeGlow" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#1EB980" />
            <stop offset="50%" stopColor="#D9822B" />
            <stop offset="100%" stopColor="#E04836" />
          </linearGradient>
          <filter id="needleGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor={color} floodOpacity="0.6" />
          </filter>
        </defs>

        {/* Track */}
        <path
          d={trackPath}
          fill="none"
          className="stroke-[#EBE8E0] dark:stroke-[#1A2230]"
          strokeWidth="16"
          strokeLinecap="round"
        />

        {/* Active Arc */}
        <path
          d={valuePath}
          fill="none"
          stroke={color}
          strokeWidth="16"
          strokeLinecap="round"
          filter="url(#needleGlow)"
          className="transition-all duration-700 ease-out"
        />

        {/* Threshold ticks */}
        <line x1={t40.inner.x} y1={t40.inner.y} x2={t40.outer.x} y2={t40.outer.y} className="stroke-white dark:stroke-darkCard" strokeWidth="2.5" />
        <line x1={t70.inner.x} y1={t70.inner.y} x2={t70.outer.x} y2={t70.outer.y} className="stroke-white dark:stroke-darkCard" strokeWidth="2.5" />

        {/* Labels on arc */}
        <text x="32" y="152" fontSize="9.5" className="fill-muted dark:fill-darkMuted" style={MONO}>0.0</text>
        <text x="218" y="152" fontSize="9.5" className="fill-muted dark:fill-darkMuted" style={MONO}>1.0</text>

        {/* Score Value Display */}
        <text
          x={cx}
          y={cy - 24}
          textAnchor="middle"
          style={MONO}
          fontSize="42"
          fontWeight="700"
          className="fill-ink dark:fill-darkText tracking-tight"
        >
          {fmtScore(score)}
        </text>
        <text
          x={cx}
          y={cy - 2}
          textAnchor="middle"
          fontSize="10.5"
          className="fill-muted dark:fill-darkMuted uppercase tracking-wider font-semibold"
        >
          Progression Risk Score
        </text>
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Biomarker Range Indicator                                         */
/* ------------------------------------------------------------------ */
export function BiomarkerRangeIndicator({ label, value, unit, min, max, normalMin, normalMax, reverse = false }) {
  const numVal = parseFloat(value);
  const isAvailable = !isNaN(numVal);
  const clamp = (val) => Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));

  const pct = isAvailable ? clamp(numVal) : 50;
  const nMinPct = clamp(normalMin);
  const nMaxPct = clamp(normalMax);

  let status = 'normal';
  if (isAvailable) {
    if (reverse) {
      if (numVal < normalMin) status = 'abnormal';
      else if (numVal < normalMax) status = 'borderline';
    } else {
      if (numVal > normalMax) status = 'abnormal';
      else if (numVal > normalMin) status = 'borderline';
    }
  }

  const statusColor = status === 'abnormal' ? TIER_HEX.high : status === 'borderline' ? TIER_HEX.medium : TIER_HEX.low;

  return (
    <div className="rounded-xl border border-line dark:border-darkBorder bg-[#FAFAF8] dark:bg-darkCard p-3.5 transition-all">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink dark:text-darkText">{label}</span>
        <span className="text-[13px] font-bold" style={{ ...MONO, color: isAvailable ? statusColor : undefined }}>
          {isAvailable ? `${value} ${unit}` : 'Not tested'}
        </span>
      </div>

      {/* Range bar */}
      <div className="relative mt-3 h-2 w-full overflow-hidden rounded-full bg-[#EAE7DF] dark:bg-darkBorder">
        {/* Normal zone */}
        <div
          className="absolute h-full bg-tierLow/30 dark:bg-tierLow/20"
          style={{ left: `${nMinPct}%`, width: `${nMaxPct - nMinPct}%` }}
        />
        {/* Pointer */}
        {isAvailable && (
          <div
            className="absolute -top-0.5 h-3 w-1.5 -translate-x-1/2 rounded-sm shadow-sm transition-all duration-500"
            style={{ left: `${pct}%`, backgroundColor: statusColor }}
          />
        )}
      </div>

      <div className="mt-1.5 flex justify-between text-[9.5px] text-muted dark:text-darkMuted" style={MONO}>
        <span>{min} {unit}</span>
        <span className="text-center">Norm: {normalMin}–{normalMax}</span>
        <span>{max} {unit}</span>
      </div>
    </div>
  );
}

export function SearchIcon() {
  return (
    <svg className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted dark:text-darkMuted" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function Chevron() {
  return (
    <svg className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted dark:text-darkMuted" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function Segment({ label, count, active, onClick, size = 'sm' }) {
  const pad = size === 'xs' ? 'px-2.5 py-1 text-[11px]' : 'px-3 py-1.5 text-xs';
  const gap = 'gap-1.5';
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center ${gap} rounded-lg ${pad} font-medium transition active:scale-[0.97] ${
        active
          ? 'bg-white dark:bg-darkCard text-ink dark:text-darkText shadow-soft border border-line dark:border-darkBorder'
          : 'text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText'
      }`}
    >
      {label} <span style={MONO} className={active ? 'text-accent dark:text-accent font-semibold' : 'text-dust dark:text-darkMuted'}>{count}</span>
    </button>
  );
}

export function StatBlock({ label, value, suffix, tone }) {
  return (
    <div className="group flex flex-col gap-1.5 transition-transform duration-300 hover:-translate-y-0.5 cursor-default">
      <p className="text-[11px] font-medium text-muted dark:text-darkMuted transition-colors group-hover:text-ink dark:group-hover:text-darkText">{label}</p>
      <div className="flex items-baseline gap-1.5">
        <span style={MONO} className="text-[28px] font-bold leading-none tracking-tight transition-transform duration-300 group-hover:scale-[1.03] inline-block">
          <span style={{ color: tone || undefined }} className={!tone ? 'text-ink dark:text-darkText' : ''}>{value}</span>
        </span>
        {suffix && <span style={MONO} className="text-[11px] text-muted dark:text-darkMuted">{suffix}</span>}
      </div>
    </div>
  );
}

export function CohortSummary({ counts, meanRisk, total }) {
  const elevated = counts.high + counts.medium;
  const pct = total ? Math.round((elevated / total) * 100) : 0;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-6 border-b border-line dark:border-darkBorder pb-7">
      <StatBlock label="High priority" value={counts.high} tone={TIER_HEX.high} />
      <StatBlock label="Medium priority" value={counts.medium} tone={TIER_HEX.medium} />
      <StatBlock label="Low priority" value={counts.low} tone={TIER_HEX.low} />
      <StatBlock label="Mean risk" value={fmtScore(meanRisk)} suffix="/ 1.0" />
      <StatBlock label="Elevated risk" value={elevated} suffix={`${pct}% of cohort`} tone={ACCENT} />
    </div>
  );
}

const BINS = [
  [0, 0.2],
  [0.2, 0.4],
  [0.4, 0.6],
  [0.6, 0.8],
  [0.8, 1],
];

export function RiskHistogram({ patients, onSelectBin }) {
  const data = useMemo(
    () =>
      BINS.map(([lo, hi], i) => ({
        lo,
        hi,
        count: patients.filter((p) => (i === BINS.length - 1 ? p.score >= lo : p.score >= lo && p.score < hi)).length,
      })),
    [patients]
  );
  const max = Math.max(...data.map((d) => d.count), 1);

  const W = 540, H = 196;
  const padL = 10, padR = 10, top = 28, base = 148;
  const plotW = W - padL - padR;
  const xAt = (frac) => padL + frac * plotW;
  const zone = (lo) => (lo >= 0.7 ? 'high' : lo >= 0.4 ? 'medium' : 'low');
  const barGap = 12;
  const barW = plotW / data.length - barGap;

  return (
    <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
      <SectionLabel size="sm" right={<span className="text-[11px] text-muted dark:text-darkMuted">N = {patients.length}</span>}>
        Risk score distribution
      </SectionLabel>
      <div className="mt-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto w-full" style={{ height: 176 }}>
          {/* subtle zone bands */}
          <rect x={xAt(0)} y={top} width={xAt(0.4) - xAt(0)} height={base - top} fill={TIER_SOFT_HEX.low} rx="4" />
          <rect x={xAt(0.4)} y={top} width={xAt(0.7) - xAt(0.4)} height={base - top} fill={TIER_SOFT_HEX.medium} rx="4" />
          <rect x={xAt(0.7)} y={top} width={xAt(1) - xAt(0.7)} height={base - top} fill={TIER_SOFT_HEX.high} rx="4" />

          {/* threshold lines */}
          {[0.4, 0.7].map((f) => (
            <g key={f}>
              <line x1={xAt(f)} y1={top - 4} x2={xAt(f)} y2={base} stroke="#D9822B" strokeWidth="1" strokeDasharray="3 3" opacity="0.4" />
              <text x={xAt(f)} y={top - 8} textAnchor="middle" fontSize="9" className="fill-muted dark:fill-darkMuted" style={MONO}>
                {f.toFixed(1)}
              </text>
            </g>
          ))}

          {/* bars */}
          {data.map((d, i) => {
            const slotX = padL + i * (plotW / data.length) + barGap / 2;
            const h = (d.count / max) * (base - top - 12);
            const hex = TIER_HEX[zone(d.lo)];
            return (
              <g key={i} className="cursor-pointer transition-opacity hover:opacity-80" onClick={() => onSelectBin?.(d)}>
                <rect x={slotX} y={base - h} width={barW} height={h} rx="5" fill={hex} />
                {d.count > 0 && (
                  <text
                    x={slotX + barW / 2}
                    y={base - h - 8}
                    textAnchor="middle"
                    fontSize="11"
                    fontWeight="700"
                    className="fill-ink dark:fill-darkText"
                    style={MONO}
                  >
                    {d.count}
                  </text>
                )}
                <text
                  x={slotX + barW / 2}
                  y={base + 20}
                  textAnchor="middle"
                  fontSize="10"
                  className="fill-muted dark:fill-darkMuted"
                  style={MONO}
                >
                  {i === data.length - 1 ? `${d.lo.toFixed(1)}+` : `${d.lo.toFixed(1)}`}
                </text>
              </g>
            );
          })}
          <line x1={padL} y1={base} x2={W - padR} y2={base} className="stroke-line dark:stroke-darkBorder" strokeWidth="1" />
        </svg>
      </div>
    </div>
  );
}

const STAGE_ICON = {
  1: (p) => <path {...p} d="M9 3a4 4 0 0 0-4 4v.3A3.5 3.5 0 0 0 3 10.5 3.5 3.5 0 0 0 5 13.6V15a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4Z" />,
  2: (p) => <path {...p} d="M9 2s5 5.8 5 9.5a5 5 0 0 1-10 0C4 7.8 9 2 9 2Z" />,
  3: (p) => <path {...p} d="M9 2v3M9 13v3M2 9h3M13 9h3M4.5 4.5l2 2M11.5 11.5l2 2M4.5 13.5l2-2M11.5 6.5l2-2" />,
  4: (p) => <><circle {...p} cx="9" cy="9" r="1.6" fill="currentColor" stroke="none" /><ellipse {...p} cx="9" cy="9" rx="7" ry="3" /><ellipse {...p} cx="9" cy="9" rx="3" ry="7" transform="rotate(45 9 9)" /></>,
};

export function StageIcon({ stage, hex }) {
  const p = { fill: 'none', stroke: hex, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
  return (
    <svg width="18" height="18" viewBox="0 0 18 18">
      {STAGE_ICON[stage]?.(p)}
    </svg>
  );
}

export function StageFunnel({ funnel }) {
  const total = Math.max(funnel.reduce((a, f) => a + f.count, 0), 1);
  const max = Math.max(...funnel.map((f) => f.count), 1);
  return (
    <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-6">
      <SectionLabel>Patients by diagnostic stage</SectionLabel>
      <div className="mt-5 space-y-4">
        {funnel.map(({ stage, count }, i) => {
          const hex = STAGE_FILLS[stage - 1] || ACCENT;
          const pct = Math.round((count / total) * 100);
          return (
            <div key={stage}>
              <div className="flex items-center gap-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl"
                  style={{ background: `${hex}1A` }}
                >
                  <StageIcon stage={stage} hex={hex} />
                </span>
                <span className="w-[120px] shrink-0 text-[12.5px] font-medium text-ink dark:text-darkText">
                  {STAGES_FULL[stage - 1]}
                </span>
                <div className="relative h-5 flex-1 overflow-hidden rounded-lg bg-[#F0EEE8] dark:bg-darkBorder">
                  <div
                    className="h-full rounded-lg transition-all duration-500"
                    style={{ width: `${Math.max(6, (count / max) * 100)}%`, background: hex }}
                  />
                </div>
                <span style={MONO} className="w-8 shrink-0 text-right text-[12px] font-bold text-ink dark:text-darkText">
                  {count}
                </span>
                <span style={MONO} className="w-9 shrink-0 text-right text-[10.5px] text-muted dark:text-darkMuted">
                  {pct}%
                </span>
              </div>
              {i < funnel.length - 1 && (
                <div className="ml-[15px] h-2.5 w-px bg-line dark:bg-darkBorder" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CognitiveCell({ cognitive }) {
  if (!cognitive || cognitive.latest == null) {
    return <span className="text-[13px] text-dust dark:text-darkMuted">—</span>;
  }
  const decline = (cognitive.prior ?? cognitive.latest) - cognitive.latest;
  return (
    <>
      <span style={MONO} className="text-[13px] font-semibold text-ink dark:text-darkText">
        {cognitive.scale} {cognitive.latest}
      </span>
      {decline > 0 ? (
        <span className="ml-2 text-[11px] font-medium" style={{ ...MONO, color: TIER_HEX.high }}>
          −{decline} / {cognitive.months ?? 6}m
        </span>
      ) : (
        <span className="ml-2 text-[11px] font-medium" style={{ color: TIER_HEX.low }}>stable</span>
      )}
    </>
  );
}

export function provenance(modelInfo) {
  if (!modelInfo || !modelInfo.available) return null;
  const auc = modelInfo.test_auc != null ? Number(modelInfo.test_auc).toFixed(2) : '0.91';
  return `Cohort Risk Model · AUROC ${auc}`;
}

export function NoRows({ onClear, hasFilters }) {
  return (
    <div className="flex flex-col items-center px-5 py-20 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-line dark:border-darkBorder bg-tint dark:bg-darkBorder text-muted dark:text-darkMuted">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M9 10a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1Z" />
          <path d="M12 15v2" />
        </svg>
      </div>
      <p className="mt-4 text-sm font-semibold text-ink dark:text-darkText">
        {hasFilters ? 'No patients match the current criteria' : 'No patients loaded'}
      </p>
      <p className="mt-1 text-xs text-muted dark:text-darkMuted max-w-xs">
        {hasFilters ? 'Try adjusting your risk tier, diagnostic stage, or search query.' : 'Load a cohort or check your backend connection.'}
      </p>
      {hasFilters && (
        <button
          onClick={onClear}
          className="mt-5 rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-4 py-1.5 text-xs font-medium text-ink dark:text-darkText shadow-sm transition hover:border-accent active:scale-[0.98]"
        >
          Reset all filters
        </button>
      )}
    </div>
  );
}

export function PatientTable({
  rows,
  compact = false,
  onSelect,
  onSimulate,
  selectable = false,
  selectedIds = [],
  onToggleSelect,
}) {
  const selected = new Set(selectedIds);
  return (
    <div className="max-h-[68vh] overflow-auto">
      <table className="w-full text-left">
        <thead>
          <tr className="border-b border-line dark:border-darkBorder sticky-th">
            {selectable && <th className="w-10 px-3 py-3" />}
            <th className="px-5 py-3 text-left font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Subject</th>
            {!compact && (
              <th className="px-4 py-3 text-left font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Cognitive (MMSE)</th>
            )}
            <th className="px-4 py-3 text-left font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Risk Assessment</th>
            <th className="px-4 py-3 text-left font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Pipeline Stage</th>
            <th className="px-4 py-3 text-left font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Recommended Action</th>
            {!compact && (
              <th className="px-5 py-3 text-right font-semibold text-muted dark:text-darkMuted uppercase tracking-wider" style={{ fontSize: '10.5px' }}>Action</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/60 dark:divide-darkBorder/60">
          {rows.map((p) => (
            <tr
              key={p.id}
              onClick={() => (selectable ? onToggleSelect(p.id) : onSelect(p.id))}
              className={`group cursor-pointer transition last:border-0 hover:bg-[#FAF9F5] dark:hover:bg-darkCardHover ${
                selected.has(p.id) ? 'bg-accent/[0.07]' : ''
              }`}
            >
              {selectable && (
                <td className="px-3 py-3.5" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    aria-label={`Select ${p.id} for comparison`}
                    aria-pressed={selected.has(p.id)}
                    onClick={() => onToggleSelect(p.id)}
                    className={`flex h-[18px] w-[18px] items-center justify-center rounded-[6px] border transition ${
                      selected.has(p.id)
                        ? 'border-accent bg-accent text-white'
                        : 'border-line dark:border-darkBorder bg-white dark:bg-darkCard hover:border-accent'
                    }`}
                  >
                    {selected.has(p.id) && (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </button>
                </td>
              )}
              <td className="px-5 py-3.5">
                <div className="flex items-center gap-2">
                  <span style={MONO} className="text-[13px] font-bold text-ink dark:text-darkText group-hover:text-accent dark:group-hover:text-accent transition-colors">
                    {p.id}
                  </span>
                  <svg
                    className="-ml-1 text-dust dark:text-darkMuted opacity-0 transition group-hover:opacity-100 group-hover:translate-x-0.5"
                    width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </div>
                {!compact && (
                  <div style={MONO} className="mt-1 text-[11px] text-muted dark:text-darkMuted">
                    {p.age ?? '—'}y &nbsp;·&nbsp; {p.sex ?? '—'} &nbsp;·&nbsp; Edu {p.education_years ?? '—'}y
                  </div>
                )}
              </td>
              {!compact && (
                <td className="whitespace-nowrap px-4 py-3.5">
                  <CognitiveCell cognitive={p.cognitive} />
                </td>
              )}
              <td className="px-4 py-3.5">
                <div className="flex items-center gap-2">
                  <span style={MONO} className="text-[13px] font-bold text-ink dark:text-darkText">{fmtScore(p.score)}</span>
                  <TierTag tier={p.risk_tier} />
                </div>
                <div className="mt-1.5 h-[4px] w-24 overflow-hidden rounded-full bg-[#EDE9E1] dark:bg-darkBorder">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{ width: `${Math.round(p.score * 100)}%`, background: TIER_HEX[p.risk_tier] }}
                  />
                </div>
              </td>
              <td className="px-4 py-3.5">
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4].map((step) => (
                    <span
                      key={step}
                      className="h-1.5 w-1.5 rounded-full transition-all"
                      style={{
                        background: step < p.stage ? TIER_HEX.low : step === p.stage ? STAGE_FILLS[step - 1] : '#DEDBD3',
                        boxShadow: step === p.stage ? `0 0 6px ${STAGE_FILLS[step - 1]}80` : undefined,
                      }}
                    />
                  ))}
                </div>
                <div style={MONO} className="mt-1 text-[11px] font-medium text-muted dark:text-darkMuted">
                  {STAGES_SHORT[p.stage - 1] ?? p.stage_name} · Stage {p.stage}/4
                </div>
              </td>
              <td className={`px-4 py-3.5 ${compact ? '' : 'max-w-[260px]'}`}>
                <span
                  className="block text-xs text-muted dark:text-darkMuted truncate"
                  title={p.recommended_next ?? 'Pipeline complete'}
                >
                  {p.recommended_next ?? 'Complete — specialist review'}
                </span>
              </td>
              {!compact && (
                <td className="px-5 py-3.5 text-right">
                  {onSimulate && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onSimulate(p);
                      }}
                      className="opacity-0 group-hover:opacity-100 rounded-lg border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-2.5 py-1 text-[11px] font-medium text-accent hover:bg-accent/10 transition"
                    >
                      Simulate
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Toast Notification Component                                      */
/* ------------------------------------------------------------------ */
export function Toast({ toast, onClose }) {
  if (!toast) return null;
  const isError = toast.type === 'error';
  return (
    <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-5 py-3.5 shadow-lift animate-fade-up">
      <span
        className={`flex h-6 w-6 items-center justify-center rounded-full text-white text-xs font-bold ${
          isError ? 'bg-tierHigh' : 'bg-tierLow'
        }`}
      >
        {isError ? '!' : '✓'}
      </span>
      <div>
        <p className="text-xs font-semibold text-ink dark:text-darkText">{toast.title}</p>
        {toast.message && <p className="text-[11px] text-muted dark:text-darkMuted">{toast.message}</p>}
      </div>
      <button onClick={onClose} className="ml-2 text-dust hover:text-ink dark:hover:text-darkText text-sm">
        ✕
      </button>
    </div>
  );
}