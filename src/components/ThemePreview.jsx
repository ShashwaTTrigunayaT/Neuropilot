import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';

/**
 * TEMPORARY — a theme preview control.
 *
 * Three independent dimensions, switchable here on a phone or a desktop so each
 * can be judged at both widths:
 *
 *   • colour  — `data-np-theme`, the palette (accent + paper + console + atmosphere)
 *   • type    — `data-np-font`, the UI face
 *   • mono    — `data-np-font-mono`, the face every figure and id is set in
 *
 * Each is one attribute on <html>, read by the preview blocks at the end of
 * index.css. Choices are kept in localStorage so a reload does not lose them
 * while they are being compared. Delete this file, those blocks and the mount in
 * App.jsx once the winners are picked.
 *
 * Poppins is the face named by the design pack in `/fonts`; the rest are
 * candidates beside it.
 */

const GROUPS = [
  {
    name: 'Clinical',
    note: 'The app’s own register',
    themes: [
      { key: 'teal', label: 'Teal', swatch: '#0D8282' },
      { key: 'teal-white', label: 'Teal · white', swatch: '#E6F2F2' },
      { key: 'cobalt', label: 'Cobalt', swatch: '#2563EB' },
      { key: 'graphite', label: 'Graphite', swatch: '#E7EBF0' },
    ],
  },
  {
    name: 'Minimal',
    note: 'Flat, low-chroma',
    themes: [
      { key: 'mono', label: 'Mono', swatch: '#525A66' },
      { key: 'bone', label: 'Bone', swatch: '#8A7A64' },
      { key: 'slate', label: 'Slate', swatch: '#475569' },
    ],
  },
  {
    name: 'Premium',
    note: 'Metals and jewel tones',
    themes: [
      { key: 'gold', label: 'Gold', swatch: '#C6A04A' },
      { key: 'royal', label: 'Royal', swatch: '#6C5CE7' },
      { key: 'emerald', label: 'Emerald', swatch: '#109476' },
      { key: 'platinum', label: 'Platinum', swatch: '#A8AEB8' },
    ],
  },
  {
    name: 'Bold',
    note: 'For a dark room',
    themes: [
      { key: 'violet', label: 'Violet', swatch: '#7C3AED' },
      { key: 'magenta', label: 'Magenta', swatch: '#DB2777' },
      { key: 'indigo', label: 'Indigo', swatch: '#4F46E5' },
      { key: 'forest', label: 'Forest', swatch: '#16803D' },
      { key: 'crimson', label: 'Crimson', swatch: '#BE123C' },
      { key: 'amber', label: 'Amber', swatch: '#D97706' },
    ],
  },
];

