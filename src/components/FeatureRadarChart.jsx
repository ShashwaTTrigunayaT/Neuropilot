import { useState, useMemo } from 'react';
import { MONO } from './widgets.jsx';

// The served model's 15-feature ADNI contract, mapped onto the four pipeline
// stages the product actually escalates through. (The legacy OASIS names are
// gone -- this chart was still labelling spokes with nwbv / etiv / ses.)
export const STAGE_OF = {
  adas_cog_13: 1, mmse: 1, mmse_change: 1, age: 1, sex: 1, education_years: 1, apoe_e4: 1,
  ptau217: 2, abeta4240: 2, nfl: 2, gfap: 2,
  hippocampal_volume: 3, hippocampal_icv_ratio: 3,
  centiloids: 4, tau_meta_temporal: 4,
};
const STAGE_LABEL = {
  1: 'Cognitive / Clinical',
  2: 'Blood Biomarkers',
  3: 'MRI Volumetrics',
  4: 'PET Imaging',
};

// Display names for the served 15-feature ADNI contract (the legacy OASIS map
// was still labelling spokes with nwbv / etiv / ses). Exported so the landing
// page can name the features of each stage without a second copy of this map.
export const FEATURE_LABEL = {
  adas_cog_13: 'ADAS-Cog 13',
  mmse: 'MMSE',
  mmse_change: 'MMSE change',
  tau_meta_temporal: 'Tau PET (temporal SUVR)',
  centiloids: 'Amyloid PET (Centiloids)',
  ptau217: 'p-tau217 (plasma)',
  hippocampal_icv_ratio: 'Hippocampal / ICV ratio',
  nfl: 'NfL (plasma)',
  hippocampal_volume: 'Hippocampal volume',
  sex: 'Biological sex',
  age: 'Age',
  abeta4240: 'Aβ42/40 ratio (plasma)',
  gfap: 'GFAP (plasma)',
  education_years: 'Education (years)',
  apoe_e4: 'APOE ε4 carrier',
};

