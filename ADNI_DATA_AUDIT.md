# ADNI Data Audit — Coverage, Alignment & Gaps

**Drop:** `ADNI DATA/` (**13 CSVs**, ~119 MB, freeze dated **17 Sep 2026**)
**Audited by:** `python scripts/inspect_adni_coverage.py` (read-only)
**Verdict:** ✅ **Every gap flagged in the first audit is now closed except CSF** —
and the data dictionary arrived, which removes the one that actually blocked
ingestion.

> ⚠️ **`ADNI DATA/` is gitignored** (`.gitignore`). ADNI is access-controlled under
> a Data Use Agreement and is not redistributable — committing it would breach the
> DUA and publish restricted data.

---

## 1. What arrived (13 files)

### Core measure families

| File | Family | Rows | Subjects | Key measures |
|---|---|---|---|---|
| `MMSE_17Sep2026.csv` | **Cognition** | 14,920 | 4,668 | `MMSCORE` (14,763 scored, mean 26.9, range −1–30) |
| `UPENN_PLASMA_FUJIREBIO_QUANTERIX_…csv` | **Blood** | 2,422 | 1,595 | `pT217_F` (0.320), `AB42/AB40_F` (0.074), `NfL_Q` (15.1), `GFAP_Q` (138.5) — **0 nulls** |
| `UCSFFSX7_17Sep2026.csv` | **MRI** | 12,289 | 3,179 | FreeSurfer, 347 cols: `ST10CV`=ICV, `ST29SV`/`ST88SV`=L/R hippocampus |
| `UCBERKELEY_AMY_6MM_17Sep2026.csv` | **PET · amyloid** | 4,728 | 2,240 | `CENTILOIDS`, `SUMMARY_SUVR`, `AMYLOID_STATUS` (0: 2,494 · 1: 2,144) |
| `UCBERKELEY_TAU_6MM_17Sep2026.csv` | **PET · tau** | 2,489 | 1,448 | `META_TEMPORAL_SUVR` |
| `DXSUM_17Sep2026.csv` | **Labels** | 16,458 | 3,765 | `DIAGNOSIS` 1=CN (6,649) / 2=MCI (6,658) / 3=Dementia (3,051) |
| `PTDEMOG_17Sep2026.csv` | **Demographics** | 6,209 | 4,922 | `PTGENDER`, `PTDOBYY`, `PTEDUCAT` |

PET tracers are mixed but harmonised upstream by Berkeley: amyloid = FBP 3,668 /
FBB 982 / NAV 78; tau = FTP 2,280 / MK6240 139 / PI2620 70.

### 🆕 Added in this drop — the previously-missing pieces

| File | Family | Rows | Subjects | Key measures | Closes |
|---|---|---|---|---|---|
| `DATADIC_17Sep2026.csv` | **Data dictionary** | 79,315 | 349 tables | `TBLNAME`, `FLDNAME`, `TEXT`, `UNITS`, `TYPE` | **Gap #1** |
| `APOERES_17Sep2026.csv` | **Genotype** | 3,216 | 3,216 | `GENOTYPE` 3/3 1,516 · 3/4 1,082 · 4/4 295 · 2/3 237 · 2/4 76 · 2/2 10 → **e4 carriers 1,453 (45%)** | **Gap #6a** |
| `ADAS_17Sep2026.csv` | **Neuropsych** | 13,216 | 2,972 | `TOTAL13` = ADAS-Cog 13-item (12,896, mean 16.5); `TOTSCORE` (13,000, mean 10.7) | **Gap #6b** |
| `CDR_17Sep2026.csv` | **Neuropsych** | 15,020 | 4,365 | `CDGLOBAL` (14,900, mean 0.41), `CDRSB` (14,768, mean 1.94) | **Gap #6b** |
| `FAQ_17Sep2026.csv` | **Neuropsych** | 13,694 | 3,011 | `FAQTOTAL` (13,437, mean 5.02) | **Gap #6b** |
| `MRIQC_17Sep2026.csv` | **Acquisition QC** | 93,519 series | 3,209 | `MRIProtocolPhase` (ADNIGO/2 40,261 · ADNI3 27,146 · ADNI4 14,814 · ADNI1 11,298), `MagneticFieldStrength` (**3.0T 84,110** / 1.5T 9,409), `ScannerManufacturer`, `SeriesDescription` | **Gap #4** (partial — see below) |

