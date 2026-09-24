import { useEffect, useMemo, useState } from 'react';
import { Layers, Scale, Users } from 'lucide-react';
import { STAGES_SHORT } from '../lib.js';
import CohortComposition from './CohortComposition.jsx';
import {
  Chevron,
  MONO,
  NoRows,
  PatientTable,
  SearchIcon,
  StageIcon,
  STAGE_FILLS,
  TIER_HEX,
  TIER_LABEL,
  controlBase,
} from './widgets.jsx';

// Ten per page by request: one screen of table, no scrolling pane, and the page
// itself is the only scroll axis.
const PAGE_SIZE = 10;
const TIERS = ['high', 'medium', 'low'];

export default function AllPatients({ patients, onSelect, onSimulate, onCompare }) {
  const [tierFilter, setTierFilter] = useState('all');
  const [stageFilter, setStageFilter] = useState(0); // 0 = all
  const [sortKey, setSortKey] = useState('risk-desc');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // Multi-select for priority comparison (2..6 subjects)
  const [compareIds, setCompareIds] = useState([]);
  const toggleCompare = (id) =>
    setCompareIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 6 ? cur : [...cur, id]
    );

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
    const priority = (p) => p.final_score ?? p.score;
    if (sortKey === 'risk-desc') sorted.sort((a, b) => priority(b) - priority(a));
    if (sortKey === 'risk-asc') sorted.sort((a, b) => priority(a) - priority(b));
    if (sortKey === 'stage') sorted.sort((a, b) => a.stage - b.stage || priority(b) - priority(a));
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
      {/* ================================================================ */}
      {/* Page header — identity left, the tier filter right as three        */}
      {/* snapshot cards. Those replaced a segmented track that only stated   */}
      {/* counts; a card states the count AND its share in the tier's own     */}
      {/* colour, and filters in place, so one control does the job of two.   */}
      {/* ================================================================ */}
      <div className="relative border-b border-line/80 pb-6 dark:border-darkBorder/80">
        {/* A soft accent wash behind the masthead. The block sat on flat paper
            with nothing behind it, which is most of why three lines of type read
            as plain; this gives the surface depth without adding a single box. */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -left-8 -top-5 h-36 w-[560px] bg-[radial-gradient(58%_120%_at_22%_0%,rgba(13,130,130,0.075),transparent_72%)] dark:bg-[radial-gradient(58%_120%_at_22%_0%,rgba(20,180,180,0.11),transparent_72%)]"
        />

        <div className="relative flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
          <div className="flex items-center gap-4">
            <div className="relative flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-[18px] border border-accent/25 bg-gradient-to-br from-accent/30 via-accent/10 to-transparent text-accent shadow-[0_10px_24px_-12px_rgba(13,130,130,0.8)]">
              <Users className="h-[22px] w-[22px]" />
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-[18px] ring-1 ring-inset ring-white/50 dark:ring-white/10"
              />
            </div>

            {/*
             * The masthead is QUOTED by a full-height accent rule on its leading
             * edge. Three left-aligned lines with nothing holding them had no
             * edge to hang from; the rule supplies one, and the tracked eyebrow
             * above the title is what makes the size jump read as a hierarchy
             * rather than a stack of sentences.
             *
             * No "Ranked queue" chip, and no per-line badge: a pill that restates
             * what the heading already says is decoration competing with the tier
             * cards for the same line. Weight and rule do that job instead.
             */}
            <div className="relative pl-[18px]">
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 h-full w-px bg-gradient-to-b from-accent via-accent/35 to-transparent"
              />
              <div className="flex items-center gap-2.5">
                <span className="h-[3px] w-[3px] rounded-full bg-accent shadow-[0_0_8px_rgba(13,130,130,0.6)]" />
                <p className="text-[10px] font-bold uppercase tracking-[0.22em] text-accent">Cohort queue</p>
                <span
                  aria-hidden="true"
                  className="h-px w-14 bg-gradient-to-r from-accent/45 to-transparent"
                />
              </div>
              <h1 className="mt-2 text-[36px] font-black leading-[0.97] tracking-[-0.035em] text-ink dark:text-darkText sm:text-[40px]">
                Patient Worklist
              </h1>
              <p className="mt-2 text-[13.5px] leading-relaxed text-muted dark:text-darkMuted">
                <strong style={MONO} className="text-[15px] font-black tabular-nums text-ink dark:text-darkText">
                  {patients.length.toLocaleString()}
                </strong>{' '}
                subjects, ordered by refined-model priority — highest first.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2">
            {TIERS.map((t) => {
              const active = tierFilter === t;
              const n = counts[t] || 0;
              const share = patients.length ? Math.round((n / patients.length) * 100) : 0;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTierFilter(active ? 'all' : t)}
                  title={active ? 'Clear this filter' : `Show ${TIER_LABEL[t]} priority only`}
                  className={`relative w-[106px] overflow-hidden rounded-2xl border px-3.5 pb-2.5 pt-3 text-left transition ${
                    active
                      ? 'border-accent/50 bg-white shadow-soft ring-1 ring-accent/30 dark:border-accent/50 dark:bg-darkCard'
                      : 'border-line/80 bg-white/60 hover:border-accent/40 hover:bg-white dark:border-darkBorder dark:bg-darkCard/50 dark:hover:bg-darkCard'
                  }`}
                >
                  <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: TIER_HEX[t] }} />
                  <p className="text-[9.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">
                    {TIER_LABEL[t]}
                  </p>
                  <p style={MONO} className="mt-1 text-[19px] font-black leading-none tabular-nums text-ink dark:text-darkText">
                    {n.toLocaleString()}
                  </p>
                  <p style={MONO} className="mt-1 text-[9.5px] tabular-nums text-muted dark:text-darkMuted">
                    {share}% of cohort
                  </p>
                </button>
              );
            })}
          </div>
        </div>

        {/* controls */}
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <div className="relative">
            <SearchIcon />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search subject ID…"
              className={`${controlBase} w-60 pl-9`}
            />
          </div>

          <div className="relative">
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value)}
              className={`${controlBase} cursor-pointer appearance-none pr-8 font-medium`}
            >
              <option value="risk-desc">Sort: Priority (High → Low)</option>
              <option value="risk-asc">Sort: Priority (Low → High)</option>
              <option value="stage">Sort: Pipeline Stage</option>
            </select>
            <Chevron />
          </div>

          {tierFilter !== 'all' && (
            <button
              type="button"
              onClick={() => setTierFilter('all')}
              className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-[11px] font-semibold text-accent transition hover:bg-accent/10"
            >
              {TIER_LABEL[tierFilter]} only — clear
            </button>
          )}

          {stageFilter !== 0 && (
            <button
              type="button"
              onClick={() => setStageFilter(0)}
              className="rounded-xl border border-accent/40 bg-accent/5 px-3 py-2 text-[11px] font-semibold text-accent transition hover:bg-accent/10"
            >
              Stage {stageFilter} only — clear
            </button>
          )}

          {hasFilters && (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-xl border border-line px-3 py-2 text-[11px] font-semibold text-muted transition hover:border-accent hover:text-accent dark:border-darkBorder dark:text-darkMuted"
            >
              Reset all
            </button>
          )}
        </div>
      </div>

      {/* Compare selection bar */}
      {compareIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-accent/40 bg-accent/5 px-5 py-3.5 dark:bg-accent/10 animate-fade-up">
          <Scale className="h-4 w-4 text-accent" />
          <p className="text-xs font-semibold text-ink dark:text-darkText">
            <strong style={MONO}>{compareIds.length}</strong> selected{compareIds.length < 2 && ' — pick at least one more'}
            {compareIds.length >= 6 && ' (max 6)'}
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            {compareIds.map((id) => (
              <span key={id} style={MONO} className="inline-flex items-center gap-1 rounded-full bg-white dark:bg-darkCard px-2 py-0.5 text-[10.5px] font-bold text-accent border border-accent/30">
                {id}
                <button onClick={() => toggleCompare(id)} aria-label={`Deselect ${id}`} className="hover:text-tierHigh">✕</button>
              </span>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => setCompareIds([])}
              className="rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-3 py-1.5 text-[11px] font-semibold text-muted dark:text-darkMuted transition hover:border-accent"
            >
              Clear
            </button>
            <button
              onClick={() => onCompare?.(compareIds)}
              disabled={compareIds.length < 2}
              className="rounded-xl bg-accent px-4 py-1.5 text-[11px] font-bold text-white shadow-soft transition hover:bg-accentHover disabled:cursor-not-allowed disabled:opacity-40"
            >
              Compare Priority
            </button>
          </div>
        </div>
      )}

      {/*
       * Composition, in one strip instead of two panels.
       *
       * The panels were 561px together and pushed the first patient row 76px
       * below the fold — a queue page whose first screen held no queue. At this
       * height the list starts above the fold, and the strip does two jobs the
       * panels could not: it states each figure once (the counts live on the
       * filter cards above), and its segments ARE the filters for the list below.
       */}
      <CohortComposition
        patients={patients}
        tierFilter={tierFilter}
        stageFilter={stageFilter}
        onSelectTier={(key) => setTierFilter(key ?? 'all')}
        onSelectStage={(stage) => setStageFilter(stage ?? 0)}
      />

      {/* ================================================================ */}
      {/* Stage gate — the tier filter's card language, in stage colours.    */}
      {/* A segmented track of two-letter labels ("NS (1)", "B (2)") told you  */}
      {/* nothing about what a stage IS; these carry the modality icon, the    */}
      {/* count and its share, and they filter in place.                       */}
      {/* ================================================================ */}
      <div className="-mt-3 flex flex-wrap items-center gap-2">
        <p className="mr-1 text-[10.5px] font-bold uppercase tracking-[0.14em] text-muted dark:text-darkMuted">
          Stage gate
        </p>

        {/*
         * The scope card: same size, same rhythm, same top rule as the four stage
         * cards beside it, so "All stages" reads as one of the choices rather than
         * as a stray chip that happens to sit next to them. It carries no count —
         * the total is in the masthead and the pagination line, and a third copy
         * 900px down was the page's worst offender.
         */}
        <button
          type="button"
          onClick={() => setStageFilter(0)}
          title={stageFilter === 0 ? 'Showing every stage' : 'Show every stage again'}
          className={`relative flex items-center gap-2.5 self-stretch overflow-hidden rounded-2xl border px-3 text-left transition ${
            stageFilter === 0
              ? 'border-accent/50 bg-white shadow-soft ring-1 ring-accent/30 dark:border-accent/50 dark:bg-darkCard'
              : 'border-line/80 bg-white/60 hover:border-accent/40 hover:bg-white dark:border-darkBorder dark:bg-darkCard/50 dark:hover:bg-darkCard'
          }`}
        >
          <span
            className={`absolute inset-x-0 top-0 h-[3px] ${
              stageFilter === 0 ? 'bg-accent' : 'bg-line dark:bg-darkBorder'
            }`}
          />
          <span
            className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition ${
              stageFilter === 0
                ? 'border-accent/40 bg-accent/10 text-accent'
                : 'border-line/80 bg-tint/70 text-muted dark:border-darkBorder dark:bg-darkBorder/40 dark:text-darkMuted'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
          </span>
          <span>
            <span className="block text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
              Scope
            </span>
            <span
              className={`mt-0.5 block text-[13px] font-bold leading-none ${
                stageFilter === 0 ? 'text-accent' : 'text-ink dark:text-darkText'
              }`}
            >
              All stages
            </span>
          </span>
        </button>

        {STAGES_SHORT.map((label, i) => {
          const stage = i + 1;
          const active = stageFilter === stage;
          const n = stageCounts[i] || 0;
          const share = patients.length ? Math.round((n / patients.length) * 100) : 0;
          const hex = STAGE_FILLS[i];
          return (
            <button
              key={label}
              type="button"
              onClick={() => setStageFilter(active ? 0 : stage)}
              title={active ? 'Clear this stage filter' : `Show stage ${stage} only — ${label}`}
              className={`relative flex items-center gap-2.5 overflow-hidden rounded-2xl border px-3 py-2 text-left transition ${
                active
                  ? 'border-accent/50 bg-white shadow-soft ring-1 ring-accent/30 dark:border-accent/50 dark:bg-darkCard'
                  : 'border-line/80 bg-white/60 hover:border-accent/40 hover:bg-white dark:border-darkBorder dark:bg-darkCard/50 dark:hover:bg-darkCard'
              }`}
            >
              <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: hex }} />
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border"
                style={{ background: `${hex}18`, borderColor: `${hex}44` }}
              >
                <StageIcon stage={stage} hex={hex} />
              </span>
              <span>
                <span className="block text-[9.5px] font-bold uppercase tracking-[0.12em] text-muted dark:text-darkMuted">
                  Stage {stage}
                </span>
                <span className="mt-0.5 flex items-baseline gap-1.5">
                  <span style={MONO} className="text-[15px] font-black leading-none tabular-nums text-ink dark:text-darkText">
                    {n.toLocaleString()}
                  </span>
                  <span style={MONO} className="text-[9.5px] tabular-nums text-muted dark:text-darkMuted">
                    {share}%
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {/*
       * The list is deliberately NOT in a card. A bordered, rounded, tinted box
       * around a table draws a frame the page rhythm does not need and made the
       * rows read as content trapped inside a widget. It sits on the page
       * surface, held together by hairlines: a rule above the header, rules
       * between rows, and the sticky header's own background doing the rest.
       */}
      <div className="relative border-t border-line/70 dark:border-darkBorder/70">
        {rows.length === 0 ? (
          <NoRows onClear={clearFilters} hasFilters={hasFilters} />
        ) : (
          <>
            <PatientTable
              rows={pageRows}
              onSelect={onSelect}
              onSimulate={onSimulate}
              selectable
              selectedIds={compareIds}
              onToggleSelect={toggleCompare}
              pageOffset={(safePage - 1) * PAGE_SIZE}
            />
            {/* Pagination */}
            {/*
             * One joined control rather than three floating buttons: the two
             * steps and the page counter share a single border, so the strip
             * reads as one instrument and the count cannot drift away from the
             * buttons it belongs to.
             */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-[#FBF9F5]/80 px-6 py-3.5 backdrop-blur dark:border-darkBorder dark:bg-darkBg/60">
              <p style={MONO} className="text-[11.5px] text-muted dark:text-darkMuted">
                Rows <strong className="font-bold text-ink dark:text-darkText">{from}–{to}</strong> of{' '}
                <strong className="font-bold text-ink dark:text-darkText">{total.toLocaleString()}</strong>
                <span className="mx-2 opacity-40">·</span>
                {PAGE_SIZE} per page
              </p>
              <div className="inline-flex items-center overflow-hidden rounded-xl border border-line bg-white dark:border-darkBorder dark:bg-darkCard">
                <button
                  onClick={() => setPage(safePage - 1)}
                  disabled={safePage <= 1}
                  className="border-r border-line/70 px-3.5 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-accent/5 hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 dark:border-darkBorder/70 dark:text-darkText"
                >
                  ← Previous
                </button>
                <span style={MONO} className="px-3.5 py-1.5 text-[11px] font-bold tabular-nums text-ink dark:text-darkText">
                  {String(safePage).padStart(2, '0')} / {String(totalPages).padStart(2, '0')}
                </span>
                <button
                  onClick={() => setPage(safePage + 1)}
                  disabled={safePage >= totalPages}
                  className="border-l border-line/70 px-3.5 py-1.5 text-[11px] font-semibold text-ink transition hover:bg-accent/5 hover:text-accent disabled:cursor-not-allowed disabled:opacity-30 dark:border-darkBorder/70 dark:text-darkText"
                >
                  Next →
                </button>
              </div>
            </div>
          </>
        )}
      </div>

    </div>
  );
}