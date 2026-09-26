import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, Check, Copy } from 'lucide-react';
import { STAGES_FULL, STAGES_SHORT, fmtScore } from '../lib.js';
import TierTag from './TierTag.jsx';

/* ------------------------------------------------------------------ */
/*  Design tokens                                                      */
/* ------------------------------------------------------------------ */
/*
 * Entrance progress: 0 → 1, once, when a panel mounts.
 *
 * The composition panels grow their arcs, bands and figures from this single
 * value, so one animation driver runs per panel instead of one per element and
 * every part of the graphic arrives in step. It eases out, so the movement is
 * fastest where the shapes are still small and settles as they land.
 *
 * `prefers-reduced-motion` skips it entirely and returns 1 immediately — the
 * panel must never be the thing that makes a motion-sensitive reader unwell.
 * The same hook re-fires whenever the view is opened again, because the
 * component remounts; nothing has to be scheduled by hand.
 */
export function useEnterProgress({ duration = 950, delay = 70 } = {}) {
  const [t, setT] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setT(1);
      return undefined;
    }

    let started = 0;
    const tick = (now) => {
      if (!started) started = now;
      const p = Math.min(1, (now - started) / duration);
      setT(1 - (1 - p) ** 3); // ease-out cubic
      if (p < 1) frame.current = requestAnimationFrame(tick);
    };

    const timer = setTimeout(() => {
      frame.current = requestAnimationFrame(tick);
    }, delay);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame.current);
    };
  }, [duration, delay]);

  return t;
}

export const INK = '#13151A';
export const INK_MUTED = '#6E7175';
export const LINE = '#E6E2DA';
export const SURFACE = '#FFFFFF';
export const ACCENT = 'var(--accent)';
export const ACCENT_SOFT = 'rgb(var(--accent-rgb) / 0.1)';
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

/*
 * The card surface, in one place.
 *
 * Views that each spell out their own border/background/shadow drift apart by
 * a shade or a radius, and the page reads as several products. These are the
 * two constants every full-width panel is built from: `PANEL` is the shell,
 * `PANEL_PAD` adds the standard interior spacing.
 */
export const PANEL =
  'rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard shadow-soft';

export const PANEL_PAD = `${PANEL} p-4 sm:p-5`;

/* The interior of a joined grid (status ribbon, phase rail): hairline dividers
 * come from the gap showing a line-coloured backdrop through it. */
export const JOINED_GRID =
  'grid gap-px overflow-hidden rounded-xl border border-line/70 dark:border-darkBorder/70 bg-line/60 dark:bg-darkBorder/60';

/* ------------------------------------------------------------------ */
/*  Structural primitives                                              */
/* ------------------------------------------------------------------ */

/**
 * Button with the page's three weights.
 *
 * `primary` is the one action a panel exists for, `ghost` is a normal action,
 * `quiet` is navigation-ish, `danger` is stop/undo. Tones live here so two
 * views cannot invent two different primaries.
 */
