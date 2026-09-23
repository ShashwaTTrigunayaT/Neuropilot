import { useEffect, useRef } from 'react';
import { LayoutDashboard, Moon, Plug, SlidersHorizontal, Sun, Users, Workflow } from 'lucide-react';
import { NeuroPilotLogo } from './BrandLogo.jsx';
import { MONO } from './widgets.jsx';

/*
 * The application header.
 *
 * It lives in its own file because it is on screen on every view, so it is
 * edited more often than anything else and should not require scrolling past 600
 * lines of view logic to reach. Everything here is presentation, plus the two
 * controls that must exist outside the view tree — the autonomous run control
 * and the theme toggle.
 *
 * The design brief it is built to:
 *
 *   scale      controls are 36px and labels are 13px. The earlier 12px-in-32px
 *              version was technically tidy and read as timid — at 1600px wide a
 *              header that size looks like a utility bar, not a product's chrome.
 *   layering   a warm white→paper wash, a real blur, a 1px border, and the logo's
 *              gradient as a 2px rule pinned to the top edge: four cheap cues
 *              that say "surface" instead of "divider".
 *   rhythm     every control on the bar is exactly 36px, so there is one baseline
 *              across three zones; the nav track is the only element that is
 *              deliberately larger, because it is a container, not a control.
 *   restraint  one accent, one filled button. The filled button is the primary
 *              action in the whole application, so nothing else competes with it.
 */

/** A 2px rule in the logo's own gradient, pinned to the header's top edge. */
function BrandRule() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
      style={{ background: 'linear-gradient(90deg, #0D8282 0%, #0FA0A0 38%, #2563EB 100%)' }}
    />
  );
}

/** A hairline that separates the header's zones once there is room for it. */
function Rule() {
  return <span aria-hidden="true" className="hidden h-6 w-px shrink-0 bg-line lg:block dark:bg-darkBorder" />;
}

/*
 * One navigation tab.
 *
 * The four tabs used to be four near-identical button blocks whose active state
 * was written out by hand each time — which is how a nav ends up with four
 * subtly different "current" states. There is now exactly one definition of
 * selected, hovered and idle.
 */
