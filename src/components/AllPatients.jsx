import { useEffect, useMemo, useState } from 'react';
import { Users } from 'lucide-react';
import { STAGES_FULL, STAGES_SHORT } from '../lib.js';
import {
  Chevron,
  MONO,
  NoRows,
  PatientTable,
  SearchIcon,
  Segment,
  TIER_HEX,
  TIER_LABEL,
  controlBase,
} from './widgets.jsx';

const PAGE_SIZE = 15;
const TIERS = ['high', 'medium', 'low'];

export default function AllPatients({ patients, onSelect, onSimulate }) {
  const [tierFilter, setTierFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState(0); // 0 = all
  const [sortKey, setSortKey] = useState('risk-desc');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  const counts = useMemo(() => {
    const c = { high: 0, medium: 0, low: 0 };
    patients.forEach((p) => {
      if (c[p.risk_tier] !== undefined) c[p.risk_tier] += 1;
    });
    return c;
  }, [patients]);

  const stageCounts = useMemo(() => {
    const c = [0, 0, 0, 0];
    patients.forEach((p) => {
      if (p.stage >= 1 && p.stage <= 4) c[p.stage - 1] += 1;
    });
    return c;
  }, [patients]);

  const rows = useMemo(() => {
    let list = patients;
    if (tierFilter !== 'all') list = list.filter((p) => p.risk_tier === tierFilter);
    if (stageFilter !== 0) list = list.filter((p) => p.stage === stageFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      list = list.filter((p) => p.id.toLowerCase().includes(q));
    }
    const sorted = [...list];
    if (sortKey === 'risk-desc') sorted.sort((a, b) => b.score - a.score);
    if (sortKey === 'risk-asc') sorted.sort((a, b) => a.score - b.score);
    if (sortKey === 'stage') sorted.sort((a, b) => a.stage - b.stage || b.score - a.score);
    return sorted;
  }, [patients, tierFilter, stageFilter, query, sortKey]);

  useEffect(() => {
    setPage(1);
  }, [tierFilter, stageFilter, query, sortKey, patients]);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const from = total === 0 ? 0 : (safePage - 1) * PAGE_SIZE + 1;
  const to = Math.min(safePage * PAGE_SIZE, total);
  const hasFilters = tierFilter !== 'all' || stageFilter !== 0 || query.trim() !== '';

  const clearFilters = () => {
    setTierFilter('all');
    setStageFilter(0);
    setQuery('');
  };

  return (
    <div className="space-y-8 animate-fade-up">
      {/* Premium Heading + controls */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5 border-b border-line/80 dark:border-darkBorder/80 pb-6">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent/20 to-accent/5 dark:from-accent/25 dark:to-accent/10 border border-accent/25 text-accent shadow-sm">
            <Users className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-[28px] sm:text-[32px] font-black tracking-tight text-ink dark:text-darkText leading-none">
              Patient Worklist
            </h1>
            <p className="mt-1.5 text-[13px] text-muted dark:text-darkMuted flex flex-wrap items-center gap-x-2.5 gap-y-1">
              <span>Cohort Registry</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span><strong style={MONO} className="font-semibold text-ink dark:text-darkText">{patients.length}</strong> total subjects</span>
              <span className="text-line dark:text-darkBorder font-light">/</span>
              <span>Stage Gate Priority</span>
            </p>
          </div>
        </div>

        {/* Filter Toolbar */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <SearchIcon />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subject ID…"
              className={`${controlBase} w-56 pl-9`}
            />
          </div>

          <div className="inline-flex items-center gap-0.5 rounded-xl border border-line dark:border-darkBorder bg-[#F7F5F1] dark:bg-darkBorderSubtle p-1">
            <Segment label="All Tiers" count={patients.length} active={tierFilter === 'all'} onClick={() => setTierFilter('all')} />
            {TIERS.map((t) => (
              <Segment
                key={t}
                label={TIER_LABEL[t]}
                count={counts[t]}
                active={tierFilter === t}
                onClick={() => setTierFilter(t)}
              />
            ))}
          </div>

          <div className="relative">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              className={`${controlBase} appearance-none pr-8 font-medium cursor-pointer`}
            >
              <option value="risk-desc">Sort: Risk (High → Low)</option>
              <option value="risk-asc">Sort: Risk (Low → High)</option>
              <option value="stage">Sort: Pipeline Stage</option>
            </select>
            <Chevron />
          </div>
        </div>
      </div>

      {/* Stage filter pills */}
      <div className="-mt-2 flex flex-wrap items-center gap-3">
        <span className="text-xs font-semibold text-muted dark:text-darkMuted">Stage Gate:</span>
        <div className="inline-flex items-center gap-0.5 rounded-xl border border-line dark:border-darkBorder bg-[#F7F5F1] dark:bg-darkBorderSubtle p-1">
          <Segment label="All Stages" count={patients.length} active={stageFilter === 0} onClick={() => setStageFilter(0)} size="xs" />
          {STAGES_SHORT.map((label, i) => (
            <Segment
              key={label}
              label={`${label} (${i + 1})`}
              count={stageCounts[i]}
              active={stageFilter === i + 1}
              onClick={() => setStageFilter(i + 1)}
              size="xs"
            />
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-line/70 dark:border-darkBorder/70 bg-white/60 dark:bg-darkCard/60">
        {rows.length === 0 ? (
          <NoRows onClear={clearFilters} hasFilters={hasFilters} />
        ) : (
          <>
            <PatientTable rows={pageRows} onSelect={onSelect} onSimulate={onSimulate} />
            {/* Pagination */}
            <div className="flex items-center justify-between border-t border-line dark:border-darkBorder px-6 py-3.5 bg-tint/40 dark:bg-darkCard">
              <p style={MONO} className="text-xs text-muted dark:text-darkMuted">
                Showing <strong className="text-ink dark:text-darkText">{from}–{to}</strong> of <strong className="text-ink dark:text-darkText">{total}</strong> subjects
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  className="rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 py-1.5 text-xs font-semibold text-ink dark:text-darkText transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Previous
                </button>
                <span style={MONO} className="px-2 text-xs font-bold text-muted dark:text-darkMuted">
                  {safePage} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= totalPages}
                  className="rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3.5 py-1.5 text-xs font-semibold text-ink dark:text-darkText transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-30"
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}