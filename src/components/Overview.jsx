import { useMemo } from 'react';
import { LayoutDashboard } from 'lucide-react';
import FeatureRadarChart from './FeatureRadarChart.jsx';
import RiskDistributionChart from './RiskDistributionChart.jsx';
import StageProgressionChart from './StageProgressionChart.jsx';
import {
  CohortSummary,
  MONO,
  PatientTable,
  SectionLabel,
} from './widgets.jsx';

const SHORTLIST_SIZE = 8;

export default function Overview({
  patients,
  globalImportance = [],
  modelInfo = null,
  onSelect,
  onShowAll,
  onOpenSimulator,
}) {
  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    patients.forEach((p) => {
      if (c[p.risk_tier] !== undefined) c[p.risk_tier] += 1;
    });
    return c;
  }, [patients]);

  const meanRisk = useMemo(
    () => (patients.length ? patients.reduce((a, p) => a + p.score, 0) / patients.length : 0),
    [patients]
  );

  const shortlist = useMemo(
    () => [...patients].sort((a, b) => b.score - a.score).slice(0, SHORTLIST_SIZE),
    [patients]
  );

  const highCount = counts.high;
  const total = patients.length;

  return (
    <div className="space-y-12 animate-fade-up">
      {/* Premium Title Header */}
      <div className="relative pb-6 border-b border-line/80 dark:border-darkBorder/80">
        <div className="flex flex-wrap items-center justify-between gap-6">
          <div className="flex items-center gap-3.5">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 dark:from-accent/25 dark:to-accent/10 border border-accent/25 text-accent shadow-sm">
              <LayoutDashboard className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-[28px] sm:text-[32px] font-black tracking-tight text-ink dark:text-darkText leading-none">
                Cohort Overview
              </h1>
              <p className="mt-1.5 text-[13px] text-muted dark:text-darkMuted flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span>Multi-stage progression tracking</span>
                <span className="text-line dark:text-darkBorder font-light">/</span>
                <span><strong style={MONO} className="font-semibold text-ink dark:text-darkText">{total}</strong> longitudinal subjects</span>
                <span className="text-line dark:text-darkBorder font-light">/</span>
                <span>Active Risk Stratification</span>
              </p>
            </div>
          </div>
        </div>
      </div>
       

      




      {/* Cohort KPIs */}
      <CohortSummary counts={counts} meanRisk={meanRisk} total={total} />

      {/* Visual Analytics - Untrapped Side by Side with 1:1 Height Parity */}
      <div className="border-t border-line dark:border-darkBorder pt-8">
        <div className="grid gap-10 lg:grid-cols-2 items-stretch">
          <RiskDistributionChart patients={patients} />
          <StageProgressionChart patients={patients} />
        </div>
      </div>

      {globalImportance.length > 0 && (
        <div className="border-t border-line dark:border-darkBorder pt-8">
          <div className="flex items-baseline justify-between gap-2 mb-3">
            <SectionLabel>
              Cohort Feature Importance
            </SectionLabel>
            
          </div>
          <FeatureRadarChart data={globalImportance} />
        </div>
      )}
      

      

      {/* Highest Priority Shortlist */}
      <div className="border-t border-line dark:border-darkBorder pt-8">
        <div className="flex items-baseline justify-between gap-4">
          <SectionLabel>
            Top Priority Patients
          </SectionLabel>
          <button
            onClick={onShowAll}
            className="group inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline transition"
          >
            View all {total} patients
            <svg
              className="transition group-hover:translate-x-0.5"
              width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
            >
              <path d="m9 6 6 6-6 6" />
            </svg>
          </button>
        </div>
        <p className="mt-1 text-xs text-muted dark:text-darkMuted">
          Top {Math.min(SHORTLIST_SIZE, shortlist.length)} ranked by progression probability {highCount > SHORTLIST_SIZE ? `(${highCount} total in High tier)` : ''}
        </p>
        <div className="mt-4 rounded-2xl border border-line dark:border-darkBorder bg-white/70 dark:bg-darkCard/70 overflow-hidden">
          {shortlist.length === 0 ? (
            <p className="px-5 py-16 text-center text-xs text-muted dark:text-darkMuted">No patients loaded.</p>
          ) : (
            <PatientTable rows={shortlist} compact onSelect={onSelect} />
          )}
        </div>
      </div>
  

  {/* Global explainability - Radar Web (Clean & Untrapped) */}
      
    </div>
  );
   }
      
