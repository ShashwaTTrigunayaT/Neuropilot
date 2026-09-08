/*
 * 12-month MMSE trajectory: observed history → predicted future with an
 * uncertainty band and the current diagnostic stage annotated at "today".
 * Stage-completion risk scores render in a DEDICATED LANE BELOW the main
 * plot (outcome-colored diamonds on their own 0–1 axis), so they never
 * crowd the MMSE curves.
 * Hand-rolled SVG (no chart library) — consistent with the dashboard's
 * custom-widget convention and zero new dependencies.
 */
import { ACCENT, TIER_HEX } from './widgets.jsx';

const W = 560;
const H = 270;
const PAD = { l: 34, r: 14, t: 14 };
const MAIN_BOTTOM_S = 170; // small: main plot bottom
const LANE = { top: 205, h: 44 }; // small: score lane

// Full-page variant: wide canvas, main plot + score lane below
const W_LG = 1100;
const H_LG = 540;
const PAD_LG = { l: 40, r: 18, t: 22 };
const MAIN_BOTTOM_L = 356;
const LANE_L = { top: 420, h: 84 };

export default function TrajectoryChart({ trajectory = [], scoreCheckpoints = [], projectedScore = null, projectedTier = 'medium', large = false }) {
  const W_ = large ? W_LG : W;
  const H_ = large ? H_LG : H;
  const PAD_ = large ? PAD_LG : PAD;
  const mainBottom = large ? MAIN_BOTTOM_L : MAIN_BOTTOM_S;
  const lane = large ? LANE_L : LANE;

  const hasLane = scoreCheckpoints.length > 0;
  const obs = trajectory.filter((p) => p.kind === 'observed');
  const pred = trajectory.filter((p) => p.kind === 'predicted');
  const today = obs[obs.length - 1] || { t: 0, mmse: null };
  const future = pred[pred.length - 1] || null;

  const values = trajectory
    .map((p) => p.mmse)
    .concat(future ? [future.lo, future.hi] : [])
    .filter((v) => v != null);
  const lo = Math.max(0, Math.min(...values, 26) - 2);
  const hi = Math.min(30, Math.max(...values, 10) + 2);

  const x = (t) => PAD_.l + ((t + 6) / 18) * (W_ - PAD_.l - PAD_.r);
  const y = (v) => PAD_.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (mainBottom - PAD_.t);
  // Score lane axis: 0 at lane bottom, 1 at lane top
  const yLane = (s) => lane.top + (1 - s) * lane.h;

  const gridLines = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v += 2) gridLines.push(v);

  const obsPath = obs.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)},${y(p.mmse)}`).join(' ');
  const dashPath =
    future && today.mmse != null ? `M${x(today.t)},${y(today.mmse)} L${x(future.t)},${y(future.mmse)}` : '';
  const bandArea =
    future && today.mmse != null
      ? `M${x(today.t)},${y(today.mmse)} L${x(future.t)},${y(future.lo)} L${x(future.t)},${y(future.hi)} Z`
      : '';

  const stageLabel = today.stage_label || 'Current assessment';
  const mono = { fontFamily: 'IBM Plex Mono, monospace' };
  const big = large ? 1 : 0.85; // scale factor for marker text
  const projectedTierHex = TIER_HEX[projectedTier] || ACCENT;
  const showProjection = hasLane && typeof projectedScore === 'number';

  return (
    <div>
      <svg viewBox={`0 0 ${W_} ${H_}`} className="w-full h-auto select-none" role="img" aria-label="MMSE trajectory forecast">
        {/* ---- Main MMSE plot ---- */}
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={PAD_.l} x2={W_ - PAD_.r} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line dark:text-darkBorder" strokeWidth="1" strokeDasharray="2 4" opacity="0.55" />
            <text x={PAD_.l - 7} y={y(v) + 3.5} textAnchor="end" fontSize="9" fill="currentColor" className="text-muted dark:text-darkMuted" style={mono}>
              {v}
            </text>
          </g>
        ))}

        {/* future zone shading + today divider */}
        {future && (
          <rect x={x(today.t)} y={PAD_.t} width={Math.max(2, W_ - PAD_.r - x(today.t))} height={mainBottom - PAD_.t} fill="currentColor" className="text-accent" opacity="0.045" />
        )}
        {future && (
          <line x1={x(today.t)} x2={x(today.t)} y1={PAD_.t} y2={mainBottom} stroke="currentColor" className="text-accent" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
        )}

        {/* uncertainty band */}
        {bandArea && <path d={bandArea} fill="currentColor" className="text-tierHigh" opacity="0.13" />}

        {/* observed + predicted lines */}
        {obsPath && (
          <path d={obsPath} fill="none" stroke="currentColor" className="text-ink dark:text-darkText" strokeWidth="2.4" strokeLinecap="round" />
        )}
        {dashPath && (
          <path d={dashPath} fill="none" stroke="currentColor" className="text-tierHigh" strokeWidth="2.2" strokeDasharray="5 4" strokeLinecap="round" />
        )}

        {/* MMSE points */}
        {obs.map((p, i) => (
          <circle key={`o${i}`} cx={x(p.t)} cy={y(p.mmse)} r={p.t === 0 ? (large ? 6 : 4.6) : large ? 4.4 : 3.4} fill="currentColor" className="text-ink dark:text-darkText" />
        ))}
        {future && (
          <>
            <circle cx={x(future.t)} cy={y(future.mmse)} r={large ? 6 : 4.6} fill="currentColor" className="text-tierHigh" />
            <line x1={x(future.t)} x2={x(future.t)} y1={y(future.hi)} y2={y(future.lo)} stroke="currentColor" className="text-tierHigh" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
          </>
        )}

        {/* month labels under the main plot */}
        {trajectory.map((p, i) => (
          <text key={`x${i}`} x={x(p.t)} y={mainBottom + 16} textAnchor="middle" fontSize="9" fill="currentColor" className="text-muted dark:text-darkMuted" style={mono}>
            {p.t === 0 ? 'today' : `${p.t > 0 ? '+' : ''}${p.t}mo`}
          </text>
        ))}

        {/* ---- Score lane (below the main plot) ---- */}
        {hasLane && (
          <>
            {/* lane background + frame */}
            <rect x={PAD_.l} y={lane.top} width={W_ - PAD_.l - PAD_.r} height={lane.h} fill="currentColor" className="text-accent" opacity="0.035" rx="6" />
            {/* lane gridlines: none -- only the 0/1 axis labels stay */}
            {[0, 1].map((s) => (
              <g key={`ls${s}`}>
                <text x={PAD_.l - 7} y={yLane(s) + 3} textAnchor="end" fontSize="8" fill="currentColor" className="text-muted dark:text-darkMuted" style={mono}>
                  {s.toFixed(1)}
                </text>
              </g>
            ))}

            {/* TODAY divider across the lane */}
            <line
              x1={x(0)}
              x2={x(0)}
              y1={lane.top - 4}
              y2={lane.top + lane.h + 4}
              stroke="currentColor"
              className="text-accent"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.5"
            />

            {/* SOLID polyline through the stage-completion scores */}
            {scoreCheckpoints.length > 1 && (
              <polyline
                points={scoreCheckpoints.map((c) => `${x(c.t)},${yLane(c.score)}`).join(' ')}
                fill="none"
                stroke={ACCENT}
                strokeWidth="2.2"
                strokeLinejoin="round"
                strokeLinecap="round"
                opacity="0.9"
              />
            )}

            {/* dashed continuation to the 12-month projected score */}
            {showProjection && (
              <line
                x1={x(scoreCheckpoints[scoreCheckpoints.length - 1].t)}
                x2={x(12)}
                y1={yLane(scoreCheckpoints[scoreCheckpoints.length - 1].score)}
                y2={yLane(projectedScore)}
                stroke={ACCENT}
                strokeWidth="1.8"
                strokeDasharray="5 4"
                opacity="0.75"
              />
            )}

            {/* stage tick line: full height -- from the top of the plot,
                crossing the MMSE graph line, down into the score lane.
                Each stage gets its own color (same outcome palette as the
                diamonds) so the lines are distinguishable. */}
            {scoreCheckpoints.map((c) => {
              const hex = c.outcome === 'abnormal' ? TIER_HEX.high : c.outcome === 'inconclusive' ? TIER_HEX.medium : TIER_HEX.low;
              return (
                <line
                  key={`tick-${c.slot}`}
                  x1={x(c.t)}
                  x2={x(c.t)}
                  y1={PAD_.t}
                  y2={yLane(c.score)}
                  stroke={hex}
                  strokeWidth="1.4"
                  strokeDasharray="2 3"
                  opacity="0.55"
                />
              );
            })}

            {/* diamonds + score value + stage label */}
            {scoreCheckpoints.map((c) => {
              const hex = c.outcome === 'abnormal' ? TIER_HEX.high : c.outcome === 'inconclusive' ? TIER_HEX.medium : TIER_HEX.low;
              const r = large ? 6 : 4.5;
              return (
                <g key={c.slot}>
                  <path
                    d={`M${x(c.t)},${yLane(c.score) - r} L${x(c.t) + r},${yLane(c.score)} L${x(c.t)},${yLane(c.score) + r} L${x(c.t) - r},${yLane(c.score)} Z`}
                    fill={hex}
                    stroke="#fff"
                    strokeWidth="1.2"
                  />
                  <text
                    x={x(c.t)}
                    y={yLane(c.score) - r - 4}
                    textAnchor="middle"
                    fontSize={8.5 * big}
                    fill="currentColor"
                    className="text-ink dark:text-darkText"
                    style={{ ...mono, fontWeight: 700 }}
                  >
                    {c.score.toFixed(2)}
                  </text>
                  <text
                    x={x(c.t)}
                    y={lane.top + lane.h + 14}
                    textAnchor="middle"
                    fontSize={8 * big}
                    fill={hex}
                    style={{ ...mono, fontWeight: 600 }}
                  >
                    {c.label}
                  </text>
                </g>
              );
            })}

            {/* FINAL 12-month projected score point */}
            {showProjection && (
              <g>
              <circle
                cx={x(12)}
                cy={yLane(projectedScore)}
                r={large ? 7 : 5}
                fill={projectedTierHex}
                stroke="#fff"
                strokeWidth="1.6"
              />
              <circle cx={x(12)} cy={yLane(projectedScore)} r={large ? 11 : 8} fill="none" stroke={projectedTierHex} strokeWidth="1" opacity="0.4" />
              <text
                x={x(12)}
                y={yLane(projectedScore) - (large ? 12 : 9)}
                textAnchor="middle"
                fontSize={9 * big}
                fill={projectedTierHex}
                style={{ ...mono, fontWeight: 800 }}
              >
                {projectedScore.toFixed(2)}
              </text>
              <text
                x={x(12)}
                y={lane.top + lane.h + 14}
                textAnchor="middle"
                fontSize={8 * big}
                fill={projectedTierHex}
                style={{ ...mono, fontWeight: 700 }}
              >
                12-mo proj.
              </text>
              </g>
            )}
          </>
        )}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-muted dark:text-darkMuted">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-ink dark:bg-darkText" /> Observed
          <span className="ml-2 inline-block h-0.5 w-4 rounded bg-tierHigh" style={{ backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)' }} /> Predicted
          <span className="ml-2 inline-block h-2.5 w-3 rounded-sm bg-tierHigh opacity-20" /> Uncertainty
          {hasLane && (
            <>
              <span className="ml-2 inline-block h-2 w-2 rotate-45 rounded-sm bg-accent" /> Risk score at stage completion
              <span className="ml-1.5 flex items-center gap-1">
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.high }} />abn
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.medium }} />inc
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.low }} />nrm
              </span>
              {showProjection && (
                <span className="ml-2 flex items-center gap-1">
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full border border-white"
                    style={{ backgroundColor: projectedTierHex }}
                  />
                  12-mo projected
                </span>
              )}
            </>
          )}
        </span>
        <span style={mono} title={stageLabel}>
          {stageLabel}
        </span>
      </div>
    </div>
  );
}