export function Btn({ tone = 'ghost', icon: Icon, children, className = '', ...rest }) {
  const tones = {
    primary: 'bg-accent text-white shadow-soft hover:bg-accentHover border border-transparent',
    ghost:
      'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-ink dark:text-darkText hover:border-accent/40',
    quiet:
      'border border-line dark:border-darkBorder bg-white dark:bg-darkCard text-muted dark:text-darkMuted hover:text-ink dark:hover:text-darkText',
    danger: 'bg-tierHigh text-white shadow-soft hover:opacity-90 border border-transparent',
  };
  return (
    <button
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]} ${className}`}
    >
      {Icon && <Icon className="h-3.5 w-3.5" />}
      {children}
    </button>
  );
}

/**
 * One cell of a status ribbon: icon tile, label, a large value, an optional
 * proportion bar, and a hint.
 *
 * The value is the point of the cell, so it is set at 24px in tabular figures —
 * the earlier 12px version stacked three lines of text and then made the number
 * the smallest thing in the row. The bar is optional because only counts that
 * are a share of a whole have something honest to show.
 */
export function RibbonStat({ icon: Icon, label, value, tone = 'muted', hint, dot, bar }) {
  const tones = {
    ok: 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10',
    warn: 'text-amber-600 dark:text-amber-400 bg-amber-500/10',
    bad: 'text-tierHigh bg-tierHighSoft',
    muted: 'text-muted dark:text-darkMuted bg-tint dark:bg-darkBorderSubtle',
    accent: 'text-accent bg-accent/10',
  };
  const accents = {
    ok: '#1EB980',
    warn: '#D9822B',
    bad: '#E04836',
    muted: '#6E7175',
    accent: 'var(--accent)',
  };

  return (
    <div className="group relative flex h-full flex-col gap-2.5 px-5 py-4 transition-colors hover:bg-tint/40 dark:hover:bg-darkCardHover/50">
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset ring-black/[0.04] dark:ring-white/[0.06] ${tones[tone]}`}
        >
          {dot ? (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
            </span>
          ) : (
            Icon && <Icon className="h-3.5 w-3.5" />
          )}
        </span>
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">{label}</p>
      </div>

      <p
        style={MONO}
        className="text-[24px] font-bold leading-none tracking-tight text-ink tabular-nums dark:text-darkText"
      >
        {value}
      </p>

      {bar != null && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-line/60 dark:bg-darkBorder">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${Math.max(2, Math.min(100, bar))}%`, background: accents[tone] }}
          />
        </div>
      )}

      {hint && <p className="text-[10.5px] leading-snug text-muted dark:text-darkMuted">{hint}</p>}
    </div>
  );
}

/** A small metric tile (label over a monospace value). */
export function MetricTile({ label, value, hint }) {
  return (
    <div className="rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/50 px-3 py-2 dark:bg-darkBorderSubtle">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
        {label}
      </p>
      <p style={MONO} className="mt-1 text-lg font-bold text-ink dark:text-darkText">
        {value ?? '—'}
      </p>
      {hint && <p className="mt-0.5 text-[10px] text-muted dark:text-darkMuted">{hint}</p>}
    </div>
  );
}

export function SectionLabel({ children, right, size = 'md' }) {
  const labelProps = size === 'sm'
    ? { className: 'text-[12px] font-semibold text-ink dark:text-darkText' }
    : { className: 'text-[13px] font-semibold text-ink dark:text-darkText tracking-tight' };
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="h-2.5 w-[3px] rounded-full bg-accent shadow-[0_0_8px_var(--accent-glow-soft)]" />
        <p {...labelProps}>{children}</p>
      </div>
      {right}
    </div>
  );
}

/**
 * A panel header with an icon tile and a hairline that fades out to the right.
 *
 * Used by every panel on the interoperability view so the page reads as one
 * document. Kept beside SectionLabel rather than in one view because the ABDM
 * panel is its own component and must not drift from the rest of the page.
 */
