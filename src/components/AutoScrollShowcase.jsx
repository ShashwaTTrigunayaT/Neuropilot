import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { MONO } from './widgets.jsx';

/*
 * Full-width, self-advancing showcase.
 *
 * ONE panel is on screen at a time and each fills the viewport, so a panel is
 * laid out as a slide rather than a card:
 *
 *   left   index, badge, eyebrow with a rule, the claim, the explanation, then
 *          the highlights — the short version of what the panel is about
 *   right  the points, each one an explained paragraph with a hairline between
 *          them, stretched to equal heights so the panel reaches the bottom edge
 *
 * There are deliberately no controls: it is a preview, not a carousel to
 * operate. The only chrome is a dot rail. It stops advancing the moment anyone
 * might want to read — on hover, on keyboard focus, in a hidden tab, when it
 * scrolls out of view — and degrades to a plain swipeable row under
 * `prefers-reduced-motion`.
 *
 * The offset advances by EXACTLY one panel width plus its gap and wraps at
 * `count × step`, so the loop is seamless in both directions with no rewind. It
 * is written straight to the DOM inside one rAF loop; React re-renders only when
 * the active panel changes.
 */
const GAP_PX = 24; // gap-6
const GUTTER = '1rem'; // the inset each full-width panel keeps from the viewport
const STEP_MS = 5000; // dwell per panel — long enough to read a deep panel
const EASE_RATE = 3.2; // easing toward the target: bigger = snappier

