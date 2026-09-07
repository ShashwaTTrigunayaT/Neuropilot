import { useState, useMemo } from 'react';
import { MONO, SectionLabel, TIER_HEX, STAGE_FILLS, StageIcon } from './widgets.jsx';
import { STAGES_FULL } from '../lib.js';

const STAGE_DESCRIPTIONS = [
  'Initial neurocognitive assessment (MMSE, MoCA, memory tests)',
  'Plasma p-tau181, Aβ42/40 ratio & NfL liquid biopsy',
  'High-resolution structural MRI hippocampal volumetry',
  'Confirmatory Amyloid & Tau tracer molecular imaging',
];

export default function StageProgressionChart({ patients = [] }) {
  const [activeStage, setActiveStage] = useState(null);

  const total = Math.max(patients.length, 1);

  // Compute rich metrics per stage
  const stageStats = useMemo(() => {
    return [1, 2, 3, 4].map((stageNum) => {
      const stagePatients = patients.filter((p) => p.stage === stageNum);
      const count = stagePatients.length;
      const pct = (count / total) * 100;
      const meanRisk =
        count > 0 ? stagePatients.reduce((sum, p) => sum + p.score, 0) / count : 0;

      const tiers = {
        high: stagePatients.filter((p) => p.risk_tier === 'high').length,
        medium: stagePatients.filter((p) => p.risk_tier === 'medium').length,
        low: stagePatients.filter((p) => p.risk_tier === 'low').length,
      };

      return {
        stage: stageNum,
        name: STAGES_FULL[stageNum - 1],
        description: STAGE_DESCRIPTIONS[stageNum - 1],
        count,
        pct,
        meanRisk,
        tiers,
        hex: STAGE_FILLS[stageNum - 1] || '#0D8282',
      };
    });
  }, [patients, total]);

  const maxCount = Math.max(...stageStats.map((s) => s.count), 1);

  return (
    <div className="select-none flex flex-col justify-between h-full">
      {/* 1. Header Row */}
      <div className="mb-4">
        <SectionLabel>
          Patients by Diagnostic Stage
        </SectionLabel>
      </div>

      {/* 2. Top Ribbon Bar (Symmetric Height: ~48px) */}
      <div className="mb-4 grid grid-cols-4 gap-2 p-1.5 rounded-xl bg-surface/80 dark:bg-darkBg/60 border border-line/60 dark:border-darkBorder/60 min-h-[50px] items-center">
        {stageStats.map((s) => {
          const isSelected = activeStage === s.stage;
          return (
            <button
              key={s.stage}
              type="button"
              onClick={() => setActiveStage(isSelected ? null : s.stage)}
              className={`group flex items-center justify-center gap-1.5 py-2 px-1 rounded-lg text-center transition-all duration-300 ${
                isSelected
                  ? 'bg-white dark:bg-darkCard shadow-sm ring-1 ring-accent'
                  : 'hover:bg-white/50 dark:hover:bg-darkCard/40'
              }`}
            >
              <span
                className="flex h-4 w-4 items-center justify-center rounded-sm shrink-0"
                style={{ background: `${s.hex}18` }}
              >
                <StageIcon stage={s.stage} hex={s.hex} />
              </span>
              <span className="text-[11px] font-bold text-ink dark:text-darkText leading-none" style={MONO}>
                St. {s.stage}
              </span>
              <span className="text-[11px] font-black" style={{ ...MONO, color: s.hex }}>
                {s.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* 3. Main Visual Area (Proportionate Height) */}
      <div className="space-y-2.5 my-auto">
        {stageStats.map((s) => {
          const isHighlighted = activeStage === null || activeStage === s.stage;
          const barPct = Math.max(8, (s.count / maxCount) * 100);

          return (
            <div
              key={s.stage}
              onMouseEnter={() => setActiveStage(s.stage)}
              onMouseLeave={() => setActiveStage(null)}
              className={`p-2.5 rounded-xl border transition-all duration-300 cursor-pointer ${
                activeStage === s.stage
                  ? 'border-accent/40 bg-accent/5 dark:bg-accent/10 shadow-sm'
                  : isHighlighted
                  ? 'border-line/40 dark:border-darkBorder/40 bg-surface/30 dark:bg-darkBg/20 hover:bg-surface/60 dark:hover:bg-darkBg/50'
                  : 'opacity-40 border-transparent'
              }`}
            >
              {/* Top Row: Icon, Title, Counts */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    style={{ background: `${s.hex}1A` }}
                  >
                    <StageIcon stage={s.stage} hex={s.hex} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-semibold text-ink dark:text-darkText truncate">
                        {s.name}
                      </span>
                      <span
                        className="text-[9.5px] px-1 py-0.2 rounded font-medium"
                        style={{ ...MONO, background: `${s.hex}15`, color: s.hex }}
                      >
                        Stage {s.stage}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3 shrink-0" style={MONO}>
                  <div className="text-right">
                    <span className="text-[12.5px] font-bold text-ink dark:text-darkText">
                      {s.count}
                    </span>
                    <span className="ml-1 text-[10.5px] text-muted dark:text-darkMuted">
                      ({s.pct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="hidden sm:block text-right w-14">
                    <span className="text-[9.5px] text-muted dark:text-darkMuted block leading-tight">Avg</span>
                    <span className="text-[11px] font-bold" style={{ color: s.meanRisk >= 0.7 ? TIER_HEX.high : s.meanRisk >= 0.4 ? TIER_HEX.medium : TIER_HEX.low }}>
                      {s.meanRisk.toFixed(2)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Progress Track & Multi-Tier Composition Bar */}
              <div className="mt-2">
                <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-line/40 dark:bg-darkBorder/60 flex">
                  {s.count > 0 ? (
                    <>
                      <div
                        className="h-full transition-all duration-700"
                        style={{
                          width: `${(s.tiers.high / s.count) * barPct}%`,
                          backgroundColor: TIER_HEX.high,
                        }}
                        title={`High Risk: ${s.tiers.high}`}
                      />
                      <div
                        className="h-full transition-all duration-700"
                        style={{
                          width: `${(s.tiers.medium / s.count) * barPct}%`,
                          backgroundColor: TIER_HEX.medium,
                        }}
                        title={`Watch / Medium Risk: ${s.tiers.medium}`}
                      />
                      <div
                        className="h-full transition-all duration-700"
                        style={{
                          width: `${(s.tiers.low / s.count) * barPct}%`,
                          backgroundColor: TIER_HEX.low,
                        }}
                        title={`Low Risk: ${s.tiers.low}`}
                      />
                    </>
                  ) : (
                    <div className="h-full w-2 bg-muted/20" />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* 4. Bottom Telemetry Panel (Symmetric Height: ~48px) */}
      <div className="mt-4 pt-3 border-t border-line/60 dark:border-darkBorder/60">
        {activeStage ? (
          <div className="flex items-center justify-between text-xs font-semibold text-ink dark:text-darkText animate-fade-in py-1" style={MONO}>
            <span className="text-muted dark:text-darkMuted text-[11px]">
              {stageStats[activeStage - 1].description}
            </span>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[10px]">
                <span className="h-1.5 w-1.5 rounded-full bg-tierHigh" />
                {stageStats[activeStage - 1].tiers.high} High
              </span>
              <span className="flex items-center gap-1 text-[10px]">
                <span className="h-1.5 w-1.5 rounded-full bg-tierMedium" />
                {stageStats[activeStage - 1].tiers.medium} Watch
              </span>
              <span className="flex items-center gap-1 text-[10px]">
                <span className="h-1.5 w-1.5 rounded-full bg-tierLow" />
                {stageStats[activeStage - 1].tiers.low} Low
              </span>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 text-center text-xs" style={MONO}>
            {stageStats.map((s) => (
              <div key={s.stage} className="p-1.5 rounded-lg bg-surface/50 dark:bg-darkBg/30 border border-line/40 dark:border-darkBorder/40">
                <span className="text-[10px] text-muted dark:text-darkMuted block">Stage {s.stage}</span>
                <span className="text-[12px] font-bold text-ink dark:text-darkText">{s.pct.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
