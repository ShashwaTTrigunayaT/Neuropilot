import { useEffect, useState } from 'react';
import { Palette } from 'lucide-react';

/**
 * TEMPORARY — a theme preview control.
 *
 * A library of candidate palettes, switchable here on a phone or a desktop so
 * the same choice can be judged at both widths. It does one thing: it sets
 * `data-np-theme` on <html>, which the theme blocks at the end of index.css
 * read. Everything else — accent, halos, washes, rings, paper, console black
 * and atmosphere — follows from that.
 *
 * The choice is kept in localStorage so a reload does not lose it while the
 * palettes are being compared. Delete this file, the `data-np-theme` blocks in
 * index.css and the mount in App.jsx once a winner is picked.
 */

const GROUPS = [
  {
    name: 'Clinical',
    note: 'The app’s own register',
    themes: [
      { key: 'teal', label: 'Teal', swatch: '#0D8282' },
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

const STORE = 'npThemePreview';

const read = () => {
  try {
    const saved = localStorage.getItem(STORE);
    return saved == null ? 'teal' : saved;
  } catch {
    /* storage can be unavailable; the preview still works for this session */
    return 'teal';
  }
};

export default function ThemePreview() {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState(read);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute('data-np-theme', theme);
    else root.removeAttribute('data-np-theme');
    try {
      localStorage.setItem(STORE, theme);
    } catch {
      /* see above */
    }
  }, [theme]);

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
          className="mb-2 max-h-[70vh] w-52 overflow-y-auto overscroll-contain rounded-xl border border-line bg-white/95 p-1.5 shadow-float backdrop-blur dark:border-darkBorder dark:bg-darkCard/95"
        >
          <p
            data-np-keep=""
            className="px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted"
          >
            Theme preview
          </p>

          {GROUPS.map((group) => (
            <div key={group.name}>
              <p
                data-np-keep=""
                className="mt-1 flex items-baseline justify-between gap-2 px-2 pb-0.5 pt-1.5"
              >
                <span className="text-[9.5px] font-bold uppercase tracking-[0.12em] text-ink dark:text-darkText">
                  {group.name}
                </span>
                <span className="truncate text-[9px] text-muted dark:text-darkMuted">{group.note}</span>
              </p>

              {group.themes.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTheme(t.key)}
                  aria-pressed={theme === t.key}
                  className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11.5px] font-semibold transition ${
                    theme === t.key
                      ? 'bg-accent/10 text-accent'
                      : 'text-ink hover:bg-tint dark:text-darkText dark:hover:bg-darkBorderSubtle'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 rounded-full border border-black/10 dark:border-white/20"
                    style={{ background: t.swatch }}
                  />
                  {t.label}
                  {theme === t.key && (
                    <span className="ml-auto text-[9px] font-bold uppercase tracking-[0.1em]">on</span>
                  )}
                </button>
              ))}
            </div>
          ))}

          <button
            type="button"
            onClick={() => setTheme('')}
            className={`mt-1 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold transition ${
              theme
                ? 'text-muted hover:bg-tint dark:text-darkMuted dark:hover:bg-darkBorderSubtle'
                : 'bg-accent/10 text-accent'
            }`}
          >
            <span
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 rounded-full border border-dashed border-line dark:border-darkBorder"
            />
            Default
          </button>
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