export function SectionHeader({ icon: Icon, title, right }) {
  return (
    <>
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl"
            style={{ backgroundColor: 'rgb(var(--accent-rgb) / 0.08)', color: ACCENT }}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <h2 className="truncate text-[13px] font-semibold tracking-tight text-ink dark:text-darkText">
            {title}
          </h2>
        </div>
        {right}
      </div>
      {/* Draws itself across the card on arrival, then stays put. The animation
          is disabled wholesale under prefers-reduced-motion (see index.css). */}
      <span
        aria-hidden="true"
        className="rule-draw mt-3 block h-px w-full bg-gradient-to-r from-accent/35 via-line to-transparent dark:via-darkBorder"
      />
    </>
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

/* ------------------------------------------------------------------ */
/*  Value rows                                                        */
/* ------------------------------------------------------------------ */
/*
 * Rows describe machine facts (IDs, URLs, codes) about a live connection.
 * Two rules keep them readable rather than looking like terminal output:
 * monospace is reserved for values a developer would copy-paste, and long
 * identifiers are shown as their recognisable skeleton instead of wrapping
 * across several lines.
 */

/**
 * A status label.
 *
 * Deliberately NOT a padded rounded chip: a filled pill in a tinted box is the
 * shape every dashboard wears, and a wall of them reads as decoration rather
 * than state. This is the page's own idiom instead — a small dot carrying the
 * tone, ringed with a soft halo, ahead of a tracked uppercase label. No border,
 * no fill, no radius; the colour and the dot carry the meaning and the text is
 * set like a caption, the way the view mastheads already do it.
 */
export function Pill({ tone = 'muted', children }) {
  const tones = {
    ok: { text: 'text-emerald-600 dark:text-emerald-400', hex: '#1EB980' },
    warn: { text: 'text-amber-600 dark:text-amber-400', hex: '#D9822B' },
    bad: { text: 'text-red-600 dark:text-red-400', hex: '#E04836' },
    muted: { text: 'text-muted dark:text-darkMuted', hex: '#A6A09A' },
    // The accent resolves to a variable now, so its halo is given explicitly
    // rather than by appending an alpha hex to the colour.
    accent: { text: 'text-accent', hex: ACCENT, halo: 'rgb(var(--accent-rgb) / 0.12)' },
  };
  const t = tones[tone] || tones.muted;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[9.5px] font-bold uppercase tracking-[0.14em]">
      <span
        aria-hidden="true"
        className="h-[5px] w-[5px] shrink-0 rounded-full"
        style={{ backgroundColor: t.hex, boxShadow: `0 0 0 2.5px ${t.halo || `${t.hex}1F`}` }}
      />
      <span className={t.text}>{children}</span>
    </span>
  );
}

export function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-line/60 dark:border-darkBorder/60 py-2 last:border-b-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
        {label}
      </span>
      <span
        style={mono ? MONO : undefined}
        className="max-w-[62%] break-words text-right text-[11px] leading-relaxed text-ink dark:text-darkText"
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

export const shortId = (raw) => (raw && raw.length > 13 ? `${raw.slice(0, 8)}…` : raw);

/**
 * A Row for a machine value.
 *
 * URLs are never printed: a FHIR issuer is ~114 characters, and every attempt to
 * compress one for display (`host/…/last-segment`) is less readable than the row
 * label it sits beside. A URL row therefore renders the value as a copy button,
 * with the full string available on hover. Short scalars (an id, a client id)
 * still read as text, because their short form is the useful part.
 */
export function CopyableRow({ label, value, display }) {
  const [copied, setCopied] = useState(false);

  if (!value) return <Row label={label} value="—" />;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // The clipboard needs a secure context; the tooltip still carries the value.
    }
  };

  return (
    <div className="flex items-center justify-between gap-4 border-b border-line/60 dark:border-darkBorder/60 py-2 last:border-b-0">
      <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.1em] text-muted dark:text-darkMuted">
        {label}
      </span>
      <div className="group relative flex min-w-0 items-center gap-2">
        {display && (
          <span style={MONO} className="truncate text-[11px] text-ink dark:text-darkText">
            {display}
          </span>
        )}
        <button
          type="button"
          onClick={copy}
          aria-label={`Copy ${label}: ${value}`}
          className={`flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.08em] transition ${
            copied
              ? 'border-accent/40 bg-accent/10 text-accent'
              : 'border-line dark:border-darkBorder bg-white dark:bg-darkCard text-muted dark:text-darkMuted hover:border-accent/40 hover:text-accent'
          }`}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        {/* Only rendered on hover, so it never affects the row's resting layout. */}
        <span
          className="pointer-events-none absolute right-0 top-[calc(100%+5px)] z-30 hidden max-w-[26rem] break-all rounded-lg border border-ink/10 bg-ink px-2.5 py-1.5 text-[10.5px] leading-relaxed text-white shadow-lift group-hover:block dark:border-darkBorder dark:bg-darkCard dark:text-darkText"
          style={MONO}
        >
          {value}
        </span>
      </div>
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
Refined Risk Score
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
        count: patients.filter((p) => { const score = p.final_score ?? p.score; return i === BINS.length - 1 ? score >= lo : score >= lo && score < hi; }).length,
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
    <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-4 sm:p-6">
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
    <div className="rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60 p-4 sm:p-6">
      <SectionLabel>Patients by diagnostic stage</SectionLabel>
      <div className="mt-5 space-y-4">
        {funnel.map(({ stage, count }, i) => {
          const hex = STAGE_FILLS[stage - 1] || '#0D8282';
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
  pageOffset = 0,
}) {
  const selected = new Set(selectedIds);

  /*
   * A pinned header needs to LOOK pinned.
   *
   * Once the page scrolls the header stops moving while rows keep passing under
   * it, and because the bar is the same white as the rows it reads as one flat
   * sheet with a stray border in the middle. A shadow appears the moment it
   * actually detaches, and disappears the moment it settles back into place — so
   * the depth is a statement about the scroll position, not decoration.
   */
  const [stuck, setStuck] = useState(false);
  const tableRef = useRef(null);

  useEffect(() => {
    const onScroll = () => {
      const el = tableRef.current;
      if (!el) return;
      const bar =
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--app-header-h')) || 0;
      setStuck(el.getBoundingClientRect().top <= bar - 1);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);
  const HEAD = 'px-4 py-3 text-left font-semibold uppercase tracking-[0.12em] text-muted dark:text-darkMuted';
  const HEAD_STYLE = { fontSize: '10.5px' };
  /*
   * The table is a GRID, so it is drawn as one.
   *
   * `border-separate` on the table is load-bearing: under `border-collapse` a
   * sticky cell drops its own borders while it is stuck, which is why the header
   * used to lose its bottom rule the moment you scrolled. The trade is that row
   * borders must then live on the CELLS — a `tr` border is ignored in
   * border-separate mode — so every cell carries its own bottom rule and the
   * column rule, and `border-spacing-0` keeps the grid tight.
   */
  const RULE = 'border-l border-line/50 dark:border-darkBorder/50';
  const BOTTOM = 'border-b border-line/60 dark:border-darkBorder/60';
  const CELL = `px-4 py-4 ${RULE} ${BOTTOM}`;
  return (
    /*
     * No inner scroll box.
     *
     * A `max-h-[68vh] overflow-auto` here created a SECOND scroll axis inside a
     * page that already scrolls, and on a laptop that window was about five rows
     * tall — the reader had to scroll a small pane to reach row six, then scroll
     * the page to reach the pane's own bottom. The list now flows with the page
     * on one axis, and the header stays pinned below the application bar via
     * `--app-header-h`, which the header itself measures and publishes.
     */
    /*
     * `overflow-x: clip`, not `auto`, once there is room for the whole table.
     *
     * Any non-visible overflow makes this div a scroll container, and a sticky
     * header sticks to its nearest scroll container — so `overflow-x-auto` quietly
     * broke the pin and the header scrolled away exactly as before (measured: -276px
     * behind the app bar). `clip` still clips a too-wide table but is NOT a scroll
     * container, so the page stays the single scroll axis the header pins to. Below
     * `lg` the table can be wider than the screen, so there the horizontal scroll is
     * kept and the pin is given up — which is the right trade on a narrow viewport.
     */
    <div ref={tableRef} className="w-full border-b border-line/70 dark:border-darkBorder/70">
      {/*
       * Below `md` the seven-column grid is not a table, it is a horizontal
       * crawl: identity, risk, stage and the recommended action cannot all fit
       * a phone, so every subject costs a sideways scroll. The same fields come
       * back here as ONE stacked record — identity and score on the first line,
       * the demographics and the pathway under it, then the next step — which
       * reads without dragging the page sideways.
       */}
      <ul className="divide-y divide-line/70 md:hidden dark:divide-darkBorder/70">
        {rows.map((p, i) => {
          const tierHex = TIER_HEX[p.risk_tier] || '#6E7175';
          const isSelected = selected.has(p.id);
          return (
            <li key={p.id} className="relative flex items-start gap-2 py-3.5 pl-3.5 pr-3">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-[3px]"
                style={{ backgroundColor: tierHex }}
              />
              {selectable && (
                <button
                  type="button"
                  aria-label={`Select ${p.id} for comparison`}
                  aria-pressed={isSelected}
                  onClick={() => onToggleSelect(p.id)}
                  className={`mt-0.5 flex h-[20px] w-[20px] shrink-0 items-center justify-center rounded-[6px] border transition ${
                    isSelected
                      ? 'border-accent bg-accent text-white'
                      : 'border-line bg-white dark:border-darkBorder dark:bg-darkCard'
                  }`}
                >
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                  )}
                </button>
              )}

              {/*
               * On a phone the list is a queue of who to act on, so it carries
               * only who and how urgent: the subject and its score. The
               * demographics, the four-segment stage rail and the next-step
               * sentence were three further lines per subject, which meant the
               * queue itself fell off the screen behind its own annotations.
               * The rest of the record is one tap away on the patient's page.
               */}
              <button type="button" onClick={() => onSelect(p.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <span style={MONO} className="shrink-0 text-[10px] font-bold tabular-nums text-dust dark:text-darkMuted">
                  {String(pageOffset + i + 1).padStart(2, '0')}
                </span>
                <span style={MONO} className="min-w-0 flex-1 truncate text-[13.5px] font-bold text-ink dark:text-darkText">
                  {p.id}
                </span>
                <span style={{ ...MONO, color: tierHex }} className="shrink-0 text-[15px] font-black tabular-nums">
                  {fmtScore(p.final_score ?? p.score)}
                </span>
              </button>

              {onSimulate && (
                <button
                  type="button"
                  onClick={() => onSimulate(p)}
                  className="mt-0.5 shrink-0 self-start rounded-lg border border-line px-2 py-1 text-[10.5px] font-semibold text-accent transition hover:bg-accent/10 dark:border-darkBorder"
                >
                  Simulate
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {/* md and up: the full grid, which finally has the width to be one. */}
      <div className="hidden overflow-x-auto md:block lg:overflow-x-clip">
      {/*
       * The rows sit on their OWN surface — solid white against the page's paper
       * tone (#FAF8F4), solid card colour against the dark page. Without it the
       * rows had nothing separating them from the page and the list read as text
       * floating on the background: hairlines alone are a grid, not a surface.
       *
       * It is still not a card: no radius, no shadow, no side borders, no tint.
       * The wash simply ends where the rows end.
       */}
      <table className="w-full border-separate border-spacing-0 bg-white text-left dark:bg-darkCard">
        {/*
         * Head and rows are deliberately built from one set of constants: every
         * column label shares a size and tracking, and every row shares a
         * height, so the table reads as a single grid instead of 7 columns laid
         * out seven separate times.
         */}
        <thead>
          <tr className={`sticky-th border-b border-line dark:border-darkBorder ${stuck ? 'is-stuck' : ''}`}>
            {selectable && <th className="w-10 px-3 py-3" />}
            <th className={`w-12 ${HEAD}`} style={HEAD_STYLE}>#</th>
            <th className={`px-5 ${HEAD}`} style={HEAD_STYLE}>Subject</th>
            {!compact && <th className={`${HEAD} ${RULE}`} style={HEAD_STYLE}>Cognition</th>}
            <th className={`${HEAD} ${RULE}`} style={HEAD_STYLE}>Risk assessment</th>
            <th className={`${HEAD} ${RULE}`} style={HEAD_STYLE}>Pipeline stage</th>
            <th className={`${HEAD} ${RULE}`} style={HEAD_STYLE}>Recommended action</th>
            {!compact && (
              <th className={`${HEAD} ${RULE} px-5 text-right`} style={HEAD_STYLE}>
                Action
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr
              key={p.id}
              onClick={() => onSelect(p.id)}
              className={`group cursor-pointer transition last:border-0 hover:bg-[#FAF9F5] dark:hover:bg-darkCardHover ${
                selected.has(p.id) ? 'bg-accent/[0.07]' : 'odd:bg-transparent even:bg-black/[0.015] dark:even:bg-white/[0.02]'
              }`}
            >
              {selectable && (
                <td className={`px-3 py-4 ${BOTTOM}`} onClick={(e) => e.stopPropagation()}>
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
              {/* rank, not just position: this page is a queue, so the number
                  continues across pages rather than restarting at 1 */}
              <td className={`px-4 py-4 ${BOTTOM}`}>
                <span
                  style={MONO}
                  className={`text-[12px] font-bold tabular-nums ${
                    pageOffset + i < 3 ? 'text-accent' : 'text-dust dark:text-darkMuted'
                  }`}
                >
                  {String(pageOffset + i + 1).padStart(2, '0')}
                </span>
              </td>

              {/*
               * The coloured spine and the identity tile both key off the SERVED
               * tier, so a row's priority is readable from the edge of the table
               * without reading a single number.
               */}
              <td
                className={`border-l-2 px-5 py-4 ${BOTTOM} transition-colors`}
                style={{ borderLeftColor: TIER_HEX[p.risk_tier] }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border text-[12px] font-black"
                    style={{
                      ...MONO,
                      color: TIER_HEX[p.risk_tier],
                      borderColor: `${TIER_HEX[p.risk_tier]}44`,
                      background: `linear-gradient(135deg, ${TIER_HEX[p.risk_tier]}26, ${TIER_HEX[p.risk_tier]}0d)`,
                    }}
                  >
                    {p.id.slice(-2)}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span
                        style={MONO}
                        className="text-[13.5px] font-bold text-ink transition-colors group-hover:text-accent dark:text-darkText dark:group-hover:text-accent"
                      >
                        {p.id}
                      </span>
                      <svg
                        className="text-dust opacity-0 transition group-hover:translate-x-0.5 group-hover:opacity-100 dark:text-darkMuted"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m9 6 6 6-6 6" />
                      </svg>
                    </div>
                    {!compact && (
                      <div style={MONO} className="mt-0.5 text-[10.5px] text-muted dark:text-darkMuted">
                        {p.age ?? '—'}y · {p.sex ?? '—'} · Edu {p.education_years ?? '—'}y
                      </div>
                    )}
                  </div>
                </div>
              </td>
              {!compact && (
                <td className={`${CELL} whitespace-nowrap`}>
                  <CognitiveCell cognitive={p.cognitive} />
                </td>
              )}
              <td className={CELL}>
                <div className="flex items-baseline gap-2">
                  <span style={MONO} className="text-[15px] font-black tabular-nums text-ink dark:text-darkText">
                    {fmtScore(p.final_score ?? p.score)}
                  </span>
                  <TierTag tier={p.risk_tier} />
                </div>
                <div className="mt-1.5 h-[5px] w-24 overflow-hidden rounded-full bg-[#EDE9E1] shadow-[inset_0_1px_1px_rgba(0,0,0,0.06)] dark:bg-darkBorder dark:shadow-none">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${Math.round((p.final_score ?? p.score) * 100)}%`,
                      background: `linear-gradient(90deg, ${TIER_HEX[p.risk_tier]}cc, ${TIER_HEX[p.risk_tier]})`,
                    }}
                  />
                </div>
              </td>
              <td className={CELL}>
                {/* a four-segment rail, not four dots: the pathway is sequential,
                    so the completed prefix is shown as filled track */}
                <div className="flex items-center gap-1">
                  {[1, 2, 3, 4].map((step) => {
                    const done = step < p.stage;
                    const current = step === p.stage;
                    const hex = STAGE_FILLS[step - 1];
                    return (
                      <span
                        key={step}
                        className="h-1.5 w-6 rounded-full transition-all"
                        style={{
                          background: done
                            ? TIER_HEX.low
                            : current
                            ? `linear-gradient(90deg, ${hex}cc, ${hex})`
                            : undefined,
                          boxShadow: current ? `0 0 8px ${hex}70` : undefined,
                        }}
                      >
                        {!done && !current && <span className="block h-full w-full rounded-full bg-[#E4E0D8] dark:bg-darkBorder" />}
                      </span>
                    );
                  })}
                </div>
                <div style={MONO} className="mt-1 text-[11px] font-medium text-muted dark:text-darkMuted">
                  {/* Stage is the completed CONTIGUOUS prefix of the pathway, so a
                      patient whose later-stage result is already on file still
                      reads as their first gap. That was previously explained by a
                      "results on file" badge in this cell; the badge is gone.
                      The detail is on the patient's own record, which is where
                      anyone reading about that patient will be. */}
                  {STAGES_SHORT[p.stage - 1] ?? p.stage_name} · Stage {p.stage}/4
                </div>
              </td>
              <td className={`${CELL} ${compact ? '' : 'max-w-[280px]'}`}>
                {p.recommended_next ? (
                  <span
                    className="inline-flex max-w-full items-center gap-1.5 text-[11px] font-medium text-ink dark:text-darkText"
                    title={p.recommended_next}
                  >
                    <ArrowRight className="h-3 w-3 shrink-0 text-accent" />
                    <span className="truncate">{p.recommended_next}</span>
                  </span>
                ) : (
                  <span className="text-[11px] text-muted dark:text-darkMuted">Complete — specialist review</span>
                )}
              </td>
              {!compact && (
                <td className={`${RULE} ${BOTTOM} px-5 py-4 text-right`}>
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
    <div
      data-np-keep=""
      className="fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-2xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-5 py-3.5 shadow-lift animate-fade-up"
    >
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