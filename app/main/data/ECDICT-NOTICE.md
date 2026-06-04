# ECDICT (bundled offline dictionary)

`ecdict.sqlite` in this folder is derived from **ECDICT** by skywind3000.

- Source: https://github.com/skywind3000/ECDICT
- License: MIT
- Upstream data file: `ecdict.csv`

## What we ship

The app does **not** bundle the full 770k-entry dictionary. `scripts/build_ecdict.py`
keeps only:

- common words (a Collins/Oxford star, a study tag such as cet4/cet6/gre/toefl/ielts,
  or a non-zero BNC/COCA frequency rank), and
- every term already present in our own `importedVocabulary.json`.

The Chinese `translation` is cleaned (encyclopedia/network noise removed, sense lines
joined) and the legacy phonetic notation is normalized to modern IPA. The result is a
single `reference` string per word, used both at runtime and when baking reference
meanings into `importedVocabulary.json`.

ECDICT provides the offline **Chinese reference meaning** and **phonetic** only. Your
own (PDF) meaning is never overwritten, and online dictionaries are used solely for
pronunciation audio and example sentences.

## Rebuilding

```bash
npm run build:dict
```

This downloads `ecdict.csv` into `.ecdict-src/` (cached, git-ignored), rebuilds
`ecdict.sqlite`, and re-bakes the reference data into `importedVocabulary.json`.
