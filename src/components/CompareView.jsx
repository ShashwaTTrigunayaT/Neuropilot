import { Scale } from 'lucide-react';
import TierTag from './TierTag.jsx';
import { MONO, SectionLabel, TIER_HEX } from './widgets.jsx';
import { fmtScore } from '../lib.js';

const SLOT_LABELS = { blood: 'Blood', imaging: 'MRI', pet: 'PET' };
const VERDICT_META = {
  risk_score: { label: 'Risk score', hex: TIER_HEX.high },
  conversion_forecast: { label: 'Conversion forecast', hex: '#7C3AED' },
  stage: { label: 'Pipeline stage', hex: '#0E7490' },
  tie: { label: 'Dead heat', hex: '#6B7280' },
};

function ScoreDots({ score }) {
  return (
    <div className="flex flex-col gap-[3px]">
      {[-4, -2, 0, 2, 4].map((d) => (
        <span
          key={d}
          className="h-[3px] rounded-full transition-all"
          style={{
            width: d === 0 ? 26 : 12,
            background: d === 0 ? TIER_HEX.high : 'currentColor',
            opacity: d === 0 ? 1 : 0.22,
          }}
        />
      ))}
    </div>
  );
}

export default function CompareView({ compare, loading, error, onExit, onOpenPatient }) {
  const items = compare?.patients ?? [];
  const rankOf = (id) => items.find((p) => p.id === id)?.rank ?? 0;

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line/80 dark:border-darkBorder/80 pb-5">
        <div className="flex items-center gap-3.5">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/20 to-accent/5 text-accent shadow-sm">
            <Scale className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-[28px] font-black leading-none tracking-tight text-ink dark:text-darkText sm:text-[32px]">
              Priority Comparison
            </h1>
            <p className="mt-1.5 text-[13px] text-muted dark:text-darkMuted">
              Explicit tiebreak ranking — same displayed score is not the same decision
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {onOpenPatient && items.length > 0 && (
            <button
              onClick={() => onOpenPatient(items[0].id)}
              className="rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-4 py-2 text-xs font-semibold text-ink dark:text-darkText transition hover:border-accent"
            >
              Open #{items[0].rank} · {items[0].id}
            </button>
          )}
          <button
            onClick={onExit}
            className="rounded-xl border border-line dark:border-darkBorder bg-white dark:bg-darkCard px-4 py-2 text-xs font-semibold text-ink dark:text-darkText transition hover:border-accent"
          >
            Back to Worklist
          </button>
        </div>
      </div>

      {loading && <p className="py-16 text-center text-sm text-muted dark:text-darkMuted">Ranking selected patients…</p>}

      {error && (
        <div className="rounded-2xl border border-tierHigh/40 bg-tierHigh/5 px-5 py-4 text-sm font-semibold text-tierHigh">{error}</div>
      )}

      {!loading && !error && items.length > 0 && (
        <>
          {/* Verdict banner */}
          <div className="rounded-2xl border border-accent/30 bg-gradient-to-br from-accent/[0.08] to-transparent px-6 py-5">
            <SectionLabel size="xs">Verdict</SectionLabel>
            <p className="mt-2 text-sm leading-relaxed text-ink dark:text-darkText">
              <strong>{items[0].id}</strong> goes first
              {items.length > 1 && (
                <>
                  {' '}over <strong>{items[1].id}</strong> — {compare.reasons?.[0]?.why ?? 'highest full-precision risk score.'}
                </>
              )}
            </p>
          </div>

          {/* Ranked list */}
          <div className="grid gap-4" style={{ gridTemplateColumns: `repeat(${Math.min(items.length, 3)}, minmax(0, 1fr))` }}>
            {items.map((p, idx) => (
              <div
                key={p.id}
                className="relative overflow-hidden rounded-2xl border border-line dark:border-darkBorder bg-white/70 dark:bg-darkCard/70 p-5"
                style={idx === 0 ? { borderColor: `${TIER_HEX.high}55`, boxShadow: `0 0 0 1px ${TIER_HEX.high}22` } : undefined}
                onClick={() => onOpenPatient?.(p.id)}
                role={onOpenPatient ? 'button' : undefined}
              >
                {idx === 0 && (
                  <span className="absolute right-4 top-4 rounded-full bg-tierHigh/10 px-2.5 py-1 text-[10px] font-bold text-tierHigh">
                    GOES FIRST
                  </span>
                )}
                <p style={MONO} className="text-[15px] font-black text-ink dark:text-darkText">
                  #{p.rank} · {p.id}
                </p>
                <p className="mt-0.5 text-[11px] text-muted dark:text-darkMuted">
                  {p.age ?? '—'}y {p.sex ?? ''} · {p.stage_name} · MMSE {p.mmse ?? '—'}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <span style={MONO} className="text-[22px] font-black text-ink dark:text-darkText">{fmtScore(p.score)}</span>
                  <TierTag tier={p.risk_tier} />
                </div>
                <div className="mt-2 flex items-end gap-3">
                  <ScoreDots score={p.score} />
                  <div className="pb-[2px] text-[10px] leading-tight text-muted dark:text-darkMuted">
                    full precision<br />{p.score.toFixed(4)}
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 border-t border-line/60 dark:border-darkBorder/60 pt-3 text-[11px]">
                  {[
                    ['12-mo conversion', p.forecast_available ? `${Math.round(p.conversion_probability * 100)}%` : 'n/a'],
                    ['Projected MMSE', p.projected_mmse_12mo != null ? `${p.mmse ?? '—'}→${p.projected_mmse_12mo}` : '—'],
                    ['Projected score', p.projected_score_12mo != null ? fmtScore(p.projected_score_12mo) : '—'],
                    ['Projected tier', p.projected_tier_12mo ? <TierTag key={p.id} tier={p.projected_tier_12mo} /> : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between gap-2">
                      <span className="text-muted dark:text-darkMuted">{k}</span>
                      <span className="font-semibold text-ink dark:text-darkText">{v}</span>
                    </div>
                  ))}
                </div>
                {/* Per-stage evidence chips */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {['blood', 'imaging', 'pet'].map((slot) => {
                    const outcome = p.test_outcomes?.[slot] ?? '';
                    const hex = outcome === 'abnormal' ? TIER_HEX.high : outcome === 'inconclusive' ? '#D97706' : outcome === 'normal' ? TIER_HEX.low : undefined;
                    return (
                      <span
                        key={slot}
                        className={`rounded-md px-2 py-0.5 text-[10px] font-semibold ${outcome ? '' : 'border border-dashed border-line dark:border-darkBorder text-muted dark:text-darkMuted'}`}
                        style={outcome ? { background: `${hex}18`, color: hex } : undefined}
                      >
                        {SLOT_LABELS[slot]}{outcome ? ` · ${outcome}` : ' · not ordered'}
                      </span>
                    );
                  })}
                </div>
                {Array.isArray(p.factors) && p.factors.length > 0 && (
                  <div className="mt-3 space-y-1 border-t border-line/60 dark:border-darkBorder/60 pt-3">
                    {p.factors.slice(0, 3).map((f) => (
                      <div key={f.feature} className="flex items-center justify-between gap-2 text-[10.5px]">
                        <span className="truncate text-muted dark:text-darkMuted">{f.text}</span>
                        <span style={MONO} className={`shrink-0 font-bold ${f.effect >= 0 ? 'text-tierHigh' : 'text-tierLow'}`}>
                          {f.effect >= 0 ? '+' : ''}{f.effect.toFixed(3)}
                        </span>
                      </div>
                  ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Tiebreak ladder + pair verdicts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-line dark:border-darkBorder bg-white/60 dark:bg-darkCard/60 p-5">
              <SectionLabel size="xs">Tiebreak Ladder</SectionLabel>
              <ol className="mt-3 space-y-2">
                {(compare.ladder ?? []).map((step, i) => (
                  <li key={i} className="flex gap-2.5 text-[12px] leading-relaxed text-ink dark:text-darkText">
                    <span style={MONO} className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-tint dark:bg-darkBorderSubtle text-[10px] font-bold text-accent">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
            <div className="rounded-2xl border border-line dark:border-darkBorder bg-white/60 dark:bg-darkCard/60 p-5">
              <SectionLabel size="xs">Why This Order</SectionLabel>
              <ul className="mt-3 space-y-2.5">
                {(compare.reasons ?? []).map((r, i) => {
                  const meta = VERDICT_META[r.verdict] ?? VERDICT_META.tie;
                  return (
                    <li key={i} className="rounded-xl border border-line/70 dark:border-darkBorder/70 bg-tint/40 dark:bg-darkBorderSubtle/40 px-3.5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.hex }} />
                        <span className="text-[10.5px] font-bold uppercase tracking-wider" style={{ color: meta.hex }}>{meta.label}</span>
                        <span style={MONO} className="ml-auto text-[10px] text-muted dark:text-darkMuted">
                          {r.winner} &gt; {r.runner_up}
                        </span>
                      </div>
                      <p className="mt-1 text-[11.5px] leading-relaxed text-ink dark:text-darkText">{r.why}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
