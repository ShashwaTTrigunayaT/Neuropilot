import { useState, useMemo } from 'react';
import { MONO } from './widgets.jsx';

const FEATURE_NAMES = {
  mmse: 'Mini-Mental State (MMSE)',
  study_years: 'Observation Window',
  nwbv: 'Normalized Brain Volume (nWBV)',
  education_years: 'Education Level',
  age: 'Patient Age',
  sex: 'Biological Sex',
  etiv: 'Intracranial Volume (eTIV)',
  ses: 'SES',
  asf: 'ASF',
  cdr_prior: 'Prior CDR Score',
  cognitive_assessment: 'Cognitive Score',
};

export default function FeatureRadarChart({ data = [] }) {
  const [hoveredFeature, setHoveredFeature] = useState(null);

  const sortedData = useMemo(() => {
    return [...data].sort((a, b) => b.mean_abs_shap - a.mean_abs_shap);
  }, [data]);

  const maxVal = useMemo(() => {
    if (!sortedData.length) return 0.5;
    return Math.max(...sortedData.map((d) => d.mean_abs_shap)) * 1.15 || 0.4;
  }, [sortedData]);

  const size = 500;
  const center = size / 2;
  const radius = 160;
  const total = sortedData.length;

  const getCoordinates = (index, value) => {
    const angle = (Math.PI * 2 / total) * index - Math.PI / 2;
    const r = (value / maxVal) * radius;
    return {
      x: center + r * Math.cos(angle),
      y: center + r * Math.sin(angle),
    };
  };

  const polygonPoints = useMemo(() => {
    return sortedData
      .map((d, i) => {
        const { x, y } = getCoordinates(i, d.mean_abs_shap);
        return `${x},${y}`;
      })
      .join(' ');
  }, [sortedData, maxVal]);

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
            <p className="mt-1 text-[11px] text-muted dark:text-darkMuted leading-none">Global SHAP drivers across all features</p>
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
          {sortedData.map((d, i) => {
            const { x, y } = getCoordinates(i, maxVal);
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
          {sortedData.map((d, i) => {
            const { x, y } = getCoordinates(i, d.mean_abs_shap);
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
          {sortedData.map((d, i) => {
            const { x, y } = getCoordinates(i, maxVal * 1.18);
            const isHovered = hoveredFeature === d.feature;
            const isRight = x > center + 10;
            const isLeft = x < center - 10;
            const textAnchor = isRight ? 'start' : isLeft ? 'end' : 'middle';
            const title = FEATURE_NAMES[d.feature] || d.feature;

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
                  {d.mean_abs_shap.toFixed(3)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Side Attribution Summary (Clean, borderless list) */}
      <div className="w-full lg:w-72 space-y-1.5 border-t lg:border-t-2 lg:border-l rounded-md border-b-2 border-r-2 border-accent dark:border-darkBorder/60 pt-4 lg:pt-0 lg:pl-8">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted dark:text-darkMuted mb-3">
          Relative Feature Attribution
        </p>
        {sortedData.map((d, i) => {
          const isHovered = hoveredFeature === d.feature;
          const title = FEATURE_NAMES[d.feature] || d.feature;
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
                <span className="truncate" title={title}>
                  {title}
                </span>
              </div>
              <span style={MONO} className="text-[11px] font-bold ml-2 shrink-0">
                {d.mean_abs_shap.toFixed(3)}
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
