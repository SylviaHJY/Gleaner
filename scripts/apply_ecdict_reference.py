#!/usr/bin/env python3
"""Bake offline ECDICT reference data into importedVocabulary.json.

For every imported term we look it up in the trimmed ECDICT database and attach a
clean Chinese reference meaning plus a phonetic. This is deliberately
non-destructive:

  * `userMeaning` (your PDF meaning) is never touched.
  * `referenceMeaning` / `referenceSource` are (re)written from ECDICT.
  * `phonetics` is only *filled* when the entry has none yet — we never clobber a
    phonetic that came from elsewhere.

Run `build_ecdict.py` first so the database exists and contains every term.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOCAB = ROOT / "app" / "main" / "importedVocabulary.json"
DEFAULT_DB = ROOT / "app" / "main" / "data" / "ecdict.sqlite"


def lookup(db: sqlite3.Connection, term: str) -> dict | None:
    row = db.execute(
        "SELECT phonetic, reference, definition, pos FROM ecdict WHERE word = ? COLLATE NOCASE",
        (term.strip(),),
    ).fetchone()
    if not row:
        return None
    phonetic, reference, definition, pos = row
    return {
        "phonetic": phonetic or "",
        "reference": reference or "",
        "definition": definition or "",
        "pos": pos or "",
    }


def apply_reference(vocab_path: Path, db_path: Path) -> dict:
    entries = json.loads(vocab_path.read_text(encoding="utf-8"))
    db = sqlite3.connect(str(db_path))

    matched = 0
    meaning_filled = 0
    phonetic_filled = 0

    for entry in entries:
        term = str(entry.get("term", "")).strip()
        hit = lookup(db, term) if term else None
        if not hit:
            entry.setdefault("referenceMeaning", "")
            entry.setdefault("referenceSource", "")
            continue

        matched += 1
        if hit["reference"]:
            entry["referenceMeaning"] = hit["reference"]
            entry["referenceSource"] = "ECDICT"
            meaning_filled += 1
        else:
            entry.setdefault("referenceMeaning", "")
            entry.setdefault("referenceSource", "")

        # English definitions and examples are the online dictionary's job, so we
        # intentionally do not populate `sourceMeaning` from ECDICT here.

        existing_phonetics = entry.get("phonetics") or []
        if hit["phonetic"] and not existing_phonetics:
            entry["phonetics"] = [
                {"region": "US", "text": hit["phonetic"], "audio": ""}
            ]
            phonetic_filled += 1

    db.close()

    vocab_path.write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    return {
        "totalEntries": len(entries),
        "ecdictMatched": matched,
        "referenceMeaningFilled": meaning_filled,
        "phoneticFilled": phonetic_filled,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vocab", type=Path, default=DEFAULT_VOCAB)
    parser.add_argument("--db", type=Path, default=DEFAULT_DB)
    args = parser.parse_args()

    report = apply_reference(args.vocab, args.db)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