export default function AutoScrollShowcase({ panels = [] }) {
  const trackRef = useRef(null);
  const clipRef = useRef(null);
  const scrollRef = useRef(null);
  const offset = useRef(0);
  const target = useRef(null);
  const nextAt = useRef(0);
  const indexRef = useRef(0);
  const hoverRef = useRef(false);
  const visibleRef = useRef(true);

  const [index, setIndex] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [stepPx, setStepPx] = useState(0);
  const [fading, setFading] = useState(false);

  const count = panels.length;
  const usable = count > 1;
  const cyclePx = stepPx * count;

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => setReduced(mq.matches);
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  // One step is one panel plus the gap between panels; the loop is a whole
  // cycle of them. Measured, never assumed.
  useEffect(() => {
    if (reduced || !usable) return;
    const measure = () => {
      const track = trackRef.current;
      const first = track?.firstElementChild;
      if (!track || !first) return;
      setStepPx(first.getBoundingClientRect().width + GAP_PX);
    };
    measure();
    window.addEventListener('resize', measure);
    const settle = setTimeout(measure, 500);
    return () => {
      window.removeEventListener('resize', measure);
      clearTimeout(settle);
    };
  }, [reduced, usable, count]);

  // Never advance while it is off screen.
  useEffect(() => {
    const clip = clipRef.current;
    if (!clip || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([entry]) => { visibleRef.current = entry.isIntersecting; }, { threshold: 0.12 });
    io.observe(clip);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced || !usable || !stepPx || !cyclePx) return;
    const track = trackRef.current;
    let raf = 0;
    let last = performance.now();
    nextAt.current = performance.now() + STEP_MS;

    const tick = (now) => {
      const dt = Math.min(64, now - last) / 1000;
      last = now;
      const running = !hoverRef.current && visibleRef.current && !document.hidden;

      if (target.current != null) {
        const diff = target.current - offset.current;
        offset.current += diff * Math.min(1, dt * EASE_RATE);
        if (Math.abs(diff) < 0.5) {
          offset.current = target.current;
          target.current = null;
          // The dwell starts when the panel ARRIVES. Without this the timer has
          // already expired by the time the slide lands, so the next one fires
          // immediately and the rail runs away with itself.
          nextAt.current = now + STEP_MS;
        }
      } else if (running) {
        if (now >= nextAt.current) target.current = offset.current + stepPx;
      } else {
        nextAt.current = now + STEP_MS;
      }

      const wrapped = ((offset.current % cyclePx) + cyclePx) % cyclePx;
      track.style.transform = `translate3d(${-wrapped.toFixed(2)}px,0,0)`;

      const next = Math.round(wrapped / stepPx) % count;
      if (next !== indexRef.current) {
        indexRef.current = next;
        setIndex(next);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, usable, stepPx, cyclePx, count]);

  /*
   * Double-click anywhere on the preview returns to the LEAD panel — the one that
   * explains the whole system — and restarts its dwell, so the reader gets the
   * full explanation again instead of catching the tail of it.
   *
   * The jump is a short reverse slide to this cycle's zero point rather than a
   * scroll back through every panel in between, and it is masked by a 180ms fade
   * so the content swap is not a hard cut on the same screen position.
   */
  const jumpToStart = () => {
    if (!usable || !stepPx || !cyclePx) return;
    const wrapped = ((offset.current % cyclePx) + cyclePx) % cyclePx;
    const zero = offset.current - wrapped;
    setFading(true);
    window.setTimeout(() => {
      offset.current = zero;
      target.current = null;
      nextAt.current = performance.now() + STEP_MS;
      indexRef.current = 0;
      setIndex(0);
      if (trackRef.current) trackRef.current.style.transform = `translate3d(${-zero.toFixed(2)}px,0,0)`;
      setFading(false);
    }, 180);
  };

  const panel = (p, i, key) => {
    const accent = p.accent || '#0D8282';
    // The left column is the SUMMARY and always wears the brand accent (`accent`
    // — the exact colour of the site's primary buttons), so the two halves of a
    // slide read as different kinds of content before a word is read: tinted =
    // the short version, white = the full explanation. Where a panel declares
    // its own accent it is used only inside the detail column (point icons and
    // bars), never on the summary side.
    return (
      <article
        key={key}
        className="flex h-full w-[calc(100vw-2rem)] shrink-0 snap-center flex-col overflow-y-auto rounded-2xl border border-line bg-white shadow-soft dark:border-darkBorder dark:bg-darkCard lg:flex-row lg:overflow-hidden"
      >
        {/* ------------------------------------------------ narrative */}
        <div
          className="relative flex shrink-0 flex-col overflow-hidden p-6 lg:h-full lg:w-[37%] lg:shrink lg:p-10"
          style={{ background: `linear-gradient(158deg, ${accent} 0%, #0D8282 52%, #0A6A6A 100%)` }}
        >
          {/* a soft top-light so the flat tint has depth rather than looking printed */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 80% at 8% 0%, rgba(255,255,255,0.16), transparent 60%)' }}
          />
          <div className="relative flex items-center justify-between gap-3">
            <span style={MONO} className="text-[10.5px] font-bold text-white/70">
              {String(i + 1).padStart(2, '0')} / {String(count).padStart(2, '0')}
            </span>
            {p.badge && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/25 bg-white/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.1em] text-white">
                {p.badge}
              </span>
            )}
          </div>

          {/*
           * The narrative starts at a FIXED offset from the header rather than
           * being centred, and the action is pushed to the bottom by `mt-auto`.
           * Centring looked fine panel by panel and wrong panel to panel: the
           * heading sat at a different height on every slide, so a reader
           * following the rail felt the layout jump even though nothing had
           * changed. Pinning both ends keeps the title, the rule and the button
           * on exactly the same line in all of them.
           */}
          <div className="relative mt-8 flex flex-1 flex-col lg:mt-14">
            <p className="flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-[0.18em] text-white/90">
              <span className="h-px w-7 shrink-0 bg-white/60" />
              {p.eyebrow}
            </p>
            <h3 className="mt-4 text-[25px] font-bold leading-[1.06] tracking-tight text-white lg:text-[36px]">
              {p.title}
            </h3>
            <p className="mt-5 max-w-[44ch] text-[13px] leading-[1.75] text-white/90 lg:text-[14.5px]">
              {p.lede}
            </p>

            {p.highlights?.length > 0 && (
              <ul className="mt-7 space-y-2.5">
                {p.highlights.map((h) => (
                  <li key={h} className="flex items-start gap-2.5">
                    <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-white/70" />
                    <span className="text-[11.5px] leading-relaxed text-white/85">{h}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {p.onOpen && (
            <button
              onClick={p.onOpen}
              className="mt-6 inline-flex shrink-0 items-center gap-1.5 self-start rounded-xl border border-white/30 bg-white/12 px-4 py-2.5 text-[12px] font-semibold text-white transition hover:bg-white/20"
            >
              {p.openLabel || 'Open'}
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* --------------------------------------------------- points */}
        {/*
         * No inner scroller by design: the copy is written to fit the panel, and
         * the row rule above guarantees a paragraph can never be squeezed into
         * the one beneath it. If a slide ever stops fitting, the fix is shorter
         * copy — not a scrollbar on a panel that advances on its own.
         */}
        <div className="flex w-full flex-1 shrink-0 flex-col p-6 lg:min-h-0 lg:shrink lg:px-10 lg:py-7 lg:pl-12">
          {p.points.map((pt, k) => (
            <div
              key={pt.label || k}
              /*
               * `lg:flex-1` keeps the rows equal height so their separator lines
               * sit on the same y in every panel. There is deliberately NO
               * `lg:min-h-0`: that let a long row shrink below its own text, so
               * the paragraphs collided instead of the column scrolling. With
               * min-height left at auto a row can never be squeezed smaller than
               * its copy — the column scrolls instead, which is the honest
               * failure mode for a panel whose text cannot fit.
               */
              className="flex shrink-0 flex-col gap-2 border-b border-line/60 py-5 first:pt-0 last:border-b-0 last:pb-0 dark:border-darkBorder/60 lg:flex-1 lg:justify-center lg:py-4"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span style={MONO} className="text-[10.5px] font-bold" >{String(k + 1).padStart(2, '0')}</span>
                {pt.icon}
                <p className="text-[15px] font-semibold text-ink dark:text-darkText lg:text-[16.5px]">{pt.label}</p>
                {pt.value != null && (
                  <span style={{ ...MONO, color: pt.valueColor }} className="ml-auto shrink-0 text-[14px] font-bold">
                    {pt.value}
                  </span>
                )}
              </div>

              {pt.detail && (
                <p className="max-w-[76ch] text-[12px] leading-[1.75] text-muted dark:text-darkMuted lg:text-[13.5px]">
                  {pt.detail}
                </p>
              )}

              {pt.bar != null && (
                <div className="mt-0.5 h-1.5 w-full max-w-[520px] overflow-hidden rounded-full bg-line/60 dark:bg-darkBorder">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.min(100, pt.bar)}%`, background: pt.tone || accent }}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      </article>
    );
  };

  if (!usable) return null;

  // Reduced motion: one panel per screen, no autoplay, swipe or drag instead.
  if (reduced) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col">
        <div
          ref={scrollRef}
          onDoubleClick={() => scrollRef.current?.scrollTo({ left: 0, behavior: 'smooth' })}
          className="min-h-0 w-full flex-1 overflow-x-auto pb-3"
        >
          <div className="flex h-full snap-x snap-mandatory gap-6" style={{ paddingLeft: GUTTER, paddingRight: GUTTER }}>
            {panels.map((p, i) => panel(p, i, p.id))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {/* Full-bleed stage: one panel across the viewport, fading at both edges */}
      <div
        ref={clipRef}
        className="min-h-0 w-full flex-1 overflow-hidden"
        onMouseEnter={() => { hoverRef.current = true; }}
        onMouseLeave={() => { hoverRef.current = false; }}
        onFocusCapture={() => { hoverRef.current = true; }}
        onBlurCapture={() => { hoverRef.current = false; }}
        onDoubleClick={jumpToStart}
        title="Double-click to go back to the start of the preview"
        style={{
          opacity: fading ? 0 : 1,
          transition: 'opacity 180ms ease',
          maskImage: 'linear-gradient(to right, transparent 0, #000 1.5%, #000 98.5%, transparent 100%)',
          WebkitMaskImage: 'linear-gradient(to right, transparent 0, #000 1.5%, #000 98.5%, transparent 100%)',
        }}
      >
        <div
          ref={trackRef}
          className="flex h-full gap-6 will-change-transform"
          style={{ paddingLeft: GUTTER, paddingRight: GUTTER }}
        >
          {panels.map((p, i) => panel(p, i, `${p.id}-a`))}
          {panels.map((p, i) => panel(p, i, `${p.id}-b`))}
        </div>
      </div>

      {/* The only chrome: which panel of how many */}
      <div className="mx-auto mt-3 flex w-full max-w-6xl shrink-0 items-center justify-center gap-1.5 px-6">
        {panels.map((p, i) => (
          <span
            key={p.id}
            aria-hidden="true"
            className={`h-1.5 rounded-full transition-all duration-500 ${
              i === index ? 'w-6 bg-accent' : 'w-1.5 bg-line dark:bg-darkBorder'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
