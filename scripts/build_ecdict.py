#!/usr/bin/env python3
"""Build a trimmed, offline ECDICT lookup database for the vocab app.

ECDICT (https://github.com/skywind3000/ECDICT) is an MIT-licensed English-Chinese
dictionary. The full CSV has ~770k entries; bundling all of it is wasteful, so this
script keeps only:

  * "common" words (anything with a Collins/Oxford star, a study tag such as
    cet4/cet6/gre/toefl/ielts, or a non-zero BNC/COCA frequency rank), and
  * every term that already exists in our own vocabulary (so existing PDF words
    always get a clean reference meaning, even if they are rare).

The Chinese translation is cleaned once here (network/encyclopedia noise removed,
sense lines joined) so both the runtime lookup and the one-off bake step read the
exact same `reference` text — a single source of truth for cleaning.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sqlite3
import sys
from pathlib import Path

csv.field_size_limit(10_000_000)

# Lines inside ECDICT translations that are reference noise rather than a real sense.
NOISE_LINE_RE = re.compile(r"^\s*\[(?:网络|网絡|计|医|化|经|生|律|地名?|人名)\]")
WHITESPACE_RE = re.compile(r"[ \t\u00a0]+")


def clean_translation(raw: str) -> str:
    """Turn an ECDICT translation blob into a single clean reference string."""
    if not raw:
        return ""
    lines: list[str] = []
    for line in raw.replace("\\n", "\n").split("\n"):
        line = WHITESPACE_RE.sub(" ", line).strip()
        if not line or NOISE_LINE_RE.match(line):
            continue
        lines.append(line)
    return "；".join(lines)


# ECDICT's CSV stores phonetics in a legacy notation (Cyrillic schwa, ASCII
# apostrophe for primary stress, "." / "," for secondary stress, ":" for length).
# Normalize to modern IPA so the app shows e.g. /ˌiːkwiˈlibriəm/ instead of
# /.i:kwi'libriәm/.
PHONETIC_MAP = {
    "\u04d9": "\u0259",  # Cyrillic schwa -> ə
    "'": "\u02c8",       # primary stress -> ˈ
    ".": "\u02cc",       # secondary stress -> ˌ
    ",": "\u02cc",       # secondary stress -> ˌ
    ":": "\u02d0",       # length -> ː
}


def clean_definition(raw: str) -> str:
    """Flatten ECDICT's multi-line English definition into one readable line."""
    if not raw:
        return ""
    parts = [
        WHITESPACE_RE.sub(" ", line).strip()
        for line in raw.replace("\\n", "\n").split("\n")
    ]
    return "; ".join(part for part in parts if part)


def clean_phonetic(raw: str) -> str:
    raw = (raw or "").strip().strip("/[] ")
    if not raw:
        return ""
    normalized = "".join(PHONETIC_MAP.get(ch, ch) for ch in raw)
    return f"/{normalized}/"


def lemma_from_exchange(exchange: str) -> str:
    """ECDICT encodes the base form as `0:<lemma>` in the exchange column."""
    if not exchange:
        return ""
    for part in exchange.split("/"):
        if part.startswith("0:"):
            return part[2:].strip()
    return ""


def is_common(row: dict) -> bool:
    def num(key: str) -> int:
        value = row.get(key) or ""
        try:
            return int(value)
        except ValueError:
            return 0

    if num("collins") > 0 or num("oxford") > 0:
        return True
    if (row.get("tag") or "").strip():
        return True
    if num("bnc") > 0 or num("frq") > 0:
        return True
    return False


def load_required_terms(vocab_path: Path | None) -> set[str]:
    required: set[str] = set()
    if vocab_path and vocab_path.exists():
        entries = json.loads(vocab_path.read_text(encoding="utf-8"))
        for entry in entries:
            term = str(entry.get("term", "")).strip().lower()
            if term:
                required.add(term)
    return required


def build(csv_path: Path, out_path: Path, vocab_path: Path | None) -> dict:
    required = load_required_terms(vocab_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()

    db = sqlite3.connect(str(out_path))
    db.execute(
        """
        CREATE TABLE ecdict (
          word TEXT PRIMARY KEY COLLATE NOCASE,
          phonetic TEXT NOT NULL DEFAULT '',
          reference TEXT NOT NULL DEFAULT '',
          definition TEXT NOT NULL DEFAULT '',
          pos TEXT NOT NULL DEFAULT '',
          exchange TEXT NOT NULL DEFAULT ''
        )
        """
    )

    kept = 0
    required_hit: set[str] = set()
    seen_total = 0
    batch: list[tuple] = []

    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        for row in reader:
            seen_total += 1
            word = (row.get("word") or "").strip()
            if not word:
                continue
            key = word.lower()
            is_required = key in required
            if not is_required and not is_common(row):
                continue
            reference = clean_translation(row.get("translation") or "")
            # A reference entry with no Chinese meaning is useless for our purposes,
            # unless it is a required term (then we keep it so lookups still resolve).
            if not reference and not is_required:
                continue
            if is_required:
                required_hit.add(key)
            batch.append(
                (
                    word,
                    clean_phonetic(row.get("phonetic") or ""),
                    reference,
                    clean_definition(row.get("definition") or ""),
                    (row.get("pos") or "").strip(),
                    (row.get("exchange") or "").strip(),
                )
            )
            kept += 1
            if len(batch) >= 5000:
                db.executemany(
                    "INSERT OR IGNORE INTO ecdict VALUES (?, ?, ?, ?, ?, ?)", batch
                )
                batch.clear()

    if batch:
        db.executemany("INSERT OR IGNORE INTO ecdict VALUES (?, ?, ?, ?, ?, ?)", batch)
    db.commit()
    db.execute("VACUUM")
    db.commit()
    db.close()

    return {
        "source": str(csv_path),
        "output": str(out_path),
        "scannedRows": seen_total,
        "keptRows": kept,
        "requiredTerms": len(required),
        "requiredMatched": len(required_hit),
        "requiredMissing": sorted(required - required_hit),
        "outputBytes": out_path.stat().st_size,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path, help="Path to ecdict.csv")
    parser.add_argument("output", type=Path, help="Destination sqlite file")
    parser.add_argument(
        "--vocab",
        type=Path,
        default=Path(__file__).resolve().parent.parent
        / "app"
        / "main"
        / "importedVocabulary.json",
        help="Vocabulary JSON whose terms must always be included",
    )
    args = parser.parse_args()

    if not args.csv.exists():
        print(f"error: {args.csv} not found", file=sys.stderr)
        raise SystemExit(1)

    report = build(args.csv, args.output, args.vocab)
    report_view = {**report, "outputMB": round(report["outputBytes"] / 1e6, 2)}
    print(json.dumps(report_view, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
