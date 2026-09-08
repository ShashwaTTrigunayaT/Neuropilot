/*
 * 12-month MMSE trajectory: observed history → predicted future with an
 * uncertainty band and the current diagnostic stage annotated at "today".
 * Optionally overlays the risk score at the moment each stage test completed
 * (diamond markers on a secondary right-hand axis).
 * Hand-rolled SVG (no chart library) — consistent with the dashboard's
 * custom-widget convention and zero new dependencies.
 */
import { TIER_HEX } from './widgets.jsx';

const W = 560;
const H = 190;
const PAD = { l: 34, r: 14, t: 14, b: 26 };
// Full-page variant: taller canvas, more breathing room
const W_LG = 760;
const H_LG = 300;
const PAD_LG = { l: 40, r: 18, t: 18, b: 32 };

export default function TrajectoryChart({ trajectory = [], scoreCheckpoints = [], large = false }) {
  const W = large ? W_LG : 560;
  const H = large ? H_LG : 190;
  const PAD = large ? PAD_LG : { l: 34, r: 14, t: 14, b: 26 };
  const PAD_R = scoreCheckpoints.length > 0 ? 44 : PAD.r; // room for the score axis
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

  const x = (t) => PAD.l + ((t + 6) / 18) * (W - PAD.l - PAD_R);
  const y = (v) => PAD.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - PAD.t - PAD.b);
  // Secondary axis: risk score 0-1 on the right edge
  const yScore = (s) => PAD.t + (1 - s) * (H - PAD.t - PAD.b);

  const gridLines = [];
  for (let v = Math.ceil(lo); v <= Math.floor(hi); v += 2) gridLines.push(v);

  const obsPath = obs.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.t)},${y(p.mmse)}`).join(' ');
  const dashPath =
    future && today.mmse != null ? `M${x(today.t)},${y(today.mmse)} L${x(future.t)},${y(future.mmse)}` : '';
  const bandArea =
    future && today.mmse != null
      ? `M${x(today.t)},${y(today.mmse)} L${x(future.t)},${y(future.lo)} L${x(future.t)},${y(future.hi)} Z`
      : '';
  const bandWidth = future ? Math.max(2, x(future.t) - x(today.t)) : 0;
  const bandLeft = today.t >= 0 ? x(today.t) : x(today.t);
  const bandRectLeft = Math.min(x(today.t), x(future?.t ?? 0));

  const stageLabel = today.stage_label || 'Current assessment';

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="MMSE trajectory forecast">
        {/* grid + y labels */}
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="currentColor" className="text-line dark:text-darkBorder" strokeWidth="1" strokeDasharray="2 4" opacity="0.55" />
            <text x={PAD.l - 7} y={y(v) + 3.5} textAnchor="end" fontSize="9" fill="currentColor" className="text-muted dark:text-darkMuted" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
              {v}
            </text>
          </g>
        ))}

        {/* future zone shading */}
        {future && (
          <rect x={bandRectLeft} y={PAD.t} width={Math.max(2, W - PAD.r - bandRectLeft)} height={H - PAD.t - PAD.b} fill="currentColor" className="text-accent" opacity="0.045" />
        )}
        {future && (
          <line x1={x(today.t)} x2={x(today.t)} y1={PAD.t} y2={H - PAD.b} stroke="currentColor" className="text-accent" strokeWidth="1" strokeDasharray="3 3" opacity="0.5" />
        )}

        {/* uncertainty band (triangle from today to future lo/hi) */}
        {bandArea && <path d={bandArea} fill="currentColor" className="text-tierHigh" opacity="0.13" />}

        {/* observed line */}
        {obsPath && (
          <path d={obsPath} fill="none" stroke="currentColor" className="text-ink dark:text-darkText" strokeWidth="2.4" strokeLinecap="round" />
        )}

        {/* dashed connector future */}
        {dashPath && (
          <path d={dashPath} fill="none" stroke="currentColor" className="text-tierHigh" strokeWidth="2.2" strokeDasharray="5 4" strokeLinecap="round" />
        )}

        {/* points */}
        {obs.map((p, i) => (
          <circle key={`o${i}`} cx={x(p.t)} cy={y(p.mmse)} r={p.t === 0 ? (large ? 6 : 4.6) : large ? 4.4 : 3.4} fill="currentColor" className="text-ink dark:text-darkText" />
        ))}
        {future && (
          <>
            <circle cx={x(future.t)} cy={y(future.mmse)} r={large ? 6 : 4.6} fill="currentColor" className="text-tierHigh" />
            {/* band whisker */}
            <line x1={x(future.t)} x2={x(future.t)} y1={y(future.hi)} y2={y(future.lo)} stroke="currentColor" className="text-tierHigh" strokeWidth="1.6" strokeLinecap="round" opacity="0.75" />
          </>
        )}

        {/* Stage-completion risk-score annotations (secondary axis) */}
        {scoreCheckpoints.length > 0 && (
          <>
            <line
              x1={x(scoreCheckpoints[0].t)}
              x2={x(scoreCheckpoints[scoreCheckpoints.length - 1].t)}
              y1={yScore(scoreCheckpoints[0].score)}
              y2={yScore(scoreCheckpoints[scoreCheckpoints.length - 1].score)}
              stroke="currentColor"
              className="text-accent"
              strokeWidth="1.4"
              strokeDasharray="2 3"
              opacity="0.55"
            />
            {scoreCheckpoints.map((c) => (
              <g key={c.slot}>
                <line
                  x1={x(c.t)}
                  x2={x(c.t)}
                  y1={PAD.t}
                  y2={H - PAD.b}
                  stroke="currentColor"
                  className="text-accent"
                  strokeWidth="1"
                  strokeDasharray="1.5 3"
                  opacity="0.3"
                />
                <path
                  d={`M${x(c.t)},${yScore(c.score) - 5} L${x(c.t) + 5},${yScore(c.score)} L${x(c.t)},${yScore(c.score) + 5} L${x(c.t) - 5},${yScore(c.score)} Z`}
                  fill={c.outcome === 'abnormal' ? TIER_HEX.high : c.outcome === 'inconclusive' ? TIER_HEX.medium : TIER_HEX.low}
                  stroke="#fff"
                  strokeWidth="1"
                />
                <text
                  x={x(c.t)}
                  y={yScore(c.score) - 9}
                  textAnchor="middle"
                  fontSize="8.5"
                  fill="currentColor"
                  className="text-ink dark:text-darkText"
                  style={{ fontFamily: 'IBM Plex Mono, monospace', fontWeight: 600 }}
                >
                  {c.score.toFixed(2)}
                </text>
                <text
                  x={x(c.t)}
                  y={H - PAD.b + 11}
                  textAnchor="middle"
                  fontSize="7.5"
                  fill="currentColor"
                  className="text-accent"
                  style={{ fontFamily: 'IBM Plex Mono, monospace' }}
                >
                  {c.label}
                </text>
            </g>
            ))}
            {/* score axis ticks (right) */}
            {[0, 0.25, 0.5, 0.75, 1].map((s) => (
              <text
                key={`s${s}`}
                x={W - PAD_R + 6}
                y={yScore(s) + 3}
                fontSize="8"
                fill="currentColor"
                className="text-muted dark:text-darkMuted"
                style={{ fontFamily: 'IBM Plex Mono, monospace' }}
              >
                {s.toFixed(2)}
              </text>
            ))}
          </>
        )}

        {/* x-axis month labels */}
        {trajectory.map((p, i) => (
          <text key={`x${i}`} x={x(p.t)} y={H - 8} textAnchor="middle" fontSize="9" fill="currentColor" className="text-muted dark:text-darkMuted" style={{ fontFamily: 'IBM Plex Mono, monospace' }}>
            {p.t === 0 ? 'today' : `${p.t > 0 ? '+' : ''}${p.t}mo`}
          </text>
        ))}
      </svg>

      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-muted dark:text-darkMuted">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 rounded bg-ink dark:bg-darkText" /> Observed
          <span className="ml-2 inline-block h-0.5 w-4 rounded bg-tierHigh" style={{ backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)' }} /> Predicted
          <span className="ml-2 inline-block h-2.5 w-3 rounded-sm bg-tierHigh opacity-20" /> Uncertainty
          {scoreCheckpoints.length > 0 && (
            <>
              <span className="ml-2 inline-block h-2 w-2 rotate-45 rounded-sm bg-accent" /> Risk score at stage completion
              <span className="ml-1.5 flex items-center gap-1">
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.high }} />abn
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.medium }} />inc
                <span className="inline-block h-2 w-2 rotate-45 rounded-sm" style={{ backgroundColor: TIER_HEX.low }} />nrm
              </span>
            </>
          )}
        </span>
        <span style={{ fontFamily: 'IBM Plex Mono, monospace' }} title={stageLabel}>
          {stageLabel}
        </span>
      </div>
    </div>
  );
}
