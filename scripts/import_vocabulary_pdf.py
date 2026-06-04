#!/usr/bin/env python3
"""Extract a deduplicated personal vocabulary dataset from Vocabulary.pdf."""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from pathlib import Path

from pypdf import PdfReader


CJK_RE = re.compile(r"[\u3400-\u9fff]")
ENTRY_START_RE = re.compile(r"^[A-Za-z][A-Za-z0-9'’\-]*(?:\s+[A-Za-z][A-Za-z0-9'’\-]*)*")
POS_MARKER_RE = re.compile(
    r"\s+(?:-\s*)?(?:n|v|adj|adv|vt|vi|prep|conj|pron|num|det|dj)\s*[.．]",
    re.IGNORECASE,
)
IPA_START_RE = re.compile(r"\s+(?:/|ˈ|ˌ)")
REGION_MARKER_RE = re.compile(r"\s+(?:美|英)\s*(?:/|ˈ|ˌ)")
LEADING_POS_RE = re.compile(
    r"^\s*(?:-\s*)?(?:n|v|adj|adv|vt|vi|prep|conj|pron|num|det|dj)\s*[.．]\s*",
    re.IGNORECASE,
)
CONTINUATION_PREFIXES = {
    "n.",
    "v.",
    "adj.",
    "adv.",
    "vt.",
    "vi.",
    "dj.",
}
CONTINUATION_LINE_RE = re.compile(
    r"^(?:n|v|adj|adv|vt|vi|prep|conj|pron|num|det|dj)\s*[.．<]",
    re.IGNORECASE,
)


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFKC", value)
    value = value.replace("\u00a0", " ")
    return re.sub(r"\s+", " ", value).strip()


def is_sentence_like(line: str) -> bool:
    if CJK_RE.search(line):
        return False
    words = re.findall(r"[A-Za-z]+", line)
    return len(words) >= 4 and line.rstrip().endswith((".", "!", "?"))


def is_entry_start(line: str) -> bool:
    if not line or line == "Vocabulary" or not ENTRY_START_RE.match(line):
        return False
    first_token = line.split(maxsplit=1)[0].lower()
    if first_token in CONTINUATION_PREFIXES:
        return False
    if CONTINUATION_LINE_RE.match(line):
        return False
    if is_sentence_like(line):
        return False
    return True


def earliest_marker_index(line: str) -> int:
    candidates: list[int] = []
    for regex in (REGION_MARKER_RE, IPA_START_RE, POS_MARKER_RE):
        match = regex.search(line)
        if match:
            candidates.append(match.start())
    cjk = CJK_RE.search(line)
    if cjk:
        candidates.append(cjk.start())
    return min(candidates) if candidates else len(line)


def extract_term(line: str) -> str:
    term = line[: earliest_marker_index(line)]
    term = re.sub(r"\s+-\s*$", "", term)
    term = re.sub(r"\s*-\s*\d+\s*[.．]\s*\($", "", term)
    term = re.sub(r"\s*\($", "", term)
    term = term.strip(" -–—,.;:：；")
    return normalize_text(term)


def strip_imported_meaning(term: str, raw_text: str) -> str:
    remainder = raw_text[len(term) :].strip() if raw_text.lower().startswith(term.lower()) else raw_text
    remainder = re.sub(r"^(?:美|英)\s*", "", remainder)
    remainder = re.sub(r"^/[^/]+/\s*", "", remainder)
    remainder = re.sub(r"^[ˈˌ][^\s]+\s*", "", remainder)
    remainder = LEADING_POS_RE.sub("", remainder)
    remainder = remainder.lstrip(" -–—")

    cjk = CJK_RE.search(remainder)
    if cjk:
        remainder = remainder[cjk.start() :]
    return normalize_text(remainder)


def suspicious_reasons(term: str, raw_text: str) -> list[str]:
    reasons: list[str] = []
    words = term.split()
    if len(words) > 6:
        reasons.append("long-headword")
    if len(term) > 70:
        reasons.append("long-headword")
    if not CJK_RE.search(raw_text):
        reasons.append("missing-chinese-meaning")
    if any(token in term.lower().split() for token in ("and", "or")):
        reasons.append("compound-headword")
    if term.lower() in CONTINUATION_PREFIXES:
        reasons.append("part-of-speech-line")
    return sorted(set(reasons))


def slugify(term: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", term.lower()).strip("-")
    return slug or f"imported-{abs(hash(term))}"


def parse_entries(pdf_path: Path) -> tuple[list[dict], dict]:
    reader = PdfReader(str(pdf_path))
    raw_entries: list[dict] = []
    current: dict | None = None

    for page_number, page in enumerate(reader.pages, start=1):
        for raw_line in (page.extract_text() or "").splitlines():
            line = normalize_text(raw_line)
            if not line or line == "Vocabulary":
                continue

            if is_entry_start(line):
                term = extract_term(line)
                if term:
                    if current:
                        raw_entries.append(current)
                    current = {
                        "term": term,
                        "lines": [line],
                        "pages": [page_number],
                    }
                    continue

            if current:
                current["lines"].append(line)
                if page_number not in current["pages"]:
                    current["pages"].append(page_number)

    if current:
        raw_entries.append(current)

    deduped: dict[str, dict] = {}
    duplicates: dict[str, int] = {}
    for raw_entry in raw_entries:
        term = raw_entry["term"]
        key = normalize_text(term).lower()
        raw_text = normalize_text(" ".join(raw_entry["lines"]))
        meaning = strip_imported_meaning(term, raw_text)
        reasons = suspicious_reasons(term, raw_text)
        entry = {
            "id": slugify(term),
            "term": term,
            "type": "phrase" if " " in term else "word",
            "userMeaning": meaning,
            "sourceMeaning": "",
            "partOfSpeech": "",
            "phonetics": [],
            "forms": [],
            "tags": ["Vocabulary.pdf"],
            "notes": f"Imported from Vocabulary.pdf pages {', '.join(map(str, raw_entry['pages']))}.",
            "sourceRaw": raw_text,
            "status": "needs-review" if reasons else "pending",
            "importWarnings": reasons,
        }

        if key not in deduped:
            deduped[key] = entry
            continue

        duplicates[key] = duplicates.get(key, 1) + 1
        existing = deduped[key]
        if meaning and meaning not in existing["userMeaning"]:
            existing["userMeaning"] = normalize_text(f"{existing['userMeaning']}；{meaning}")
        if raw_text not in existing["sourceRaw"]:
            existing["sourceRaw"] = normalize_text(f"{existing['sourceRaw']} || {raw_text}")
        existing["importWarnings"] = sorted(set(existing["importWarnings"] + reasons + ["duplicate-merged"]))
        if CJK_RE.search(existing["userMeaning"]):
            existing["importWarnings"] = [
                warning for warning in existing["importWarnings"] if warning != "missing-chinese-meaning"
            ]
        existing["status"] = "needs-review"

    entries = sorted(deduped.values(), key=lambda item: item["term"].lower())
    report = {
        "pages": len(reader.pages),
        "rawEntries": len(raw_entries),
        "deduplicatedEntries": len(entries),
        "duplicateTerms": duplicates,
        "needsReview": sum(1 for entry in entries if entry["status"] == "needs-review"),
        "missingMeaning": [
            entry["term"] for entry in entries if "missing-chinese-meaning" in entry["importWarnings"]
        ],
    }
    return entries, report


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("pdf", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--report", type=Path)
    args = parser.parse_args()

    entries, report = parse_entries(args.pdf)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