`MRIQC` joins on **`ParticipantID` = `PTID`** (it has **no `RID` column**); all
3,209 subjects match `PTDEMOG`.

## 2. Overlap — how many subjects have what

```
cognition only                            4,668
cognition + CDR                           4,302
cognition + diagnosis                     3,706
cognition + MRI                           3,179
cognition + APOE                          3,169
cognition + FAQ                           2,966
cognition + ADAS                          2,972
cognition + amyloid PET                   2,240
cognition + blood                         1,595
cognition + tau PET                       1,448
cognition + blood + MRI                   1,552
cognition + blood + MRI + amyloid         1,420   ← the training core
ALL FOUR + diagnosis                      1,420
ALL FIVE incl. tau PET + dx + demog       1,255
+ APOE on the ALL FOUR cohort             1,361
+ full neuropsych on the ALL FOUR cohort  1,415
+ neuropsych + APOE                       1,356
```

Of the 1,420 four-modality subjects: **1,051 have ≥2 scored MMSE visits** (mean
**3.9** visits) → enough for the longitudinal / progression head.

## 3. Temporal alignment (the number that actually matters)

Files are not visit-matched by name (`bl` vs `sc` vs `4_init`), so we join on
date: nearest measurement of each modality within **±183 days** of a scored
MMSE visit. MMSE timing comes from **`VISDATE`** (`MMDATE` is a 0/1 flag).

| Modality | Subjects aligned | Aligned visits |
|---|---|---|
| MRI | 3,169 | 10,750 |
| CDR | 4,279 | 14,301 |
| ADAS-Cog | 2,943 | 13,005 |
| FAQ | 2,929 | 12,951 |
| amyloid PET | 2,184 | 5,174 |
| blood | 1,555 | 2,409 |
| tau PET | 1,365 | 2,348 |
| **all four core to one MMSE visit** | **1,154** | — |
| **core four + full neuropsych aligned** | **1,145** | — |

The core-four cohort keeps its neuropsych battery essentially intact — 1,145 of
1,154 subjects have ADAS-Cog + CDR + FAQ on the same aligned visit.

### 3.1 Per-feature completeness on aligned visits

Across all 14,746 scored MMSE visits in the drop:

| Feature | Source | Present | % |
|---|---|---|---|
| `mmse` | MMSCORE | 14,746 | 100.0% |
| `age` | PTDOBYY vs visit year | 14,681 | 99.6% |
| `sex` | PTGENDER | 14,682 | 99.6% |
| `education_years` | PTEDUCAT | 14,675 | 99.5% |
| `cdr_global` | CDR | 14,228 | 96.5% |
| `cdr_sb` | CDR | 14,112 | 95.7% |
| `diagnosis` | DIAGNOSIS | 13,414 | 91.0% |
| `apoe_genotype` | APOERES | 13,248 | 89.8% |
| `adas_cog_total` | ADAS `TOTAL13` | 12,901 | 87.5% |
| `faq_total` | FAQ | 12,786 | 86.7% |
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

**New candidates, with one hard warning:**

| Candidate | Source | Verdict |
|---|---|---|
| `apoe_e4` (carrier flag) | `GENOTYPE` contains `4` | ✅ **Add it.** Strongest genetic risk factor, 89.8% coverage, one binary feature |
| `faq_total` | `FAQTOTAL` (0–30) | ✅ **Add it.** Functional independence — the piece MMSE cannot see |
| `adas_cog_13` | `TOTAL13` (0–85) | ✅ Add it if you want a second cognitive axis; strongly correlated with MMSE |
| `scanner_vendor`, `field_strength` | `MRIQC` | ⚠️ **Confound, not a feature** — use for ComBat harmonisation, never as a predictor |
| `cdr_global`, `cdr_sb` | `CDRGLOBAL`, `CDRSB` | ❌ **Do NOT add as features.** CDR *is* the clinical staging that `DIAGNOSIS` derives from — this reintroduces the exact label leakage the app already excludes (see `guardrails` in `artifacts/eval_report.txt`) |

