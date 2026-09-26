import { useState, useMemo } from 'react';
import { MONO, STAGE_FILLS } from './widgets.jsx';

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

const lighten = (hex, amt = 0.32) => {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const f = (c) => Math.round(Math.min(255, Math.max(0, c + (255 - c) * amt)));
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
};
const RADAR_TITLE = 'Feature Attribution Radar';

/*
 * NOTE: `data` is the SERVED (refined) model's attribution. The retained
 * cross-sectional family ranks features very differently -- it is led by
 * ADAS-Cog/MMSE, because a cognitive scale is the best predictor of a cognitive
 * diagnosis, while the refined model is led by amyloid/tau PET. The heading names
 * the model so this chart is never mistaken for an explanation of a different
 * family's scores.
 *
 * HOW IT READS — radar and ranking are one instrument, not two:
 *   The radar carries the SHAPE (where the model's attention sits around the
 *   workup), the list carries the ORDER and the exact numbers. Each spoke is
 *   numbered with its rank, so a wedge in the web and a row in the list are the
 *   same feature at a glance, and hovering either one lights up both.
 *
 * All 15 parameters keep their own spoke. The raw mean |SHAP| values span two
 * orders of magnitude, so a linear max-normalized radius pinned the top two
 * spokes to the outer ring and flattened the rest to the centre. The radius is
 * therefore on a SQUARE-ROOT scale -- stated in the header, never silent --
 * while every spoke and every row prints its untransformed value.
 */