// Each option is shown in its OWN face, so the list is the specimen.
const TYPES = [
  { key: '', label: 'Inter', note: 'current', stack: "'Inter', ui-sans-serif, system-ui, sans-serif" },
  { key: 'poppins', label: 'Poppins', note: 'design pack', stack: "'Poppins', ui-sans-serif, system-ui, sans-serif" },
  { key: 'manrope', label: 'Manrope', stack: "'Manrope', ui-sans-serif, system-ui, sans-serif" },
  { key: 'grotesk', label: 'Space Grotesk', stack: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif" },
  { key: 'plex', label: 'IBM Plex Sans', stack: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif" },
];

const MONOS = [
  { key: '', label: 'JetBrains Mono', stack: "'JetBrains Mono', ui-monospace, monospace" },
  { key: 'plex', label: 'IBM Plex Mono', stack: "'IBM Plex Mono', ui-monospace, monospace" },
  { key: 'space', label: 'Space Mono', stack: "'Space Mono', ui-monospace, monospace" },
];

const STORE = { theme: 'npThemePreview', font: 'npFontPreview', mono: 'npMonoPreview' };

/** Read a stored choice, treating "never set" as the first option. */
const read = (key, fallback) => {
  try {
    const saved = localStorage.getItem(STORE[key]);
    return saved == null ? fallback : saved;
  } catch {
    /* storage can be unavailable; the preview still works for this session */
    return fallback;
  }
};

/** Keep one attribute on <html> in step with one piece of state. */
function useAttribute(attr, value, storeKey) {
  useEffect(() => {
    const root = document.documentElement;
    if (value) root.setAttribute(attr, value);
    else root.removeAttribute(attr);
    try {
      localStorage.setItem(STORE[storeKey], value);
    } catch {
      /* see above */
    }
  }, [attr, value, storeKey]);
}

export default function ThemePreview() {
  const [open, setOpen] = useState(false);
  // Default to the app's own design (including the phone design system) rather
  // than to a palette, so opening the panel does not silently re-skin anything.
  const [theme, setTheme] = useState(() => read('theme', ''));
  const [font, setFont] = useState(() => read('font', ''));
  const [mono, setMono] = useState(() => read('mono', ''));

  useAttribute('data-np-font', font, 'font');
  useAttribute('data-np-font-mono', mono, 'mono');
  useAttribute('data-np-theme', theme, 'theme');

  /** One row of the list: a swatch (or not), a label, and a tick. */
  const row = (key, label, active, onPick, { swatch, stack, note } = {}) => (
    <button
      key={key || 'default'}
      type="button"
      onClick={onPick}
      aria-pressed={active}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-semibold transition ${
        active
          ? 'bg-accent/10 text-accent'
          : 'text-ink hover:bg-tint dark:text-darkText dark:hover:bg-darkBorderSubtle'
      }`}
    >
      {swatch ? (
        <span
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/10 dark:border-white/20"
          style={{ background: swatch }}
        />
      ) : (
        <span
          aria-hidden="true"
          className="w-3.5 shrink-0 text-center text-[10px] font-bold opacity-70"
        >
          Aa
        </span>
      )}
      <span className="min-w-0 truncate" style={stack ? { fontFamily: stack } : undefined}>
        {label}
      </span>
      {note && <span className="shrink-0 text-[8.5px] uppercase tracking-[0.1em] opacity-60">{note}</span>}
      {active && !note && (
        <span className="ml-auto shrink-0 text-[9px] font-bold uppercase tracking-[0.1em]">on</span>
      )}
    </button>
  );

  const section = (name, note) => (
    <p data-np-keep="" className="mt-1 flex items-baseline justify-between gap-2 px-2 pb-0.5 pt-1.5">
      <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink dark:text-darkText">
        {name}
      </span>
      <span className="truncate text-[9px] text-muted dark:text-darkMuted">{note}</span>
    </p>
  );

  return (
    <div className="no-print fixed bottom-3 left-3 z-[70]">
      {open && (
        /*
         * `data-np-keep` is load-bearing: the phone theme strips the chrome from
         * any bordered, rounded surface, and this panel floats over the page —
         * without it the panel would lose its own background and the options
         * would sit unreadably on whatever is behind them.
         */
        <div
          data-np-keep=""
          className="mb-2 max-h-[72vh] w-56 overflow-y-auto overscroll-contain rounded-xl border border-line bg-white/95 p-1.5 shadow-float backdrop-blur dark:border-darkBorder dark:bg-darkCard/95"
        >
          <p
            data-np-keep=""
            className="px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted"
          >
            Theme preview
          </p>

          {GROUPS.map((group) => (
            <div key={group.name}>
              {section(group.name, group.note)}
              {group.themes.map((t) =>
                row(t.key, t.label, theme === t.key, () => setTheme(t.key), { swatch: t.swatch })
              )}
            </div>
          ))}

          <div className="mt-1.5 border-t border-line/70 pt-1 dark:border-darkBorder/70">
            {section('Type', 'the UI face')}
            {TYPES.map((t) =>
              row(t.key, t.label, font === t.key, () => setFont(t.key), { stack: t.stack, note: t.note })
            )}
          </div>

          <div className="mt-1.5 border-t border-line/70 pt-1 dark:border-darkBorder/70">
            {section('Figures', 'the mono face')}
            {MONOS.map((m) => row(m.key, m.label, mono === m.key, () => setMono(m.key), { stack: m.stack }))}
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded-xl border border-line bg-white/95 px-2.5 py-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-ink shadow-float backdrop-blur dark:border-darkBorder dark:bg-darkCard/95 dark:text-darkText"
      >
        <Palette className="h-3.5 w-3.5 text-accent" />
        {open ? 'Close' : 'Theme'}
      </button>
    </div>
  );
}
