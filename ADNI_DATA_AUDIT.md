# ADNI Data Audit — Coverage & Alignment

**Drop:** `ADNI DATA/` (7 CSVs, 59 MB, freeze dated **17 Sep 2026**)
**Audited by:** `python scripts/inspect_adni_coverage.py` (read-only)
**Verdict:** ✅ **All four measure families are present**, with enough subjects to
retrain NeuroPilot on real data. This is materially better than the OASIS-1 base
the app currently ships on — OASIS has no blood, MRI, or PET results at all.

> ⚠️ **`ADNI DATA/` is now gitignored** (added to `.gitignore`). ADNI is
> access-controlled under a Data Use Agreement and is not redistributable —
> committing it would breach the DUA and publish restricted data.

---

## 1. What arrived

| File | Family | Rows | Subjects | Key measures |
|---|---|---|---|---|
| `MMSE_17Sep2026.csv` | **Cognition** | 14,920 | 4,668 | `MMSCORE` (14,763 scored, mean 26.9, range 0–30) |
| `UPENN_PLASMA_FUJIREBIO_QUANTERIX_17Sep2026.csv` | **Blood** | 2,422 | 1,595 | `pT217_F` (0.320), `AB42_F`, `AB40_F`, `AB42_AB40_F` (0.074), `NfL_Q` (15.1), `GFAP_Q` (138.5) |
| `UCSFFSX7_17Sep2026.csv` | **MRI** | 12,289 | 3,179 | FreeSurfer: `ST10CV` = ICV (1,521,444 mm³), `ST29SV`/`ST88SV` = L/R hippocampus (3,404 / 3,501 mm³), 347 columns total |
| `UCBERKELEY_AMY_6MM_17Sep2026.csv` | **PET · amyloid** | 4,728 | 2,240 | `CENTILOIDS`, `SUMMARY_SUVR`, `AMYLOID_STATUS` (0: 2,494 · 1: 2,144) |
| `UCBERKELEY_TAU_6MM_17Sep2026.csv` | **PET · tau** | 2,489 | 1,448 | `META_TEMPORAL_SUVR` |
| `DXSUM_17Sep2026.csv` | **Labels** | 16,458 | 3,765 | `DIAGNOSIS` 1=CN (6,649) / 2=MCI (6,658) / 3=Dementia (3,051) |
| `PTDEMOG_17Sep2026.csv` | **Demographics** | 6,209 | 4,922 | `PTGENDER`, `PTDOBYY`, `PTEDUCAT` |

PET tracers are mixed but harmonised upstream by Berkeley: amyloid = FBP 3,668 /
FBB 982 / NAV 78; tau = FTP 2,280 / MK6240 139 / PI2620 70.

## 2. Overlap — how many subjects have what

```
cognition only                            4,668
cognition + MRI                           3,179
cognition + amyloid PET                   2,240
cognition + blood                         1,595
cognition + tau PET                       1,448
cognition + blood + MRI                   1,552
cognition + blood + MRI + amyloid         1,420   ← the training core
ALL FOUR + diagnosis                      1,420
ALL FIVE incl. tau PET + dx + demog       1,255
```

Of the 1,420 four-modality subjects: **1,051 have ≥2 scored MMSE visits** (mean
**3.9** visits) → enough for the longitudinal / progression head.

## 3. Temporal alignment (the number that actually matters)

Files are not visit-matched by name (`bl` vs `sc` vs `4_init`), so we join on
date: nearest measurement of each modality within **±183 days** of a scored
MMSE visit.

| Modality | Subjects aligned | Aligned visits |
|---|---|---|
| blood | 1,555 | 2,409 |
| MRI | 3,169 | 10,750 |
| amyloid PET | 2,184 | 5,174 |
| tau PET | 1,365 | 2,348 |
| **all four to one MMSE visit** | **1,154** | — |

Their labelled visits split CN 3,880 / MCI 2,580 / Dementia 879, with a median of
**4** labelled visits per subject (max 21) — so real conversion labels exist, no
simulation required.

### 3.1 Per-feature completeness on aligned visits

Across all 14,746 scored MMSE visits in the drop:

| Feature | Source | Present | % |
|---|---|---|---|
| `mmse` | MMSCORE | 14,746 | 100.0% |
| `age` | PTDOBYY vs visit year | 14,681 | 99.6% |
| `sex` | PTGENDER | 14,682 | 99.6% |
| `education_years` | PTEDUCAT | 14,675 | 99.5% |
| `diagnosis` | DIAGNOSIS | 13,414 | 91.0% |
| `icv` | ST10CV | 10,744 | 72.9% |
| `hippocampus_left` / `_right` | ST29SV / ST88SV | 10,604 | 71.9% |
| `mmse_prior` | previous scored MMSE | 10,097 | 68.5% |
| `centiloids` | amyloid PET | 5,163 | 35.0% |
| `amyloid_status` | amyloid PET | 5,089 | 34.5% |
| `ptau217` `abeta42_ab40` `nfl` `gfap` | plasma panel | 2,409 | 16.3% |
| `tau_meta_temporal` | tau PET | 2,341 | 15.9% |