export default function FeatureRadarChart({ data = [] }) {
  const [hoveredFeature, setHoveredFeature] = useState(null);

  const features = useMemo(() => {
    const total = data.reduce((a, d) => a + (d.mean_abs_shap || 0), 0) || 1;
    return data
      .map((d) => {
        const stage = STAGE_OF[d.feature] ?? 1;
        return {
          ...d,
          stage,
          stageLabel: STAGE_LABEL[stage],
          hex: STAGE_FILLS[stage - 1],
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

  const maxShare = useMemo(
    () => Math.max(...features.map((d) => d.share), 1) || 1,
    [features]
  );

  const size = 500;
  const center = size / 2;
  const radius = 172;
  const total = features.length;

  const coords = (index, value) => {
    const angle = ((Math.PI * 2) / total) * index - Math.PI / 2;
    const r = (value / maxRv) * radius;
    return { x: center + r * Math.cos(angle), y: center + r * Math.sin(angle) };
  };

  const polygonPoints = features.map((d, i) => {
    const { x, y } = coords(i, d.rv);
    return `${x},${y}`;
  }).join(' ');

  const rings = [0.25, 0.5, 0.75, 1];
  const hovered = features.find((d) => d.feature === hoveredFeature) || null;
  const stagesPresent = [...new Set(features.map((d) => d.stage))].sort();

  const focus = (feature) => setHoveredFeature(feature);

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-white shadow-float dark:border-darkBorder dark:bg-darkCard">
      {/* ---------------------------------------------------------- header */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line/70 bg-gradient-to-b from-tint/60 to-transparent px-4 py-4 sm:px-6 dark:border-darkBorder/70 dark:from-darkBg/50">
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-inset ring-accent/20">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <circle cx="12" cy="12" r="4" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2" />
            </svg>
          </span>
          <div>
            <p className="text-[13.5px] font-bold leading-none text-ink dark:text-darkText">{RADAR_TITLE}</p>
            <p className="mt-1.5 text-[11px] leading-none text-muted dark:text-darkMuted">
              Served model · all {total} parameters · radius on a √ scale · exact mean |SHAP| per spoke
            </p>
          </div>
        </div>

        {/* the four stages the spokes are coloured by — the radar's own key */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          {stagesPresent.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold text-muted dark:text-darkMuted">
              <span className="h-2 w-2 rounded-full" style={{ background: STAGE_FILLS[s - 1] }} />
              {STAGE_LABEL[s]}
              <span style={MONO} className="font-bold tabular-nums text-dust dark:text-darkMuted">
                {features.filter((d) => d.stage === s).length}
              </span>
            </span>
          ))}
        </div>
      </div>

      {/* ------------------------------------------------------------ body */}
      <div className="flex select-none flex-col items-center gap-8 px-4 py-6 sm:px-6 lg:flex-row lg:items-stretch lg:gap-10">
        {/* ---- the web ---- */}
        <div className="relative flex w-full max-w-[440px] shrink-0 items-center justify-center">
          {/* the light the web sits in */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-6 rounded-full bg-[radial-gradient(closest-side,var(--accent-wash-mid),transparent_76%)] blur-xl dark:bg-[radial-gradient(closest-side,var(--accent-ring),transparent_76%)]"
          />

          <svg viewBox={`0 0 ${size} ${size}`} className="relative w-full overflow-visible">
            <defs>
              <linearGradient id="radarFill" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.34" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.1" />
              </linearGradient>
            </defs>

            {/* calibration rings — dashed except the outer frame */}
            {rings.map((f, i) => (
              <circle
                key={f}
                cx={center}
                cy={center}
                r={radius * f}
                fill="none"
                className="stroke-line/60 dark:stroke-darkBorder/60"
                strokeWidth="1"
                strokeDasharray={i === rings.length - 1 ? undefined : '3 4'}
              />
            ))}

            {/* spokes, each lit when its feature is in focus */}
            {features.map((d, i) => {
              const { x, y } = coords(i, maxRv);
              const on = hoveredFeature === d.feature;
              return (
                <line
                  key={d.feature}
                  x1={center}
                  y1={center}
                  x2={x}
                  y2={y}
                  className={on ? 'stroke-accent' : 'stroke-line/70 dark:stroke-darkBorder/70'}
                  strokeWidth={on ? 1.8 : 1}
                />
              );
            })}

            {/* the web itself */}
            <polygon
              points={polygonPoints}
              fill="url(#radarFill)"
              className="stroke-accent transition-all duration-500 ease-out"
              strokeWidth="2.4"
              strokeLinejoin="round"
            />

            {/* vertices, in the colour of the stage each parameter belongs to */}
            {features.map((d, i) => {
              const { x, y } = coords(i, d.rv);
              const on = hoveredFeature === d.feature;
              return (
                <g key={`v-${d.feature}`} className="cursor-pointer" onMouseEnter={() => focus(d.feature)} onMouseLeave={() => focus(null)}>
                  <circle cx={x} cy={y} r={on ? 11 : 7} fill={d.hex} fillOpacity={on ? 0.32 : 0.18} className="transition-all duration-300" />
                  <circle cx={x} cy={y} r={on ? 5.5 : 4} fill={d.hex} className="transition-all duration-300" />
                  <circle cx={x} cy={y} r="1.4" fill="#FFFFFF" />
                </g>
              );
            })}

            {/* rank numbers, so a spoke and a row are the same thing */}
            {features.map((d, i) => {
              const { x, y } = coords(i, maxRv * 1.09);
              const on = hoveredFeature === d.feature;
              const isRight = x > center + 6;
              const isLeft = x < center - 6;
              return (
                <text
                  key={`n-${d.feature}`}
                  x={x}
                  y={y + 3.5}
                  textAnchor={isRight ? 'start' : isLeft ? 'end' : 'middle'}
                  fontSize="10.5"
                  fontWeight={on ? 800 : 600}
                  style={MONO}
                  className={`cursor-pointer transition-colors ${on ? 'fill-accent' : 'fill-muted dark:fill-darkMuted'}`}
                  onMouseEnter={() => focus(d.feature)}
                  onMouseLeave={() => focus(null)}
                >
                  {String(i + 1).padStart(2, '0')}
                </text>
              );
            })}
          </svg>
        </div>

        {/*
         * The ranking list. Desktop only: on a phone the radar is the whole
         * attribution, and the list of thirty spokes beside it was just a second
         * rendering of the same numbers. Below `lg` the web stands alone.
         */}
        <div className="hidden min-w-0 flex-1 flex-col lg:flex">
          <div className="flex items-baseline justify-between gap-4">
            <p className="text-[10.5px] font-bold uppercase tracking-[0.16em] text-muted dark:text-darkMuted">
              Relative feature attribution
            </p>
            <p style={MONO} className="text-[10px] tabular-nums text-dust dark:text-darkMuted">
              mean |SHAP| · share
            </p>
          </div>

          {/* the readout replaces the caption rather than pushing the list down */}
          <p className="mt-2 h-4 text-[11px] leading-4 text-muted dark:text-darkMuted">
            {hovered ? (
              <span className="flex items-center gap-2">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: hovered.hex }} />
                <span className="font-semibold text-ink dark:text-darkText">{hovered.label}</span>
                <span>· {hovered.stageLabel}</span>
              </span>
            ) : (
              <span>Ranked by the served model&rsquo;s mean absolute SHAP value.</span>
            )}
          </p>

          <ol className="mt-3 space-y-0.5">
            {features.map((d, i) => {
              const on = hoveredFeature === d.feature;
              return (
                <li
                  key={d.feature}
                  onMouseEnter={() => focus(d.feature)}
                  onMouseLeave={() => focus(null)}
                  title={`${String(i + 1).padStart(2, '0')} · ${d.label} — ${d.stageLabel} · mean |SHAP| ${d.mean_abs_shap.toFixed(3)} · ${d.share.toFixed(1)}% of total attribution`}
                  className={`flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[5px] transition-colors ${
                    on ? 'bg-tint dark:bg-darkCardHover' : 'hover:bg-tint/60 dark:hover:bg-darkCardHover/60'
                  }`}
                >
                  <span style={MONO} className="w-5 shrink-0 text-[10px] tabular-nums text-dust dark:text-darkMuted">
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: d.hex }} />

                  <span
                    className={`min-w-0 flex-1 truncate text-[11.5px] ${
                      on ? 'font-semibold text-accent' : 'font-medium text-ink dark:text-darkText'
                    }`}
                  >
                    {d.label}
                  </span>

                  {/* the share, as length — width is share of the strongest feature */}
                  <span className="hidden h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-line/50 sm:block dark:bg-darkBorder/60">
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${(d.share / maxShare) * 100}%`,
                        background: `linear-gradient(90deg, ${d.hex}, ${lighten(d.hex, 0.3)})`,
                      }}
                    />
                  </span>

                  <span style={MONO} className="w-[42px] shrink-0 text-right text-[11px] font-bold tabular-nums text-ink dark:text-darkText">
                    {d.mean_abs_shap.toFixed(3)}
                  </span>
                  <span style={MONO} className="w-[34px] shrink-0 text-right text-[10px] tabular-nums text-muted dark:text-darkMuted">
                    {d.share.toFixed(0)}%
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
