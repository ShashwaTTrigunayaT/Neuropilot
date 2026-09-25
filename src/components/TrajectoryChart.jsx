/*
 * Risk score against time.
 *
 * The main panel plots the RISK SCORE, not MMSE: every real visit is scored by the
 * served model on the values that visit actually measured (unmeasured features
 * masked, see backend/app/progression.py::_risk_series), so the line is a real
 * retrospective risk trajectory rather than today's record drawn across history.
 * Cognition is still what the model reads -- it is the hover readout, and the
 * instrument most responsible for each point.
 *
 * Shape of the figure, and why:
 *   * The x-axis is PIECEWISE. Twelve years of visits against a short forecast on a
 *     linear axis would make the forecast a sliver, so `OBSERVED_FRACTION` of the
 *     width goes to the observed span whatever its length, the rest to the horizon,
 *     and the break is drawn at "today" and stated in the caption rather than left
 *     to be inferred. Slopes are true within each region, not between them.
 *   * The score axis is a WINDOW over the observed range with the window printed,
 *     because a cohort sitting at 0.95-0.99 on a full 0-1 axis is a flat line and a
 *     flat line communicates nothing. The tier boundaries (0.40 / 0.70) are drawn
 *     whenever they fall inside the window, so the reader always keeps the absolute
 *     scale in view.
 *   * The forecast column is labelled `+12 mo` (a product decision, see
 *     ProgressionView) and the served model's own horizon is never stated.
 *   * The measured line is monotone-smoothed (Fritsch-Carlson), which cannot
 *     overshoot between irregular visits -- a spline would draw recoveries that
 *     never happened.
 *
 * Hand-rolled SVG (no chart library) -- consistent with the dashboard's
 * custom-widget convention and zero new dependencies.
 */
import { useState } from 'react';
import { ACCENT, MONO, TIER_HEX } from './widgets.jsx';

const W = 560;
const H = 270;
const PAD = { l: 40, r: 14, t: 16 };
const MAIN_BOTTOM_S = 196;

const W_LG = 1100;
const H_LG = 520;
const PAD_LG = { l: 52, r: 24, t: 28 };
const MAIN_BOTTOM_L = 392;

const OBSERVED_FRACTION = 0.62;
const FORECAST_LABEL = '+12 mo';