// NOTE: `data` is the SERVED (refined) model's attribution. The retained
// cross-sectional family ranks features very differently -- it is led by
// ADAS-Cog/MMSE, because a cognitive scale is the best predictor of a cognitive
// diagnosis, while the refined model is led by amyloid/tau PET. The section
// heading names the model so this chart is never mistaken for an explanation of
// a different family's scores.
export default function FeatureRadarChart({ data = [] }) {
  const [hoveredFeature, setHoveredFeature] = useState(null);

  // All parameters keep their own spoke. The raw mean |SHAP| values span two
  // orders of magnitude, so a linear max-normalized radius pinned the top two
  // spokes to the outer ring and flattened the rest to the centre. The radius is
  // therefore on a SQUARE-ROOT scale -- stated in the header, never silent --
  // while every spoke still prints its untransformed value.
  const features = useMemo(() => {
    const total = data.reduce((a, d) => a + (d.mean_abs_shap || 0), 0) || 1;
    return data
      .map((d) => {
        const stage = STAGE_OF[d.feature] ?? 1;
        return {
          ...d,
          stage,
          stageLabel: STAGE_LABEL[stage],
          label: FEATURE_LABEL[d.feature] || d.feature,
          share: ((d.mean_abs_shap || 0) / total) * 100,
          // sqrt scale (see note above); guarded against a zero/NaN value
          rv: Math.sqrt(Math.max(d.mean_abs_shap || 0, 0)),
        };
      })
      .sort((a, b) => b.mean_abs_shap - a.mean_abs_shap);
  }, [data]);

  const maxRv = useMemo(() => {
    if (!features.length) return 1;
    return Math.max(...features.map((d) => d.rv)) * 1.15 || 1;
  }, [features]);

  const size = 500;
  const center = size / 2;
  const radius = 160;
  const total = features.length;

  const getCoordinates = (index, value) => {
    const angle = (Math.PI * 2 / total) * index - Math.PI / 2;
    const r = (value / maxRv) * radius;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const polygonPoints = useMemo(() => {
    return features
      .map((d, i) => {
        const { x, y } = getCoordinates(i, d.rv);
        return `${x},${y}`;
      })
      .join(' ');
  }, [features, maxRv]);

  const rings = [0.25, 0.5, 0.75, 1.0];

  return (
    <div className="rounded-2xl border  dark:border-darkBorder bg-white dark:bg-darkCard shadow-float overflow-auto ">
      {/* Card header */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b  dark:border-darkBorder/70 bg-gradient-to-b from-tint/70 to-transparent dark:from-darkBg/50 px-6 py-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent/10 text-accent">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="4" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
            </svg>
          </span>
          <div>
            <p className="text-[13px] font-bold text-ink dark:text-darkText leading-none">Feature Attribution Radar</p>
            <p className="mt-1 text-[11px] text-muted dark:text-darkMuted leading-none">
              All {total} parameters · radius on a square-root scale · exact mean |SHAP| printed per spoke
            </p>
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-col lg:flex-row items-center justify-between gap-8 px-6 py-6 select-none">
      {/* Radar Web SVG Graphic */}
      <div className="w-full max-w-[460px] flex justify-center">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full overflow-visible">
          <defs>
            <radialGradient id="radarSweep" cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="#0D8282" stopOpacity="0.3" />
              <stop offset="80%" stopColor="#0D8282" stopOpacity="0.08" />
              <stop offset="100%" stopColor="#0D8282" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="beamGradient" x1="0%" y1="100%" x2="0%" y2="0%">
              <stop offset="0%" stopColor="#0D8282" stopOpacity="0.1" />
              <stop offset="100%" stopColor="#0D8282" stopOpacity="0.8" />
            </linearGradient>
          </defs>

          {/* Live Sweeping Scanner Beam */}
          <g
            className="origin-center animate-[spin_10s_linear_infinite] pointer-events-none"
            style={{ transformOrigin: `${center}px ${center}px` }}
          >
            {/* Sweep sector */}
            <path
              d={`M ${center} ${center} L ${center + radius * Math.cos(-Math.PI / 6)} ${center + radius * Math.sin(-Math.PI / 6)} A ${radius} ${radius} 0 0 1 ${center} ${center - radius} Z`}
              fill="url(#radarSweep)"
              opacity="0.6"
            />
            {/* Scanner line */}
            <line
              x1={center}
              y1={center}
              x2={center}
              y2={center - radius}
              stroke="url(#beamGradient)"
              strokeWidth="1.8"
            />
          </g>

          {/* Concentric Calibration Rings */}
          {rings.map((factor, i) => (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius * factor}
              fill="none"
              className="stroke-line/70 dark:stroke-darkBorder/70"
              strokeWidth="1"
              strokeDasharray={i === rings.length - 1 ? undefined : '3 3'}
            />
          ))}

          {/* Radial Spokes */}
          {features.map((d, i) => {
            const { x, y } = getCoordinates(i, maxRv);
            return (
              <line
                key={i}
                x1={center}
                y1={center}
                x2={x}
                y2={y}
                className="stroke-line/70 dark:stroke-darkBorder/70"
                strokeWidth="1"
              />
            );
          })}

          {/* Filled Radar Web Polygon */}
          <polygon
            points={polygonPoints}
            className="fill-accent/20 dark:fill-accent/25 stroke-accent transition-all duration-500 ease-out"
            strokeWidth="2.5"
            strokeLinejoin="round"
          />

          {/* Glowing Vertices */}
          {features.map((d, i) => {
            const { x, y } = getCoordinates(i, d.rv);
            const isHovered = hoveredFeature === d.feature;
            return (
              <g
                key={d.feature}
                className="cursor-pointer transition-transform duration-300"
                onMouseEnter={() => setHoveredFeature(d.feature)}
                onMouseLeave={() => setHoveredFeature(null)}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={isHovered ? 10 : 6.5}
                  className="fill-accent transition-all duration-300"
                  fillOpacity={isHovered ? 0.45 : 0.22}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={isHovered ? 5.5 : 4}
                  className="fill-accent transition-all duration-300 shadow-sm"
                />
                <circle cx={x} cy={y} r="1.5" fill="#FFFFFF" className="transition-all" />
              </g>
            );
          })}

          {/* Outer Feature Labels */}
          {features.map((d, i) => {
            const { x, y } = getCoordinates(i, maxRv * 1.18);
            const isHovered = hoveredFeature === d.feature;
            const isRight = x > center + 10;
            const isLeft = x < center - 10;
            const textAnchor = isRight ? 'start' : isLeft ? 'end' : 'middle';
            const title = d.label;

            return (
              <g
                key={d.feature}
                className="cursor-pointer"
                onMouseEnter={() => setHoveredFeature(d.feature)}
                onMouseLeave={() => setHoveredFeature(null)}
              >
                <text
                  x={x}
                  y={y}
                  textAnchor={textAnchor}
                  fontSize="10.5"
                  fontWeight={isHovered ? '700' : '600'}
                  className={`transition-colors ${
                    isHovered ? 'fill-accent dark:fill-accent' : 'fill-ink dark:fill-darkText'
                  }`}
                >
                  {title}
                </text>
                <text
                  x={x}
                  y={y + 12}
                  textAnchor={textAnchor}
                  fontSize="9.5"
                  className="fill-muted dark:fill-darkMuted"
                  style={MONO}
                >
                  {d.mean_abs_shap.toFixed(3)} / {d.share.toFixed(0)}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Side Attribution Summary (Clean, borderless list) */}
      <div className="w-full lg:w-72 space-y-1.5 border-t lg:border-t-2 lg:border-l rounded-md border-b-2 border-r-2 border-accent dark:border-darkBorder/60 pt-4 lg:pt-0 lg:pl-8">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted dark:text-darkMuted mb-1">
          Relative Feature Attribution
        </p>
        <p className="text-[10px] leading-relaxed text-muted dark:text-darkMuted mb-2.5">
          All {total} parameters, each with its share of total attribution.
        </p>

        {features.map((d, i) => {
          const isHovered = hoveredFeature === d.feature;
          const title = d.label;
          return (
            <div
              key={d.feature}
              onMouseEnter={() => setHoveredFeature(d.feature)}
              onMouseLeave={() => setHoveredFeature(null)}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1 transition-colors cursor-pointer text-xs ${
                isHovered
                  ? 'bg-tint dark:bg-darkBorder font-semibold text-accent'
                  : 'text-ink dark:text-darkText hover:bg-[#FAF9F5] dark:hover:bg-darkCardHover'
              }`}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span style={MONO} className="text-[10px] text-muted dark:text-darkMuted w-4">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className="truncate"
                  title={`${title} · ${d.stageLabel} · mean |SHAP| ${d.mean_abs_shap.toFixed(3)}`}
                >
                  {title}
                </span>
              </div>
              <span style={MONO} className="text-[11px] font-bold ml-2 shrink-0 whitespace-nowrap">
                {d.mean_abs_shap.toFixed(3)}
                <span className="ml-1 text-[10px] font-medium text-muted dark:text-darkMuted">
                  {d.share.toFixed(0)}%
                </span>
              </span>
            </div>
          );
        })}
      </div>
      </div>

      {/* Card footer */}
      
    </div>
  );
}
