// Shared clinical-domain helpers used across the dashboard.

export const STAGES_SHORT = ['Cognitive', 'Blood', 'MRI', 'PET'];

export const STAGES_FULL = [
  'Cognitive screening',
  'Blood biomarkers',
  'MRI volumetrics',
  'PET imaging',
];

// Tier thresholds are configurable in production; mirror the blueprint (0.7 / 0.4).
export function riskTier(score) {
  if (score > 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

// Restrained accent usage: a small dot + colored text + thin fill.
export const TIER_META = {
  high: { label: 'High', dot: 'bg-red-500', text: 'text-red-600', bar: 'bg-red-500' },
  medium: { label: 'Medium', dot: 'bg-amber-500', text: 'text-amber-600', bar: 'bg-amber-500' },
  low: { label: 'Low', dot: 'bg-emerald-500', text: 'text-emerald-600', bar: 'bg-emerald-500' },
};

export const MICRO = 'text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-400';

export const fmtScore = (s) => s.toFixed(2);

export const fmtPercent = (s) => `${Math.round(s * 100)}%`;