CDR is still valuable as a **concordance reference** — it lets you check whether the
model's tier agrees with a clinician's global staging without training on it.

## 4b. Synthetic vs real — features that did not exist before this drop

Diffed against `scripts/generate_adni_like_v2.py` (what the synthetic cohort
carries) and the served 10-feature vector (`artifacts/model_meta.json`).

**Genuinely new features (no synthetic counterpart) — addable now:**

| New feature | Source column | Coverage on aligned visits | Why it matters |
|---|---|---|---|
| `apoe_e4` | `APOERES.GENOTYPE` → carrier flag | 13,248 (89.8%) | Strongest known AD genetic risk factor; synthetic had only a crude `family_history` boolean |
| `nfl` | `NfL_Q` (pg/mL) | 2,409 (16.3%) | Neurodegeneration blood marker — an *active* axonal-injury axis; synthetic blood had no neurodegeneration measure |
| `gfap` | `GFAP_Q` (pg/mL) | 2,409 (16.3%) | Astrocyte activation — reactive-gliosis axis, independent of amyloid/tau |
| `faq_total` | `FAQTOTAL` (0–30) | 12,786 (86.7%) | Functional independence — the dimension MMSE cannot see; synthetic had nothing functional |
| `adas_cog_13` | `ADAS.TOTAL13` (0–85) | 12,901 (87.5%) | Second cognitive scale with more dynamic range than MMSE (ceiling-free in early decline) |

**Strict upgrades of existing features (same slot, richer quantity):**

| Served synthetic feature | Real replacement | Why richer |
|---|---|---|
| `hippocampal_volume` (single cm³) | `ST29SV` + `ST88SV` + `ST10CV` → ICV-normalised bilateral ratio | Asymmetry becomes visible; head-size confound removed |
| `amyloid_positive` (binary) | `CENTILOIDS` (continuous) | Degree of amyloid burden, not just a threshold call |
| `tau_positive` (binary) | `META_TEMPORAL_SUVR` (continuous) | Same — graded tau load |
| `ptau181` | `pT217_F` (pg/mL) | Different analyte; p-tau217 has superior AD accuracy in head-to-head literature |
| `mmse_change` (one fabricated 6-mo delta) | real deltas across mean 3.9 scored visits (max 21) | Genuine individual decline slopes instead of a draw from a Gaussian |

**Structural gains (not features, but new capability):**

- **326 named FreeSurfer ROIs** (dictionary-verified) — entorhinal, parahippocampal,
  temporal cortical volumes/thickness are one column away if wanted.
- **Real longitudinal labels** — synthetic labels descend from the generator's own
  latent severity (circular); ADNI's CN/MCI/Dementia with genuine conversion events
  break that circularity.
- **Acquisition metadata** (`MRIQC`: vendor, 3T/1.5T, protocol phase) — lets the real
  cohort carry the scanner heterogeneity the synthetic cohort conveniently lacked,
  and harmonise for it (ComBat) rather than pretend it does not exist.
- **Raw `AB42_F` / `AB40_F`** alongside the ratio — synthetic stores the ratio only.

**Synthetic-only fields that do NOT survive the switch** (they were fabricated):
`ses`, `family_history`, `comorbidities` (Hypertension / Type 2 Diabetes /
Hyperlipidemia / Atrial Fibrillation). Note `HUMAN_FEATURES` in `storage.py` still
references two of these from the legacy mock — clean them up when the real cohort
lands. CDR must also stay out of the vector (leakage, §4).

