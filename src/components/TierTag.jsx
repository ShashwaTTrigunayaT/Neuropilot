import { TIER_HEX, TIER_LABEL } from './widgets.jsx';

export default function TierTag({ tier, className = '', showDot = true, size = 'sm' }) {
  const hex = TIER_HEX[tier] || '#6E7175';
  const isHigh = tier === 'high';
  
  const sizeClasses = size === 'lg' 
    ? 'px-3 py-1 text-xs font-semibold' 
    : 'px-2.5 py-0.5 text-[11px] font-medium';

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border transition-all ${sizeClasses} ${className}`}
      style={{
        color: hex,
        backgroundColor: `${hex}12`,
        borderColor: `${hex}30`,
        boxShadow: isHigh ? `0 0 12px -3px ${hex}40` : undefined,
      }}
    >
      {showDot && (
        <span className="relative flex h-1.5 w-1.5">
          {isHigh && (
            <span
              className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75"
              style={{ backgroundColor: hex }}
            />
          )}
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ backgroundColor: hex }} />
        </span>
      )}
      {TIER_LABEL[tier] ?? tier}
    </span>
  );
}