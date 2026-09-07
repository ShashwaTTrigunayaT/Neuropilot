import { useState, useMemo } from 'react';
import { MONO, SectionLabel, TIER_HEX, TIER_SOFT_HEX } from './widgets.jsx';

// 10 high-resolution bins
const BINS_10 = Array.from({ length: 10 }, (_, i) => [i * 0.1, (i + 1) * 0.1]);

export default function RiskDistributionChart({ patients = [], onSelectBin }) {
  const [hoveredBin, setHoveredBin] = useState(null);
  const [selectedTier, setSelectedTier] = useState(null);

  const total = patients.length || 1;

  // Granular Binned Data
  const binData = useMemo(() => {
    return BINS_10.map(([lo, hi], i) => {
      const isLast = i === BINS_10.length - 1;
      const count = patients.filter((p) =>
        isLast ? p.score >= lo && p.score <= 1.0 : p.score >= lo && p.score < hi
      ).length;
      const pct = (count / total) * 100;
      const mid = lo + 0.05;
      const tier = lo >= 0.7 ? 'high' : lo >= 0.4 ? 'medium' : 'low';
      return { lo, hi, mid, count, pct, tier, index: i };
    });
  }, [patients, total]);

  const maxCount = useMemo(() => {
    return Math.max(...binData.map((d) => d.count), 1);
  }, [binData]);

  // Cohort Statistical Summary
  const stats = useMemo(() => {
    if (!patients.length) {
      return { mean: 0, median: 0, stdDev: 0, q1: 0, q3: 0, low: { count: 0, pct: 0 }, med: { count: 0, pct: 0 }, high: { count: 0, pct: 0 } };
    }
    const scores = patients.map((p) => p.score).sort((a, b) => a - b);
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    const median = n % 2 === 0 ? (scores[n / 2 - 1] + scores[n / 2]) / 2 : scores[Math.floor(n / 2)];
    const q1 = scores[Math.floor(n * 0.25)] || 0;
    const q3 = scores[Math.floor(n * 0.75)] || 0;
    const variance = scores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / n;
    const stdDev = Math.sqrt(variance);

    const lowPatients = patients.filter((p) => p.score < 0.4);
    const medPatients = patients.filter((p) => p.score >= 0.4 && p.score < 0.7);
    const highPatients = patients.filter((p) => p.score >= 0.7);

    return {
      mean,
      median,
      stdDev,
      q1,
      q3,
      low: {
        count: lowPatients.length,
        pct: (lowPatients.length / total) * 100,
      },
      med: {
        count: medPatients.length,
        pct: (medPatients.length / total) * 100,
      },
      high: {
        count: highPatients.length,
        pct: (highPatients.length / total) * 100,
      },
    };
  }, [patients, total]);

  // Perfectly proportioned SVG dimensions matching StageProgressionChart
  const W = 600;
  const H = 270;
  const padL = 36;
  const padR = 24;
  const padTop = 44;
  const padBottom = 28;
  const plotW = W - padL - padR;
  const plotH = H - padTop - padBottom;
  const baseY = padTop + plotH;

  const getX = (val) => padL + (val / 1.0) * plotW;
  const getY = (count) => baseY - (count / maxCount) * (plotH - 12);

  // Anti-Collision Tag Staggering
  const isNearCutoff = Math.abs(stats.mean - 0.4) < 0.14 || Math.abs(stats.mean - 0.7) < 0.14;
  const meanTagY = isNearCutoff ? padTop - 34 : padTop - 18;

  // Smooth Bezier Curve Path for Continuous Density
  const splinePath = useMemo(() => {
    if (!binData.length) return '';
    const points = binData.map((d) => ({
      x: getX(d.mid),
      y: getY(d.count),
    }));

    let path = `M ${getX(0)} ${baseY} L ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const cx = (p0.x + p1.x) / 2;
      path += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    path += ` L ${getX(1)} ${baseY} Z`;
    return path;
  }, [binData, maxCount, baseY, plotH]);

  const splineLineOnly = useMemo(() => {
    if (!binData.length) return '';
    const points = binData.map((d) => ({
      x: getX(d.mid),
      y: getY(d.count),
    }));
    let path = `M ${points[0].x} ${points[0].y}`;
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i];
      const p1 = points[i + 1];
      const cx = (p0.x + p1.x) / 2;
      path += ` C ${cx} ${p0.y}, ${cx} ${p1.y}, ${p1.x} ${p1.y}`;
    }
    return path;
  }, [binData, maxCount, baseY, plotH]);

  const meanX = getX(stats.mean);

  return (
    <div className="select-none flex flex-col justify-between h-full">
      {/* 1. Header Row */}
      <div className="mb-4">
        <SectionLabel>
          Risk Score Density Distribution
        </SectionLabel>
      </div>

      {/* 2. Top Ribbon Bar (Symmetric Height: ~48px) */}
      <div className="mb-4 grid grid-cols-3 gap-2 p-1.5 rounded-xl bg-surface/80 dark:bg-darkBg/60 border border-line/60 dark:border-darkBorder/60 min-h-[50px] items-center">
        {[
          { key: 'low', name: 'Low Risk', range: '<0.40', data: stats.low, hex: TIER_HEX.low },
          { key: 'medium', name: 'Watch Tier', range: '0.40–0.70', data: stats.med, hex: TIER_HEX.medium },
          { key: 'high', name: 'High Priority', range: '≥0.70', data: stats.high, hex: TIER_HEX.high },
        ].map((t) => {
          const isSelected = selectedTier === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSelectedTier(isSelected ? null : t.key)}
              className={`group flex items-center justify-between py-2 px-3 rounded-lg text-left transition-all duration-300 ${
                isSelected
                  ? 'bg-white dark:bg-darkCard shadow-sm ring-1 ring-accent'
                  : 'hover:bg-white/50 dark:hover:bg-darkCard/40'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: t.hex }} />
                <span className="text-[11.5px] font-bold text-ink dark:text-darkText leading-none" style={MONO}>
                  {t.name}
                </span>
              </div>
              <div className="flex items-baseline gap-1" style={MONO}>
                <span className="text-[11.5px] font-black" style={{ color: t.hex }}>
                  {t.data.count}
                </span>
                <span className="text-[9.5px] text-muted dark:text-darkMuted font-normal">
                  ({t.data.pct.toFixed(0)}%)
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {/* 3. Main Visual Area (Proportionate Height) */}
      <div className="relative my-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto w-full overflow-visible">
          <defs>
            {/* Multi-tone Risk Gradient Area */}
            <linearGradient id="riskDensityGrad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={TIER_HEX.low} stopOpacity="0.35" />
              <stop offset="38%" stopColor={TIER_HEX.low} stopOpacity="0.30" />
              <stop offset="42%" stopColor={TIER_HEX.medium} stopOpacity="0.34" />
              <stop offset="68%" stopColor={TIER_HEX.medium} stopOpacity="0.30" />
              <stop offset="72%" stopColor={TIER_HEX.high} stopOpacity="0.38" />
              <stop offset="100%" stopColor={TIER_HEX.high} stopOpacity="0.45" />
            </linearGradient>

            <linearGradient id="densityStroke" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor={TIER_HEX.low} />
              <stop offset="40%" stopColor={TIER_HEX.low} />
              <stop offset="55%" stopColor={TIER_HEX.medium} />
              <stop offset="75%" stopColor={TIER_HEX.high} />
              <stop offset="100%" stopColor={TIER_HEX.high} />
            </linearGradient>

            <filter id="densityGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="3" stdDeviation="5" floodColor="#0D8282" floodOpacity="0.35" />
            </filter>
          </defs>

          {/* Background Zone Tints */}
          <rect
            x={getX(0)}
            y={padTop}
            width={getX(0.4) - getX(0)}
            height={plotH}
            fill={TIER_SOFT_HEX.low}
            rx="4"
          />
          <rect
            x={getX(0.4)}
            y={padTop}
            width={getX(0.7) - getX(0.4)}
            height={plotH}
            fill={TIER_SOFT_HEX.medium}
            rx="4"
          />
          <rect
            x={getX(0.7)}
            y={padTop}
            width={getX(1.0) - getX(0.7)}
            height={plotH}
            fill={TIER_SOFT_HEX.high}
            rx="4"
          />

          {/* Y-Axis Gridlines */}
          {[0, 0.33, 0.66, 1.0].map((ratio) => {
            const yVal = baseY - ratio * (plotH - 12);
            const labelVal = Math.round(ratio * maxCount);
            return (
              <g key={ratio}>
                <line
                  x1={padL}
                  y1={yVal}
                  x2={padL + plotW}
                  y2={yVal}
                  className="stroke-line/50 dark:stroke-darkBorder/50"
                  strokeWidth="1"
                  strokeDasharray="2 3"
                />
                <text
                  x={padL - 8}
                  y={yVal + 3.5}
                  textAnchor="end"
                  fontSize="9.5"
                  className="fill-muted dark:fill-darkMuted"
                  style={MONO}
                >
                  {labelVal}
                </text>
              </g>
            );
          })}

          {/* Zone Threshold Boundary Lines with Non-Colliding Badges */}
          {[
            { cutoff: 0.4, label: '0.4 Cutoff', hex: TIER_HEX.medium },
            { cutoff: 0.7, label: '0.7 Cutoff', hex: TIER_HEX.high },
          ].map(({ cutoff, label, hex }) => {
            const x = getX(cutoff);
            return (
              <g key={cutoff}>
                <line
                  x1={x}
                  y1={padTop}
                  x2={x}
                  y2={baseY}
                  stroke={hex}
                  strokeWidth="1.2"
                  strokeDasharray="3 3"
                  opacity="0.65"
                />
                <rect
                  x={x - 28}
                  y={padTop - 18}
                  width="56"
                  height="15"
                  rx="3.5"
                  fill={hex}
                  fillOpacity="0.12"
                  stroke={hex}
                  strokeWidth="0.8"
                  strokeOpacity="0.4"
                />
                <text
                  x={x}
                  y={padTop - 7.5}
                  textAnchor="middle"
                  fontSize="8.5"
                  fontWeight="700"
                  fill={hex}
                  style={MONO}
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Mean Score Indicator Tag (Anti-Collision Staggered) */}
          {patients.length > 0 && (
            <g className="transition-all duration-500">
              <line
                x1={meanX}
                y1={isNearCutoff ? meanTagY + 15 : padTop}
                x2={meanX}
                y2={baseY}
                stroke="#0D8282"
                strokeWidth="1.6"
                strokeDasharray="2 2"
              />
              <circle cx={meanX} cy={padTop + 4} r="3" fill="#0D8282" />
              <rect
                x={meanX - 22}
                y={meanTagY}
                width="44"
                height="15"
                rx="3.5"
                fill="#0D8282"
                fillOpacity="0.18"
                stroke="#0D8282"
                strokeWidth="0.9"
                strokeOpacity="0.6"
              />
              <text
                x={meanX}
                y={meanTagY + 11}
                textAnchor="middle"
                fontSize="8.5"
                fontWeight="800"
                className="fill-accent"
                style={MONO}
              >
                μ {stats.mean.toFixed(2)}
              </text>
            </g>
          )}

          {/* Smooth Density Area & Curve */}
          <path
            d={splinePath}
            fill="url(#riskDensityGrad)"
            className="transition-all duration-700 ease-out"
          />
          <path
            d={splineLineOnly}
            fill="none"
            stroke="url(#densityStroke)"
            strokeWidth="2.5"
            strokeLinecap="round"
            filter="url(#densityGlow)"
            className="transition-all duration-700 ease-out"
          />

          {/* Individual Binned Bars with Interactive Hover */}
          {binData.map((d, i) => {
            const barW = (plotW / binData.length) * 0.72;
            const barX = getX(d.lo) + ((plotW / binData.length) - barW) / 2;
            const barH = (d.count / maxCount) * (plotH - 12);
            const barY = baseY - barH;
            const hex = TIER_HEX[d.tier];
            const isHovered = hoveredBin?.index === i;
            const isDimmed = selectedTier && selectedTier !== d.tier;

            return (
              <g
                key={i}
                className="cursor-pointer"
                opacity={isDimmed ? 0.3 : 1}
                onMouseEnter={() => setHoveredBin(d)}
                onMouseLeave={() => setHoveredBin(null)}
                onClick={() => onSelectBin?.(d)}
              >
                <rect
                  x={getX(d.lo)}
                  y={padTop}
                  width={plotW / binData.length}
                  height={plotH}
                  fill="transparent"
                />
                <rect
                  x={barX}
                  y={barY}
                  width={barW}
                  height={Math.max(barH, 3)}
                  rx="3.5"
                  fill={hex}
                  opacity={isHovered ? 0.95 : 0.45}
                  className="transition-all duration-300"
                />
                <circle
                  cx={getX(d.mid)}
                  cy={getY(d.count)}
                  r={isHovered ? 5.5 : 3.5}
                  fill={hex}
                  className="transition-all duration-300"
                />
                <circle
                  cx={getX(d.mid)}
                  cy={getY(d.count)}
                  r={isHovered ? 2 : 1}
                  fill="#FFFFFF"
                />
                {isHovered && d.count > 0 && (
                  <text
                    x={barX + barW / 2}
                    y={barY - 8}
                    textAnchor="middle"
                    fontSize="10.5"
                    fontWeight="800"
                    fill={hex}
                    style={MONO}
                  >
                    {d.count} ({d.pct.toFixed(0)}%)
                  </text>
                )}
              </g>
            );
          })}

          {/* X Axis Baseline */}
          <line
            x1={padL}
            y1={baseY}
            x2={padL + plotW}
            y2={baseY}
            className="stroke-line dark:stroke-darkBorder"
            strokeWidth="1.2"
          />

          {/* X Axis Ticks & Labels */}
          {[0, 0.2, 0.4, 0.6, 0.8, 1.0].map((val) => {
            const x = getX(val);
            return (
              <g key={val}>
                <line
                  x1={x}
                  y1={baseY}
                  x2={x}
                  y2={baseY + 4}
                  className="stroke-line dark:stroke-darkBorder"
                  strokeWidth="1.2"
                />
                <text
                  x={x}
                  y={baseY + 16}
                  textAnchor="middle"
                  fontSize="9.5"
                  className="fill-muted dark:fill-darkMuted"
                  style={MONO}
                >
                  {val.toFixed(1)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* 4. Bottom Telemetry Panel (Symmetric Height: ~48px) */}
      <div className="mt-4 pt-3 border-t border-line/60 dark:border-darkBorder/60">
        {hoveredBin ? (
          <div className="flex items-center justify-between text-xs font-semibold text-ink dark:text-darkText animate-fade-in py-1" style={MONO}>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: TIER_HEX[hoveredBin.tier] }} />
              Bin: <strong className="text-accent">[{hoveredBin.lo.toFixed(1)} – {hoveredBin.hi.toFixed(1)}]</strong>
            </span>
            <span>
              Subjects: <strong className="text-accent">{hoveredBin.count}</strong> ({hoveredBin.pct.toFixed(1)}%)
            </span>
            <span style={{ color: TIER_HEX[hoveredBin.tier] }}>
              {hoveredBin.tier.toUpperCase()} TIER
            </span>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 text-center text-xs" style={MONO}>
            <div className="p-1.5 rounded-lg bg-surface/50 dark:bg-darkBg/30 border border-line/40 dark:border-darkBorder/40">
              <span className="text-[10px] text-muted dark:text-darkMuted block">Median</span>
              <span className="text-[12px] font-bold text-ink dark:text-darkText">{stats.median.toFixed(2)}</span>
            </div>
            <div className="p-1.5 rounded-lg bg-surface/50 dark:bg-darkBg/30 border border-line/40 dark:border-darkBorder/40">
              <span className="text-[10px] text-muted dark:text-darkMuted block">Std Dev (σ)</span>
              <span className="text-[12px] font-bold text-ink dark:text-darkText">{stats.stdDev.toFixed(2)}</span>
            </div>
            <div className="p-1.5 rounded-lg bg-surface/50 dark:bg-darkBg/30 border border-line/40 dark:border-darkBorder/40">
              <span className="text-[10px] text-muted dark:text-darkMuted block">Q1 (25th)</span>
              <span className="text-[12px] font-bold text-ink dark:text-darkText">{stats.q1.toFixed(2)}</span>
            </div>
            <div className="p-1.5 rounded-lg bg-surface/50 dark:bg-darkBg/30 border border-line/40 dark:border-darkBorder/40">
              <span className="text-[10px] text-muted dark:text-darkMuted block">Q3 (75th)</span>
              <span className="text-[12px] font-bold text-ink dark:text-darkText">{stats.q3.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
