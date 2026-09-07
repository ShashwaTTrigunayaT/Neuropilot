/**
 * NeuroPlot Brand Identity & Premium Medical Vector Icons
 * Ensures 100% visual consistency across Header, Footer, Modals, and Navigation.
 */

export function NeuroPlotIcon({ size = 'md', className = '' }) {
  const sizeMap = {
    xs: 'h-6 w-6 rounded-lg',
    sm: 'h-7 w-7 rounded-lg',
    md: 'h-9 w-9 rounded-xl',
    lg: 'h-11 w-11 rounded-2xl',
    xl: 'h-14 w-14 rounded-2xl',
  };

  const iconSizes = {
    xs: 'h-3.5 w-3.5',
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
    xl: 'h-8 w-8',
  };

  const containerClass = sizeMap[size] || sizeMap.md;
  const svgClass = iconSizes[size] || iconSizes.md;

  return (
    <div
      className={`relative flex shrink-0 items-center justify-center bg-gradient-to-tr from-[#0D8282] via-[#0FA0A0] to-[#2563EB] text-white shadow-glow-teal ${containerClass} ${className}`}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={svgClass}
        stroke="currentColor"
        strokeWidth="1.7"
      >
        {/* Left cerebral hemisphere contour */}
        <path
          d="M11 4.5C9.2 4.2 7.2 4.8 6 6.2C4.5 7.8 4.2 10.2 5 12.2C4 13.5 3.8 15.5 4.8 17C5.8 18.5 7.5 19.5 9.5 19.5C10.5 19.5 11 20 11.5 20.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Right cerebral hemisphere contour */}
        <path
          d="M13 4.5C14.8 4.2 16.8 4.8 18 6.2C19.5 7.8 19.8 10.2 19 12.2C20 13.5 20.2 15.5 19.2 17C18.2 18.5 16.5 19.5 14.5 19.5C13.5 19.5 13 20 12.5 20.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Central neural axis & synapses */}
        <line
          x1="12"
          y1="4.5"
          x2="12"
          y2="20.5"
          stroke="white"
          strokeOpacity="0.85"
          strokeWidth="1.3"
          strokeDasharray="1.5 2"
        />
        <circle cx="12" cy="7" r="1.2" fill="white" />
        <circle cx="12" cy="12.5" r="1.5" fill="#38E1B0" className="animate-pulse" />
        <circle cx="12" cy="18" r="1.2" fill="white" />
        {/* Cognitive lateral impulse nodes */}
        <circle cx="8" cy="11" r="1" fill="#FFFFFF" fillOpacity="0.9" />
        <circle cx="16" cy="11" r="1" fill="#FFFFFF" fillOpacity="0.9" />
        <circle cx="8.5" cy="15.5" r="1" fill="#FFFFFF" fillOpacity="0.9" />
        <circle cx="15.5" cy="15.5" r="1" fill="#FFFFFF" fillOpacity="0.9" />
        <path d="M8 11L12 12.5L16 11" stroke="#38E1B0" strokeWidth="0.9" strokeOpacity="0.75" />
      </svg>
    </div>
  );
}

export function NeuroPlotLogo({ size = 'md', showSubtitle = true, onClick }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      onClick={onClick}
      className={`flex items-center gap-3 text-left transition ${onClick ? 'hover:opacity-90 active:scale-[0.99]' : ''}`}
    >
      <NeuroPlotIcon size={size} />
      <div className="leading-tight">
        <h1 className="text-[16px] font-black tracking-tight text-ink dark:text-darkText">
          NeuroPlot
        </h1>
        {showSubtitle && (
          <p className="text-[10.5px] font-medium text-muted dark:text-darkMuted">
            Clinical Decision Support & Risk Triage
          </p>
        )}
      </div>
    </Comp>
  );
}

/**
 * Premium Clinical Risk Simulator Icon
 * Represents multi-parametric calibrated clinical modeling rather than a generic lightning bolt.
 */
export function SimulatorIcon({ size = 'sm', className = '' }) {
  const sizeMap = {
    xs: 'h-3.5 w-3.5',
    sm: 'h-4 w-4',
    md: 'h-5 w-5',
    lg: 'h-6 w-6',
  };

  const svgClass = sizeMap[size] || sizeMap.sm;

  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`${svgClass} ${className}`}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {/* Parameter Slider Track 1 */}
      <line x1="3" y1="6" x2="17" y2="6" strokeOpacity="0.4" />
      <circle cx="7" cy="6" r="2.2" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.6" />

      {/* Parameter Slider Track 2 */}
      <line x1="3" y1="14" x2="17" y2="14" strokeOpacity="0.4" />
      <circle cx="13" cy="14" r="2.2" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.6" />

      {/* Precision Calibration Center Path */}
      <path d="M7 8.2V10C7 10.5 7.5 11 8 11H12C12.5 11 13 11.5 13 12V11.8" strokeDasharray="1.2 1.5" />
    </svg>
  );
}