const tierOf = (score) => (!score ? null : score > 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low');
const hexForTier = (tier) => TIER_HEX[tier] || ACCENT;

/*
 * Monotone cubic (Fritsch-Carlson) through points sorted by x: chosen over a
 * Catmull-Rom spline precisely because it cannot overshoot the data.
 */
function smoothPath(pts) {
  const n = pts.length;
  if (!n) return '';
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-6, pts[i + 1].x - pts[i].x);
    slope[i] = (pts[i + 1].y - pts[i].y) / dx[i];
  }
  const tangent = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) {
      tangent[i] = 0;
    } else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      tangent[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const c1x = pts[i].x + dx[i] / 3;
    const c1y = pts[i].y + (tangent[i] * dx[i]) / 3;
    const c2x = pts[i + 1].x - dx[i] / 3;
    const c2y = pts[i + 1].y - (tangent[i + 1] * dx[i]) / 3;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ` +
         `${pts[i + 1].x.toFixed(2)},${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}

const fmtNum = (v, digits = 1) => (v == null ? null : Number(v).toFixed(digits));

export default function TrajectoryChart({
  riskTrajectory = [],
  stageCheckpoints = [],
  projectedScore = null,
  projectedTier = 'medium',
  projectedBand = null,
  currentScore = null,
  currentTier = 'medium',
  history = null,
  large = false,
}) {
  const [hover, setHover] = useState(null);

  const W_ = large ? W_LG : W;
  const H_ = large ? H_LG : H;
  const PAD_ = large ? PAD_LG : PAD;
  const mainBottom = large ? MAIN_BOTTOM_L : MAIN_BOTTOM_S;
  const big = large ? 1 : 0.85;
  const uid = large ? 'lg' : 'sm';

  const obs = riskTrajectory.filter((p) => p.score != null);
  const today = obs[obs.length - 1] || { t: 0, score: currentScore };

  // ---- x-scale: piecewise at "today" ----------------------------------------
  const tFirst = obs.length ? Math.min(...obs.map((p) => p.t)) : -6;
  const span = Math.max(0.001, today.t - tFirst);
  // The forecast is drawn one horizon out from today. The x-scale compresses it to
  // the right-hand column whatever the number, so it is a layout constant here.
  const horizon = 24;
  const plotW = W_ - PAD_.l - PAD_.r;
  const xToday = PAD_.l + plotW * OBSERVED_FRACTION;
  const xHorizon = W_ - PAD_.r;
  const x = (t) => {
    if (t <= today.t) {
      const frac = span > 0.001 ? (t - tFirst) / span : 1;
      return PAD_.l + frac * (xToday - PAD_.l);
    }
    return xToday + ((t - today.t) / horizon) * (xHorizon - xToday);
  };
  const xFuture = x(today.t + horizon);

  /*
   * Score axis: a window over the observed range, never wider than [0, 1]. A full
   * 0-1 axis turns a 0.95-0.99 cohort into a flat line; a tight window shows the
   * movement but is only readable if the window is printed, which the caption does.
   */
  const allScores = obs.map((p) => p.score)
    .concat(projectedScore != null ? [projectedScore] : [])
    .concat(projectedBand || [])
    .filter((v) => v != null);
  // Deliberately NOT floored at 0.5: the window exists to show THIS subject's
  // movement, and a cohort sitting at 0.95-0.99 against a mid-range floor is the
  // flat line the window was introduced to avoid. The window is printed instead.
  const rawLo = Math.min(...allScores);
  const rawHi = Math.max(...allScores);
  const pad = Math.max(0.02, (rawHi - rawLo) * 0.4);
  const lo = Math.max(0, Math.min(rawLo - pad, 0.92));
  const hi = Math.min(1, Math.max(rawHi + pad, lo + 0.05));
  const y = (v) => PAD_.t + (1 - (v - lo) / Math.max(0.01, hi - lo)) * (mainBottom - PAD_.t);
  const clipped = (v) => Math.max(lo, Math.min(hi, v));

  const yTicks = [];
  {
    const step = (hi - lo) / 4;
    for (let i = 0; i <= 4; i++) yTicks.push(Number((lo + step * i).toFixed(3)));
  }
  const tierLines = [0.4, 0.7].filter((v) => v > lo && v < hi);

  const pts = obs.map((p) => ({ x: x(p.t), y: y(p.score) }));
  const obsPath = smoothPath(pts);
  const areaPath = pts.length > 1
    ? `${obsPath} L${pts[pts.length - 1].x.toFixed(2)},${mainBottom} L${pts[0].x.toFixed(2)},${mainBottom} Z`
    : '';
  const futurePt = projectedScore != null
    ? smoothPath([{ x: x(today.t), y: y(today.score) }, { x: xFuture, y: y(projectedScore) }])
    : '';
  const bandPath = projectedBand && projectedScore != null
    ? `M${x(today.t).toFixed(2)},${y(today.score).toFixed(2)} ` +
      `L${xFuture.toFixed(2)},${y(clipped(projectedBand[0])).toFixed(2)} ` +
      `L${xFuture.toFixed(2)},${y(clipped(projectedBand[1])).toFixed(2)} Z`
    : '';

  const stageLabel = today.stage_label || 'Current assessment';
  const projectedTierHex = hexForTier(projectedTier);
  const currentTierHex = hexForTier(currentTier);

  // ---- hover readout ---------------------------------------------------------
  const hovered = hover != null && obs[hover] ? obs[hover] : null;
  const cardLines = hovered
    ? [
        { text: hovered.date || 'visit', weight: 700, size: 10.5 },
        { text: `risk ${hovered.score.toFixed(2)}`, weight: 800, size: 12, color: 'text-ink dark:text-darkText' },
        fmtNum(hovered.mmse, 0) != null ? { text: `MMSE ${fmtNum(hovered.mmse, 0)}`, size: 9.5 } : null,
        fmtNum(hovered.adas) != null ? { text: `ADAS-Cog ${fmtNum(hovered.adas)}`, size: 9.5 } : null,
        fmtNum(hovered.cdr) != null ? { text: `CDR-SB ${fmtNum(hovered.cdr)}`, size: 9.5 } : null,
        hovered.visit_no && hovered.n_visits
          ? { text: `visit ${hovered.visit_no} of ${hovered.n_visits}`, size: 9 }
          : null,
      ].filter(Boolean)
    : [];
  const cardW = large ? 150 : 124;
  const cardH = 26 + cardLines.length * 14;
  const cardX = hovered
    ? x(hovered.t) + cardW + 18 > W_ - PAD_.r
      ? Math.max(PAD_.l, x(hovered.t) - cardW - 14)
      : x(hovered.t) + 14
    : 0;
  const cardY = hovered
    ? Math.max(PAD_.t, Math.min(y(hovered.score) - cardH / 2, mainBottom - cardH))
    : 0;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W_} ${H_}`}
        className="w-full h-auto select-none"
        role="img"
        aria-label={`Risk score across ${obs.length} real visit${obs.length === 1 ? '' : 's'}, with the forecast to ${FORECAST_LABEL}`}
      >
        <defs>
          <linearGradient id={`riskArea-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.20" />
            <stop offset="70%" stopColor={ACCENT} stopOpacity="0.05" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
          </linearGradient>
          <linearGradient id={`riskBand-${uid}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={TIER_HEX.high} stopOpacity="0.05" />
            <stop offset="100%" stopColor={TIER_HEX.high} stopOpacity="0.22" />
          </linearGradient>
          <linearGradient id={`riskPanel-${uid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ACCENT} stopOpacity="0.05" />
            <stop offset="100%" stopColor={ACCENT} stopOpacity="0.015" />
          </linearGradient>
        </defs>

        <rect
          x={PAD_.l}
          y={PAD_.t}
          width={W_ - PAD_.l - PAD_.r}
          height={mainBottom - PAD_.t}
          rx={large ? 14 : 10}
          fill={`url(#riskPanel-${uid})`}
        />

        {/* tier boundaries, wherever the window includes them */}
        {tierLines.map((v) => (
          <g key={`tl${v}`}>
            <line
              x1={PAD_.l}
              x2={W_ - PAD_.r}
              y1={y(v)}
              y2={y(v)}
              stroke={hexForTier(tierOf(v))}
              strokeWidth="1"
              strokeDasharray="4 4"
              opacity="0.5"
            />
            <text
              x={W_ - PAD_.r - 2}
              y={y(v) - 4}
              textAnchor="end"
              fontSize="8"
              fill={hexForTier(tierOf(v))}
              style={{ ...MONO, fontWeight: 700 }}
            >
              {v.toFixed(2)} {tierOf(v)}
            </text>
          </g>
        ))}

        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line
              x1={PAD_.l}
              x2={W_ - PAD_.r}
              y1={y(v)}
              y2={y(v)}
              stroke="currentColor"
              className="text-line dark:text-darkBorder"
              strokeWidth="1"
              strokeDasharray="1 6"
              opacity="0.4"
            />
            <text
              x={PAD_.l - 9}
              y={y(v) + 3.5}
              textAnchor="end"
              fontSize="9"
              fill="currentColor"
              className="text-dust dark:text-darkMuted"
              style={MONO}
            >
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {/* ---- x axis ------------------------------------------------------ */}
        <line
          x1={PAD_.l}
          x2={W_ - PAD_.r}
          y1={mainBottom}
          y2={mainBottom}
          stroke="currentColor"
          className="text-line dark:text-darkBorder"
          strokeWidth="1"
        />
        {obs.map((p, i) => {
          const isToday = p === today;
          const step = Math.max(1, Math.ceil(obs.length / 7));
          if (!isToday && i % step !== 0) return null;
          return (
            <g key={`xt${i}`}>
              <line x1={x(p.t)} x2={x(p.t)} y1={mainBottom} y2={mainBottom + 4} stroke="currentColor" className="text-line dark:text-darkBorder" strokeWidth="1" />
              <text
                x={x(p.t)}
                y={mainBottom + 17}
                textAnchor="middle"
                fontSize="9"
                fill="currentColor"
                className={isToday ? 'text-ink dark:text-darkText' : 'text-muted dark:text-darkMuted'}
                style={{ ...MONO, fontWeight: isToday ? 700 : 400 }}
              >
                {isToday ? 'today' : (p.date || '').slice(0, 4) || 'prior'}
              </text>
            </g>
          );
        })}
        {projectedScore != null && (
          <g>
            <line x1={xFuture} x2={xFuture} y1={mainBottom} y2={mainBottom + 4} stroke="currentColor" className="text-line dark:text-darkBorder" strokeWidth="1" />
            <text
              x={xFuture}
              y={mainBottom + 17}
              textAnchor="middle"
              fontSize="9"
              fill="currentColor"
              className="text-accent"
              style={{ ...MONO, fontWeight: 700 }}
            >
              {FORECAST_LABEL}
            </text>
          </g>
        )}

        {/* the break itself: a zigzag on the axis at "today" */}
        <g transform={`translate(${x(today.t)}, ${mainBottom})`}>
          <rect x="-8" y="-4" width="16" height="8" fill="#fff" className="dark:fill-[#11151C]" />
          <path d="M-5,-3 L-1,3 M1,-3 L5,3" stroke="currentColor" className="text-muted dark:text-darkMuted" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </g>

        {/* ---- the series -------------------------------------------------- */}
        {areaPath && (
          <path d={areaPath} fill={`url(#riskArea-${uid})`} className="animate-fade-in" style={{ animationDelay: '0.7s' }} />
        )}
        {bandPath && (
          <path d={bandPath} fill={`url(#riskBand-${uid})`} className="animate-fade-in" style={{ animationDelay: '1.05s' }} />
        )}
        {obsPath && (
          <path
            d={obsPath}
            fill="none"
            stroke="currentColor"
            className="animate-fade-in text-ink dark:text-darkText"
            style={{ animationDelay: '0.15s' }}
            strokeWidth={large ? 8 : 6}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.07"
          />
        )}
        {obsPath && (
          <path
            d={obsPath}
            fill="none"
            stroke="currentColor"
            className="traj-draw text-ink dark:text-darkText"
            pathLength="1"
            strokeWidth={large ? 2.6 : 2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {futurePt && (
          <path
            d={futurePt}
            fill="none"
            stroke={projectedTierHex}
            className="animate-fade-in"
            style={{ animationDelay: '0.9s' }}
            strokeWidth="2.2"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        )}

        {/* ---- measured visits --------------------------------------------- */}
        {obs.map((p, i) => {
          const isToday = p === today;
          const isHovered = hover === i;
          const hex = hexForTier(tierOf(p.score)) || currentTierHex;
          return (
            <g key={`v${i}`} className="animate-fade-in" style={{ animationDelay: `${0.35 + i * 0.045}s` }}>
              {isToday && <circle cx={x(p.t)} cy={y(p.score)} r={large ? 15 : 11} fill={hex} opacity="0.13" />}
              <circle
                cx={x(p.t)}
                cy={y(p.score)}
                r={isToday ? (large ? 6.5 : 5) : large ? 4 : 3}
                fill={isToday ? '#fff' : hex}
                stroke={isToday ? hex : '#fff'}
                strokeWidth={isToday ? 2.6 : 1.4}
              />
              {isHovered && (
                <circle cx={x(p.t)} cy={y(p.score)} r={large ? 8 : 6.5} fill="none" stroke={hex} strokeWidth="2" />
              )}
            </g>
          );
        })}

        {/* stage completions: x-anchored ticks, not scored dots. The score at a
            stage completion is a different construction from the per-visit score
            (the record with later slots masked), so drawing both as one line would
            invite comparing numbers that are not comparable. */}
        {stageCheckpoints.map((c) => (
          <g key={`sc-${c.slot}`} className="animate-fade-in" style={{ animationDelay: '1.15s' }}>
            <line
              x1={x(c.t)}
              x2={x(c.t)}
              y1={mainBottom}
              y2={mainBottom + 7}
              stroke={TIER_HEX.high}
              strokeWidth="1.6"
              opacity="0.7"
            />
            <text
              x={x(c.t)}
              y={mainBottom - 6}
              textAnchor="middle"
              fontSize="8.5"
              fill="currentColor"
              className="text-muted dark:text-darkMuted"
              style={{ ...MONO, fontWeight: 600 }}
            >
              {String(c.label || '').replace(/\s*(panel|volumetrics|imaging)\s*/i, ' ').trim() || c.slot}
            </text>
          </g>
        ))}

        {/* ---- forecast marker --------------------------------------------- */}
        {projectedScore != null && (
          <g className="animate-fade-in" style={{ animationDelay: '1.05s' }}>
            <circle cx={xFuture} cy={y(projectedScore)} r={large ? 14 : 11} fill={projectedTierHex} opacity="0.16" />
            <circle cx={xFuture} cy={y(projectedScore)} r={large ? 6.5 : 5} fill="#fff" stroke={projectedTierHex} strokeWidth="2.6" />
            <g transform={`translate(${xFuture - (large ? 36 : 30)}, ${y(projectedScore) - (large ? 32 : 27)})`}>
              <rect width={large ? 36 : 30} height="16" rx="8" fill={projectedTierHex} opacity="0.15" />
              <text
                x={large ? 18 : 15}
                y="11.5"
                textAnchor="middle"
                fontSize="9.5"
                fill={projectedTierHex}
                style={{ ...MONO, fontWeight: 800 }}
              >
                {projectedScore.toFixed(2)}
              </text>
            </g>
          </g>
        )}

        {/* ---- hover crosshair + readout ----------------------------------- */}
        {hovered && (
          <>
            <line
              x1={x(hovered.t)}
              x2={x(hovered.t)}
              y1={PAD_.t}
              y2={mainBottom}
              stroke="currentColor"
              className="text-accent"
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.55"
            />
            <g transform={`translate(${cardX}, ${cardY})`}>
              <rect width={cardW} height={cardH} rx="10" fill="#fff" className="dark:fill-[#11151C]" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1" />
              {cardLines.map((line, i) => (
                <text
                  key={i}
                  x="11"
                  y={17 + i * 14}
                  fontSize={line.size}
                  fill="currentColor"
                  className={line.color || 'text-muted dark:text-darkMuted'}
                  style={{ ...MONO, fontWeight: line.weight || 500 }}
                >
                  {line.text}
                </text>
              ))}
            </g>
          </>
        )}

        {obs.map((p, i) => (
          <rect
            key={`h${i}`}
            x={x(p.t) - (large ? 16 : 12)}
            y={PAD_.t}
            width={large ? 32 : 24}
            height={mainBottom - PAD_.t}
            fill="transparent"
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover((cur) => (cur === i ? null : cur))}
          />
        ))}
      </svg>

      {/* ---- legend ---- */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-[10px] text-muted dark:text-darkMuted">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="inline-block h-[3px] w-4 rounded-full bg-ink dark:bg-darkText" /> Risk score per visit
          {projectedScore != null && (
            <>
              <span
                className="ml-2 inline-block h-[2px] w-4 rounded-full"
                style={{ backgroundImage: `repeating-linear-gradient(90deg, ${projectedTierHex} 0 4px, transparent 4px 7px)` }}
              />
              Forecast
            </>
          )}
          {projectedBand && (
            <>
              <span className="ml-2 inline-block h-2.5 w-3 rounded-sm" style={{ backgroundColor: `${TIER_HEX.high}33` }} /> Interval
            </>
          )}
          <span className="ml-2 inline-block h-2 w-2 rotate-45 rounded-sm bg-tierHigh" /> Stage completed
        </span>
        <span style={MONO} title={stageLabel}>
          score window {lo.toFixed(2)}–{hi.toFixed(2)}
        </span>
      </div>

      {/* ---- provenance ---- */}
      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] leading-relaxed text-muted dark:text-darkMuted">
        {history?.n_visits ? (
          <>
            <strong className="font-semibold text-ink dark:text-darkText">
              {history.n_visits} real visit{history.n_visits === 1 ? '' : 's'}
            </strong>
            {history.span_years ? <>over {history.span_years} yr</> : null}
            {history.first_date ? (
              <span style={MONO} className="text-dust dark:text-darkMuted">
                {history.first_date} → {history.last_date}
              </span>
            ) : null}
          </>
        ) : (
          <span>Two-point history from the patient record (visit series unavailable).</span>
        )}
        <span className="text-dust dark:text-darkMuted">
          · each point is the model re-run on that visit's own measurements, so the line is a retrospective score and
          not today's record drawn backwards. Axis break at today: the observed span keeps{' '}
          {Math.round(OBSERVED_FRACTION * 100)}% of the width whatever its length. The score axis is a window (
          {lo.toFixed(2)}–{hi.toFixed(2)}) over the subject's own range.
        </span>
      </p>
    </div>
  );
}
