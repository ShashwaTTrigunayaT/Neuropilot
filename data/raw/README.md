# Raw data

**This directory is intentionally empty in the repository — no datasets are committed.**

## OASIS-1 longitudinal (real data — optional)

The pipeline's real-data mode expects `oasis_longitudinal.csv` here:

- Columns: `Subject ID, MRI ID, Group, Visit, MR Delay, M/F, Hand, Age, EDUC, SES, MMSE, CDR, eTIV, nWBV, ASF`
- Classic release: 373 visit rows across 150 subjects.
- Source: OASIS project (https://sites.wustl.edu/oasisbrains/); public mirror
  copies also exist on Kaggle.

Get it either way:

```bash
python scripts/download_oasis.py    # fetches from a public mirror
# ...or manually place your own copy at data/raw/oasis_longitudinal.csv
```

## Synthetic cohorts (default demo data)

Generated locally, never committed:

```bash
python scripts/generate_adni_like_v2.py   # 800 subjects, ADNI-1 proportions → data/processed/synthetic_patients_v2.json
python scripts/generate_adni_like.py      # legacy 500-subject cohort      → data/processed/synthetic_patients.json
```

Then train:

```bash
pip install -r requirements-ml.txt
python scripts/train_model.py             # trains on the v2 synthetic cohort by default
# or: python scripts/run_pipeline.py      # download + ingest + train on real OASIS
```
