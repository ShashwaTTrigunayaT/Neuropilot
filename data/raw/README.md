# Raw data

**This directory is intentionally empty in the repository — no datasets are committed.**

## ADNI (the real cohort this system serves)

The pipeline reads the ADNI tables from the sibling directory **`ADNI DATA/`** at
the project root (both are gitignored). ADNI is access-controlled: request access
via the ADNI site (https://adni.loni.usc.edu/) and accept the Data Use Agreement.
No public mirror is used, and none of it is redistributable.

`scripts/ingest_adni.py` performs a nearest-visit join across the tables it needs
— cognition (MMSE, ADAS-Cog 13), plasma biomarkers (p-tau181/217, Aβ42/40, NfL,
GFAP), FreeSurfer MRI volumetrics and amyloid/tau PET — and writes:

```
data/processed/adni_visits.csv      one row per scored MMSE visit + nearest value
                                    of every other modality (±183 days)
data/processed/adni_features.csv    one row per subject = latest diagnosed visit,
                                    16-feature vector + real DIAGNOSIS label
data/processed/adni_progression.csv follow-up pairs for the progression model
data/processed/adni_cohort.json     the same subjects in the API's record shape
```

Check coverage before training:

```bash
python scripts/inspect_adni_coverage.py    # per-modality counts, read-only
```

Then ingest and train in one command:

```bash
python scripts/run_pipeline.py             # ingest_adni + train_model + progression model
```

## Nothing else

The OASIS-1 and synthetic cohorts were retired: the served cohort is the real
ADNI one. `backend/app/seed_data.py` still holds placeholder stubs, and they are a
last resort only — they carry no measurements, and they can never replace a real
patient record (`db.seed_if_empty` enforces that).

## Deployments

The cohort is not committed and not baked into the image. Seed the deployment
database once from a machine that holds the data:

```bash
DATABASE_URL='postgresql://...' python scripts/seed_db.py
```
