/*
 * The phone preview.
 *
 * On a phone the sliding showcase is replaced by a single welcome panel, drawn
 * to the supplied design: a violet card on the nav page, the mark and the word
 * above periwinkle supporting text, one pink pill, and the network/attribution
 * artwork filling the rest.
 *
 * Everything is wrapped in `data-np-preview`, which is the phone stylesheet's
 * one exemption: inside it, the rules that drop prose, shrink buttons and cap
 * SVG heights stay out of the way, so this panel renders exactly as drawn.
 */

import { useEffect } from 'react';

/*
 * The panel is where the blue lives.
 *
 * The app's surfaces are light and the accent is pink, and a screen of nothing but
 * near-white reads as having had its colour taken out — so the landing panel keeps
 * the deep blue it was designed in, with white type on it and the periwinkle
 * supporting line. It is one deliberate block of blue on an otherwise light page,
 * rather than the page, the cards and the dividers all being blue.
 */
const PAGE = '#F5F9F9';
const PANEL = '#0F7F78';
const ON_PANEL = '#FFFFFF';
const PERI = '#A8E6DD';
/* the mark and the artwork, in aquamarine, so they read against the panel */
const AQUA_LIGHT = '#7DE9D8';
const AQUA = '#12A594';

/* The mark, in the accent: on a phone it is pink throughout, not periwinkle. */
function Mark() {
  return (
    <svg width="46" height="46" viewBox="0 0 46 46" fill="none" aria-hidden="true">
      <circle cx="6" cy="6" r="6" stroke={AQUA_LIGHT} strokeWidth="2.4" />
      <circle cx="40" cy="6" r="6" stroke={AQUA_LIGHT} strokeWidth="2.4" />
      <circle cx="23" cy="23" r="6" fill={AQUA_LIGHT} />
      <circle cx="6" cy="40" r="6" stroke={AQUA_LIGHT} strokeWidth="2.4" />
      <circle cx="40" cy="40" r="6" stroke={AQUA_LIGHT} strokeWidth="2.4" />
      <path d="M10 10L18 18M36 10L28 18M10 36L18 28M36 36L28 28" stroke={AQUA_LIGHT} strokeWidth="2" />
    </svg>
  );
}

function Artwork() {
  const nodes = [
    [30, 20],
    [70, 115],
    [150, 35],
    [205, 15],
    [115, 140],
    [220, 110],
    [20, 80],
  ];
  const hex = (r) =>
    Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 180) * (60 * i - 90);
      return `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`;
    }).join(' ');

  return (
    <svg viewBox="0 0 260 340" style={{ maxWidth: 230, width: '100%', height: '100%' }} aria-hidden="true">
      <g stroke={AQUA_LIGHT} strokeWidth="2" opacity="0.9">
        <line x1="30" y1="20" x2="90" y2="55" />
        <line x1="90" y1="55" x2="70" y2="115" />
        <line x1="90" y1="55" x2="150" y2="35" />
        <line x1="150" y1="35" x2="205" y2="15" />
        <line x1="150" y1="35" x2="165" y2="90" />
        <line x1="70" y1="115" x2="115" y2="140" />
        <line x1="165" y1="90" x2="115" y2="140" />
        <line x1="165" y1="90" x2="220" y2="110" />
        <line x1="30" y1="20" x2="20" y2="80" />
        <line x1="20" y1="80" x2="70" y2="115" />
      </g>

      <g fill={AQUA_LIGHT}>
        <circle cx="90" cy="55" r="6.5" />
        <circle cx="165" cy="90" r="6.5" />
      </g>
      <g fill={AQUA_LIGHT}>
        {nodes.map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="5" />
        ))}
      </g>

      <g transform="translate(130,240)">
        <polygon points={hex(85)} stroke={AQUA_LIGHT} strokeWidth="1.4" fill="none" opacity="0.5" />
        <polygon points={hex(56)} stroke={AQUA_LIGHT} strokeWidth="1.4" fill="none" opacity="0.35" />
        <polygon
          points="0,-72 61,-13 37,48 -13,67 -61,13 -24,-48"
          fill={AQUA_LIGHT}
          opacity="0.4"
          stroke={AQUA_LIGHT}
          strokeWidth="2"
        />
        {[
          [0, -72],
          [61, -13],
          [37, 48],
          [-13, 67],
          [-61, 13],
          [-24, -48],
        ].map(([cx, cy]) => (
          <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r="4" fill={AQUA_LIGHT} />
        ))}
      </g>
    </svg>
  );
}

export default function MobileWelcome({ onLaunch }) {
  /*
   * Pin the hero to the height the device is ACTUALLY showing.
   *
   * `100dvh` is meant to be exactly that, but it is not dependable across mobile
   * browsers — on the device reporting this, it resolves to less than the real
   * viewport, which is why the panel kept finishing short and leaving part of the
   * screen uncovered at the bottom. `visualViewport.height` is the number the
   * browser is actually rendering, so it is measured here and published as
   * `--np-preview-h`; `100dvh` remains only as the fallback for the first paint.
   */
  useEffect(() => {
    const apply = () => {
      const h = Math.round(window.visualViewport?.height || window.innerHeight || 0);
      if (h > 0) document.documentElement.style.setProperty('--np-preview-h', `${h}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    window.visualViewport?.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      window.removeEventListener('orientationchange', apply);
      window.visualViewport?.removeEventListener('resize', apply);
      document.documentElement.style.removeProperty('--np-preview-h');
    };
  }, []);

  return (
    <div
      data-np-preview=""
      className="flex h-full min-h-0 w-full items-center justify-center"
      style={{ background: PAGE }}
    >
      {/*
       * Full-bleed: the panel IS the screen. No fixed 340×620 frame, no corner
       * radius, no navy showing around it — it takes the whole band edge to edge,
       * and keeps only the design's interior padding.
       */}
      <div
        className="relative flex h-full w-full flex-col overflow-hidden"
        style={{
          background: PANEL,
          borderRadius: 0,
          /*
           * The panel starts at the very top of the viewport and the navbar
           * overlays its first strip, so the top padding is the bar's height plus
           * the design's own 36px — which keeps the mark clear of the bar and
           * keeps the panel's lower half identical to the drawn layout.
           */
          padding: 'calc(var(--app-header-h, 3.5rem) + 20px) 30px 30px',
        }}
      >
        <div style={{ marginBottom: 22 }}>
          <Mark />
        </div>

        <h1
          style={{
            fontFamily: "'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
            color: ON_PANEL,
            fontSize: 34,
            fontWeight: 700,
            lineHeight: 1.1,
            margin: '0 0 6px',
          }}
        >
          NeuroPilot
        </h1>
        {/* the app's own line, as the header and footer carry it */}
        <p style={{ color: PERI, fontSize: 15, fontWeight: 500, margin: '0 0 22px' }}>
          Clinical Decision Support &amp; Risk Triage
        </p>

        <button
          type="button"
          data-np-keep=""
          onClick={onLaunch}
          className="mobile-welcome-cta"
          style={{
            alignSelf: 'flex-start',
            background: AQUA,
            color: '#FFFFFF',
            border: 'none',
            borderRadius: 50,
            padding: '12px 26px',
            fontFamily: 'inherit',
            fontSize: 15,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 150ms ease',
          }}
        >
          Open the worklist
        </button>

        <div className="flex flex-1 items-center justify-center" style={{ marginTop: 10, minHeight: 0 }}>
          <Artwork />
        </div>


      </div>
    </div>
  );
}