## 5. Gaps and traps

### ✅ Closed by this drop

1. ~~**No data dictionary.**~~ **Resolved, and better than expected.**
   `DATADIC` carries 79,315 definitions across 349 tables; `UCSFFSX7` has 345
   entries covering **all 326 `ST##` structural columns (100%)** — only the two
   bookkeeping columns `VISCODE2` and `update_stamp` are undocumented. Verified with
   `ST10CV` → *"Volume (Cortical Parcellation) of Icv"*, `ST29SV` →
   *"Volume (WM Parcellation) of LeftHippocampus"*. **The ingester can be written
   from the dictionary, no guessing.**

   Every table the ingester reads is described (`DXSUM`, `MMSE`, `PTDEMOG`,
   `UCSFFSX7`, `UCBERKELEY_AMY_6MM`, `UCBERKELEY_TAU_6MM`,
   `UPENN_PLASMA_FUJIREBIO_QUANTERIX`, `ADAS`, `CDR`, `FAQ`, `APOERES`, `MRIQC` —
   all present), including **units**, which the app displays:

   | Field | Dictionary text | Units |
   |---|---|---|
   | `pT217_F` | pTau217 measured by Fujirebio | **pg/mL** |
   | `NfL_Q` | Neurofilament light chain (Quanterix) | **pg/mL** |
   | `GFAP_Q` | Glial fibrillary acidic protein (Quanterix) | **pg/mL** |
   | `AB42_AB40_F` | ABeta42/40 ratio (Fujirebio) | unitless |
   | `CENTILOIDS` | cortical SUVR → Centiloid scale | **CL** |
   | `SUMMARY_SUVR` / `META_TEMPORAL_SUVR` | cortical / temporal meta-ROI SUVR | SUVR |
   | `ST10CV` / `ST29SV` / `ST88SV` | ICV / L / R hippocampus volume | **mm³** |
   | `MagneticFieldStrength` | scanner field strength | Tesla |

   Two definitions worth locking in before ingesting:
   - **`ADAS.TOTSCORE`** = *"Classic 70 point total. Excludes Q4 (Delayed Word
     Recall) and Q14 (Number Cancellation)"* — so **`TOTAL13` (85-point, Q4+Q14
     included) is the modern ADAS-Cog 13** and is the one to model on.
   - **`MMSE.VISDATE`** = *"Assessment EXAMDATE when present; otherwise Registry
     EXAMDATE"* — the authoritative visit date, and **`MMDATE` is confirmed to be a
     question item** (*"1. What is today's date?"*), not a date, exactly as the
     trap below warns.