**The number to quote: 1,035 subjects / 1,238 visits carry the complete vector**
(cognition + age + sex + hippocampus + ICV + plasma panel + Centiloids + label)
**at a single aligned visit** — label mix CN 717 / MCI 384 / Dementia 137.
Of those, **899 subjects also have tau PET**. 418 of the 1,238 visits additionally
have a prior scored MMSE, so `mmse_change` is a real value there; on the rest it is
NaN because that visit *is* the subject's baseline — which is honest, and XGBoost
handles it natively.

## 4. Mapping to the served feature vector

| Model feature | Real ADNI source | Status |
|---|---|---|
| `mmse`, `mmse_change` | `MMSCORE` (delta across consecutive scored visits) | ✅ direct |
| `age` | `PTDOBYY` vs visit date | ✅ direct |
| `sex`, `education_years` | `PTGENDER`, `PTEDUCAT` | ✅ direct |
| `etiv` | `ST10CV` (ICV) | ✅ direct |
| hippocampal atrophy | `(ST29SV + ST88SV) / ST10CV` | ✅ **better** — an ICV-normalised fraction, not a raw volume |
| `abeta4240` | `AB42_AB40_F` | ✅ direct |
| `ptau181` | `pT217_F` | ⚠️ **different analyte** — p-tau217 is a stronger marker, but the model must be retrained, not re-labelled |
| amyloid PET | `CENTILOIDS` (continuous) | ✅ **better** — Centiloid is the harmonised standard vs a binary flag |
| tau PET | `META_TEMPORAL_SUVR` | ✅ direct |
| — | `NfL_Q`, `GFAP_Q` | ➕ two extra markers not currently used |
| label | `DIAGNOSIS` (1/2/3) | ✅ real, not synthetic |

## 5. Gaps and traps

1. **No data dictionary in the drop.** `UCSFFSX7` uses opaque `ST##` codes; I
   identified `ST10CV`/`ST29SV`/`ST88SV` by their magnitude distributions, but the
   remaining ~320 structures are unnameable without ADNI's FSX dictionary. Grab it
   before building the ingester.
2. **`MMDATE` is not a date** — it is a 0/1 flag (as are `MMYEAR`/`MMMONTH`/`MMDAY`).
   Use **`VISDATE`** (14,903 non-null) for all MMSE timing.
2b. **`PTDOBYY` is a date string, not a year** (`"1931-01-01"`). `to_numeric` on
   it silently yields all-NaN, which zeroed out `age` on the first pass of the
   audit. Parse it as a date and take `.dt.year`.
3. **`MMSCORE = -1` sentinel** for "not administered" (147 rows). Must filter
   `MMSCORE >= 0` or the model learns a fake cognitive score.
4. **`OVERALLQC` is empty for 11,135 of 12,289 MRI rows** — QC flags are largely
   unavailable, so MRI quality filtering must fall back to the `STATUS` column or
   plausibility ranges.
5. **Blood panel is p-tau217, not p-tau181** — the currently served pipeline was
   trained on `ptau181`. Requires a retrain with a new feature name/meaning.
6. **Missing entirely:** CSF biomarkers (no `UPENNBIOMK`/`CSF` file), **APOE
   genotype**, and any neuropsych battery beyond MMSE (no ADAS-Cog, CDR-SB, FAQ).
   APOE is the single cheapest accuracy win if you can pull it.
7. **Label alignment is not free.** All 1,420 have a `DIAGNOSIS` row somewhere, but
   not necessarily on the measure date — DXSUM needs the same nearest-visit join.
8. **Phase/visit-code heterogeneity.** ADNI1/GO/2/3/4 use different codes
   (`sc`, `bl`, `4_bl`, `4_init`, `v01`…). Deduplicate per `(RID, date)`, and be
   aware `TEAM` phase rows use `DIAGNOSIS = 10` (54 rows, unmapped).
9. **RID vs PTID.** Every file carries both; RID is the join key. Note `PTDEMOG`
   has 4,922 subjects — more than any measure file, so most have demographics only.

## 6. What this changes

The app currently serves a synthetic 800-subject cohort (`synthetic_patients_v2.json`)
plus real OASIS-1. With this drop you can serve a **real 1,420-subject cohort** —
genuine diagnosis labels, genuine conversion events, all four modalities — which
removes the "it's synthetic" caveat that was the biggest honest limitation in the
README and the judge Q&A.

**Estimated training cohort:** ~1,035 subjects with the full vector at baseline
(1,420 with all four modalities somewhere), real 1/2/3 labels, and genuine
longitudinal conversions — comfortably more than the 800 synthetic subjects the
app serves today, and with no fabrication anywhere.

**Suggested build order**
1. `scripts/ingest_adni.py` — the 7-file → unified record join (nearest-visit,
   ±183 d), emitting the same record shape as `synthetic_patients_v2.json`
2. Retrain risk + progression on the real cohort (10 features, p-tau217 renamed)
3. Swap the served artifact + document the new numbers