function NavTab({ active, accent = false, icon: Icon, label, badge, title, onClick }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-current={active ? 'page' : undefined}
      className={`group relative inline-flex h-9 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold tracking-[-0.01em] transition-all duration-200 active:scale-[0.97] ${
        active
          ? `bg-white text-ink shadow-soft ring-1 dark:bg-darkCard dark:text-darkText ${
              accent ? 'text-accent ring-accent/25 dark:text-accent' : 'ring-line/80 dark:ring-darkBorder'
            }`
          : 'text-muted hover:bg-white/70 hover:text-ink dark:text-darkMuted dark:hover:bg-darkCard/60 dark:hover:text-darkText'
      }`}
    >
      {/* The selected tab keeps a 2px accent underline inside the pill: colour
          alone is easy to miss in a bright room, a shape is not. */}
      {active && (
        <span aria-hidden="true" className="absolute inset-x-3 bottom-[5px] h-[2px] rounded-full bg-accent" />
      )}
      <Icon
        className={`h-4 w-4 transition ${
          active ? 'text-accent' : 'text-dust group-hover:text-muted dark:text-darkMuted'
        }`}
      />
      {label}
      {badge != null && (
        <span
          style={MONO}
          className={`rounded-full px-1.5 py-0.5 text-[10px] transition ${
            active ? 'bg-accent/15 font-bold text-accent' : 'bg-tint text-muted dark:bg-darkCard dark:text-darkMuted'
          }`}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

export default function Header({
  theme,
  onToggleTheme,
  currentView,
  onViewChange,
  patientCount,
  isDetailOpen,
  autopilot,
  onStopAutopilot,
}) {
  const dark = theme === 'dark';
  const autonomousView = currentView === 'autonomous' && !isDetailOpen;

  /*
   * Publish the header's real height to CSS.
   *
   * Anything else that has to pin below this bar needs the number, and the bar
   * changes height with the viewport (it wraps to two rows under ~1024px). A
   * hard-coded offset would silently overlap the moment either changed, so the
   * height is measured and re-measured on resize instead of guessed.
   */
  const barRef = useRef(null);
  useEffect(() => {
    const node = barRef.current;
    if (!node) return undefined;
    const publish = () => {
      document.documentElement.style.setProperty('--app-header-h', `${Math.round(node.getBoundingClientRect().height)}px`);
    };
    publish();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(node);
    window.addEventListener('resize', publish);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', publish);
    };
  }, []);

  return (
    <header
      ref={barRef}
      className="sticky top-0 z-30 select-none border-b border-line/80 bg-white/80 shadow-soft backdrop-blur-xl transition-colors dark:border-darkBorder dark:bg-darkCard/85"
    >
      {/* A warm wash over the surface — the header sits on the same paper as the
          page, so a flat white bar looked pasted on top of it. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-white/95 to-transparent dark:from-white/[0.04]"
      />
      <BrandRule />

      <div className="relative mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-3.5">
        {/* ------------------------------------------------ brand lockup */}
        <div className="flex items-center gap-4">
          <NeuroPilotLogo subtitle="Clinical Decision Support" onClick={() => onViewChange('overview')} />
          <Rule />
        </div>

        {/* ------------------------------------------ main navigation */}
        <nav
          aria-label="Primary"
          className="flex items-center gap-1 rounded-2xl border border-line/70 bg-tint/60 p-1 shadow-[inset_0_1px_2px_rgba(19,21,26,0.06)] dark:border-darkBorder dark:bg-darkBorderSubtle"
        >
          <NavTab
            active={currentView === 'overview' && !isDetailOpen}
            icon={LayoutDashboard}
            label="Dashboard"
            onClick={() => onViewChange('overview')}
          />
          <NavTab
            active={currentView === 'all' || isDetailOpen}
            icon={Users}
            label="Patients"
            badge={patientCount}
            onClick={() => onViewChange('all')}
          />
          <NavTab
            active={currentView === 'simulator' && !isDetailOpen}
            accent
            icon={SlidersHorizontal}
            label="Risk Simulator"
            onClick={() => onViewChange('simulator')}
          />
          <NavTab
            active={currentView === 'interop'}
            accent
            icon={Plug}
            label="Interoperability"
            title="HL7 FHIR R4 exchange — export, inbound ingestion, orders/results and SMART launch"
            onClick={() => onViewChange('interop')}
          />
        </nav>

        {/* -------------------------------- autonomous run + theme toggle */}
        <div className="flex items-center gap-2.5">
          {/*
           * This button is the ONLY autonomous control that lives outside the
           * view tree, on purpose: the run refreshes data underneath it, so a
           * stop control rendered inside a view can be unmounted mid-run. While
           * it is on it becomes Stop, in the sticky header, whatever view you are
           * on — and Esc does the same thing.
           */}
          <button
            onClick={() => (autopilot ? onStopAutopilot() : onViewChange('autonomous'))}
            title={
              autopilot
                ? 'Stop the supervised run (or press Esc)'
                : 'The model proposes the next batch of tests with its reasoning; a clinician approves what actually runs'
            }
            className={`inline-flex h-9 items-center gap-2 rounded-xl px-4 text-[13px] font-semibold tracking-[-0.01em] transition-all duration-200 active:scale-[0.97] ${
              autopilot
                ? 'bg-tierHigh text-white shadow-glow-high'
                : autonomousView
                  ? 'bg-gradient-to-r from-accent to-[#0FA0A0] text-white shadow-glow-teal ring-1 ring-accent/30'
                  : 'bg-gradient-to-r from-[#0E8C8C] to-[#12A3A3] text-white shadow-glow-teal hover:from-accent hover:to-[#0FA0A0] hover:shadow-lift'
            }`}
          >
            {autopilot ? (
              <>
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                Stop
              </>
            ) : (
              <>
                <Workflow className="h-4 w-4" strokeWidth={2.3} />
                Autonomous Neuro
              </>
            )}
          </button>

          <Rule />

          <button
            onClick={onToggleTheme}
            aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            title={dark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
            className="group flex h-9 w-9 items-center justify-center rounded-xl border border-line bg-white shadow-soft transition-all duration-200 hover:border-accent/50 hover:shadow-lift dark:border-darkBorder dark:bg-darkCard"
          >
            {dark ? (
              <Sun className="h-4 w-4 text-amber-500 transition-transform duration-300 group-hover:rotate-45" />
            ) : (
              <Moon className="h-4 w-4 text-slate-700 transition-transform duration-300 group-hover:-rotate-12 dark:text-darkText" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