2. ~~**No APOE genotype.**~~ **Resolved** — 3,216 subjects, all six genotypes
   present, 45% e4 carriers (consistent with ADNI's known ~47%).
3. ~~**No neuropsych battery beyond MMSE.**~~ **Resolved** — ADAS-Cog, CDR-SB and FAQ
   all present with 86–97% coverage on aligned visits.
4. ~~**`OVERALLQC` empty for 11,135 of 12,289 MRI rows.**~~ **Explained and now
   workable.** The dictionary documents `STATUS`: *"partial = No QC, not final.
   Complete = QC and finalized."* The split is exact —
   `complete` 1,154 rows (all with `OVERALLQC`: Pass 525 · Partial 612 ·
   Hippocampus Only 10 · Fail 7) and `partial` 11,135 rows (`OVERALLQC` blank).
   So QC filtering **is** available, just on the 1,154 finalized rows; use `STATUS`
   as the gate on the rest.

### ❌ Still missing

5. **No CSF biomarkers** — no `UPENNBIOMK` / CSF file in the drop. Would complement
   plasma p-tau217 but is not required for the current feature vector.
6. **`MRIQC` is not a quality-metric table.** It is an *acquisition inventory*
   (scanner, coil, field strength, series description) — there are **no SNR/CNR/Euler
   scores**. It fixes harmonisation, not QC scoring. Real image-quality numbers would
   need ADNI's MRI QC analysis tables or re-running MRIQC on the DICOMs.

### ⚠️ Traps that will silently corrupt an ingestion run

7. **`MMDATE` is not a date** — it is a 0/1 flag (as are `MMYEAR`/`MMMONTH`/`MMDAY`).
   Use **`VISDATE`** for all MMSE timing.
8. **`PTDOBYY` is a date string, not a year** (`"1931-01-01"`). `pd.to_numeric` on it
   silently yields all-NaN — which zeroed out `age` on the first pass of this audit.
   Parse as a date and take `.dt.year`.
9. **`MMSCORE = -1` sentinel** for "not administered" (147 rows). Must filter
   `MMSCORE >= 0` or the model learns a fake cognitive score.
10. **Blood panel is p-tau217, not p-tau181** — the served pipeline was trained on
    `ptau181`. This is a retrain with a new feature name/meaning, not a rename.
    Also note the real units are **pg/mL** for pTau217/NfL/GFAP and unitless for the
    Aβ42/40 ratio; the app's synthetic blood values carried no such units.
10b. **`ADAS.TOTSCORE` is not the ADAS-Cog 13.** It is the classic 70-point total
    that *excludes* Q4 and Q14; `TOTAL13` (85-point) is the full 13-item scale.
    Modelling on the wrong one silently changes the cognitive axis.
11. **Label alignment is not free.** All 1,420 have a `DIAGNOSIS` row somewhere, but
    not necessarily on the measure date — DXSUM needs the same nearest-visit join.
12. **Phase/visit-code heterogeneity.** ADNI1/GO/2/3/4 use different codes
    (`sc`, `bl`, `4_bl`, `4_init`, `v01`…). Deduplicate per `(RID, date)`; `TEAM`
    phase rows use `DIAGNOSIS = 10` (54 rows, unmapped).
13. **`APOERES.GENOTYPE` is a string** (`"3/4"`), and `APTESTDT`/`APVOLUME` are
    entirely empty in this file — only `GENOTYPE` and `APUSABLE` carry data. Do not
    build a numeric cast; derive the e4 flag from the string.
14. **`MRIQC` and `DATADIC` lack `RID`.** They join on `PTID` (MRIQC) or not at all
    (DATADIC, keyed by `TBLNAME`+`FLDNAME`).
15. **RID vs PTID.** Every measure file carries both; RID is the join key. `PTDEMOG`
    has 4,922 subjects — more than any measure file, so most have demographics only.

## 6. What this changes

The app currently serves a synthetic 800-subject cohort
(`synthetic_patients_v2.json`) plus real OASIS-1. With this drop you can serve a
**real 1,420-subject cohort** — genuine ADNI diagnosis labels, genuine conversion
events, all four modalities, **plus APOE and a full neuropsych battery** — which
removes the "it's synthetic" caveat that was the biggest honest limitation in the
README and the judge Q&A.

Two capabilities that did not exist before this drop:

- **Genetic risk in the model** (`apoe_e4`) — the standard AD risk allele, now a real
  feature with 89.8% coverage instead of a stated limitation.
- **A validated data contract** — the dictionary means the ingester's column mapping
  is *documented*, not reverse-engineered from magnitude distributions.

**Estimated training cohort:** ~1,035 subjects with the full vector at baseline
(1,420 with all four modalities somewhere), ~1,356 with genotype + neuropsych on top,
real 1/2/3 labels, and genuine longitudinal conversions.

**Suggested build order**
1. `scripts/ingest_adni.py` — the 13-file → unified record join (nearest-visit,
   ±183 d), dictionary-driven column mapping, `ptau181` → `ptau217`, adding
   `apoe_e4` + `faq_total` (+ `adas_cog_13`), CDR held out as a concordance check only
2. Retrain risk + progression on the real cohort (12 features), then swap the served
   artifact and document the new metrics
3. Re-run `python scripts/inspect_adni_coverage.py` to confirm the ingest matches
   these audited counts
