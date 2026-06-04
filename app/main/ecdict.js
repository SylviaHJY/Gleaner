import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function candidatePaths() {
  const local = path.join(__dirname, "data", "ecdict.sqlite");
  // When packaged into an asar archive the bundled DB is extracted next to it
  // (see `asarUnpack` in package.json); node:sqlite can only open real files.
  const unpacked = local.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return [...new Set([local, unpacked])];
}

let db = null;
let openAttempted = false;
let lookupStatement = null;

function getDb() {
  if (openAttempted) return db;
  openAttempted = true;
  if (!DatabaseSync) return null;

  for (const filePath of candidatePaths()) {
    if (!fs.existsSync(filePath)) continue;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      lookupStatement = db.prepare(
        "SELECT word, phonetic, reference, definition, pos, exchange FROM ecdict WHERE word = ? COLLATE NOCASE"
      );
      return db;
    } catch (error) {
      console.warn("ECDICT database unavailable:", error?.message ?? error);
      db = null;
      lookupStatement = null;
    }
  }
  return null;
}

function lemmaFromExchange(exchange) {
  if (!exchange) return "";
  for (const part of exchange.split("/")) {
    if (part.startsWith("0:")) return part.slice(2).trim();
  }
  return "";
}

// Light-weight fallbacks for inflected words that may not have their own row.
function stemCandidates(word) {
  const candidates = [];
  const lower = word.toLowerCase();
  const push = (value) => {
    if (value && value.length > 1 && !candidates.includes(value)) candidates.push(value);
  };

  if (lower.endsWith("ies")) push(`${lower.slice(0, -3)}y`);
  if (lower.endsWith("ied")) push(`${lower.slice(0, -3)}y`);
  if (lower.endsWith("es")) push(lower.slice(0, -2));
  if (lower.endsWith("s")) push(lower.slice(0, -1));
  if (lower.endsWith("ed")) {
    push(lower.slice(0, -2));
    push(lower.slice(0, -1));
  }
  if (lower.endsWith("ing")) {
    push(lower.slice(0, -3));
    push(`${lower.slice(0, -3)}e`);
  }
  // Derived forms (adverbs, nouns) that frequently lack their own phonetic in
  // ECDICT but share the base word's pronunciation.
  if (lower.endsWith("ily")) push(`${lower.slice(0, -3)}y`); // happily -> happy
  if (lower.endsWith("ally")) push(lower.slice(0, -4)); // basically -> basic
  if (lower.endsWith("ly")) push(lower.slice(0, -2)); // quickly -> quick, instantaneously -> instantaneous
  if (lower.endsWith("ness")) push(lower.slice(0, -4)); // kindness -> kind
  if (lower.endsWith("ment")) push(lower.slice(0, -4)); // movement -> move
  if (lower.endsWith("ion")) {
    push(lower.slice(0, -3)); // creation -> creat
    push(`${lower.slice(0, -3)}e`); // -> create
  }
  if (lower.endsWith("ity")) {
    push(lower.slice(0, -3));
    push(`${lower.slice(0, -3)}e`);
  }
  if (lower.endsWith("ization")) {
    push(`${lower.slice(0, -7)}ize`); // commercialization -> commercialize
    push(`${lower.slice(0, -7)}ise`);
    push(lower.slice(0, -7));
  }
  if (lower.endsWith("isation")) {
    push(`${lower.slice(0, -7)}ise`);
    push(`${lower.slice(0, -7)}ize`);
    push(lower.slice(0, -7));
  }
  if (lower.endsWith("ic")) push(lower.slice(0, -2)); // perfectionistic -> perfectionist
  return candidates;
}

// ECDICT frequently stores a phonetic only on the base word. When the matched
// row has a meaning but no phonetic, look through related base forms so the card
// is not left without one. Returns the phonetic text or "".
function borrowPhonetic(normalized, matchedRow) {
  const tried = new Set([normalized.toLowerCase()]);
  const candidates = [];
  const exLemma = lemmaFromExchange(matchedRow?.exchange);
  if (exLemma) candidates.push(exLemma);
  candidates.push(...stemCandidates(normalized));
  for (const candidate of candidates) {
    const key = candidate.toLowerCase();
    if (tried.has(key)) continue;
    tried.add(key);
    const row = query(candidate);
    if (row?.phonetic) return row.phonetic;
  }
  return "";
}

function rowToResult(row) {
  if (!row) return null;
  // A row with neither a Chinese meaning nor a phonetic is useless to us.
  if (!row.reference && !row.phonetic) return null;
  const phonetics = row.phonetic
    ? [{ region: "US", text: row.phonetic, audio: "" }]
    : [];
  return {
    word: row.word,
    referenceMeaning: row.reference || "",
    sourceMeaning: row.definition || "",
    partOfSpeech: row.pos || "",
    phonetics,
    source: "ECDICT"
  };
}

function query(word) {
  if (!lookupStatement || !word) return null;
  try {
    return lookupStatement.get(word) ?? null;
  } catch {
    return null;
  }
}

/**
 * Offline English -> Chinese reference lookup backed by the bundled ECDICT data.
 * Returns null when the database is missing or the word is not covered, so the
 * caller can fall back to other sources. Never throws.
 */
export function lookupEcdict(term) {
  const normalized = String(term ?? "").trim();
  if (!normalized || !getDb()) return null;

  let row = query(normalized);
  // An empty row (the word exists in ECDICT but carries neither a meaning nor a
  // phonetic, e.g. "commercialization") is as useless as a missing one, so fall
  // through to the morphological base forms in both cases.
  if (!row || (!row.reference && !row.phonetic)) {
    for (const candidate of stemCandidates(normalized)) {
      const candidateRow = query(candidate);
      if (candidateRow && (candidateRow.reference || candidateRow.phonetic)) {
        row = candidateRow;
        break;
      }
    }
  }
  if (!row) return null;

  // Prefer the lemma's entry when this row is an inflected form without a meaning.
  if (!row.reference) {
    const lemma = lemmaFromExchange(row.exchange);
    if (lemma && lemma.toLowerCase() !== normalized.toLowerCase()) {
      const lemmaRow = query(lemma);
      if (lemmaRow?.reference) row = lemmaRow;
    }
  }

  const result = rowToResult(row);
  if (!result) return null;

  if (!result.phonetics.length) {
    const borrowed = borrowPhonetic(normalized, row);
    if (borrowed) result.phonetics = [{ region: "US", text: borrowed, audio: "" }];
  }

  return result;
}

export function isEcdictAvailable() {
  return Boolean(getDb());
}
