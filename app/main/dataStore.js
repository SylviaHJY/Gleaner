import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { seedEntries } from "./seedEntries.js";
import { lookupEcdict } from "./ecdict.js";
import {
  buildSchedulingPool,
  isDue as schedulingIsDue,
  newlyQueuedEntryIds,
  nextScheduling,
  planTodaySession,
  schedulingIndexFields,
  scoreEntry as schedulingScoreEntry,
  todayKey
} from "./scheduling.js";

const LIBRARY_PAGE_SIZE = 50;
const CHOICE_DISTRACTOR_LIMIT = 100;

let DatabaseSync = null;
try {
  const sqlite = await import("node:sqlite");
  DatabaseSync = sqlite.DatabaseSync;
} catch {
  DatabaseSync = null;
}

const DEFAULT_SETTINGS = {
  dailyGoal: 5,
  activeStart: "09:30",
  activeEnd: "22:30",
  pauseInFullscreen: true,
  avoidYesterday: true,
  mixModes: true,
  autostart: true,
  reminderEnabled: true,
  reminderMinutes: 30,
  merriamWebsterKey: "",
  dictionaryProvider: "free-dictionary"
};

function nowIso() {
  return new Date().toISOString();
}

function normalizeTerm(term) {
  return String(term ?? "").trim().replace(/\s+/g, " ");
}

function slugify(term) {
  return normalizeTerm(term).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || randomUUID();
}

// Turn a single free-form input box into one example object. The user writes the
// English sentence and its Chinese meaning together; we split on the first line
// break (or a " / " / "｜" separator) so the card can show them on two lines.
function makeUserExample(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\r?\n|\s*[|｜]\s*|\s+\/\s+/);
  const en = (parts.shift() ?? "").trim();
  const zh = parts.join(" ").trim();
  if (!en) return null;
  return { en, zh, favorite: false, needsTranslation: false, userAdded: true };
}

function normalizeExamples(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((example) => {
      if (!example || typeof example !== "object") return null;
      const en = String(example.en ?? "").trim();
      const zh = String(example.zh ?? "").trim();
      if (!en && !zh) return null;
      return {
        en,
        zh,
        favorite: Boolean(example.favorite),
        needsTranslation: Boolean(example.needsTranslation),
        userAdded: Boolean(example.userAdded)
      };
    })
    .filter(Boolean);
}

function withEntryDefaults(entry) {
  const timestamp = nowIso();
  return {
    id: entry.id || slugify(entry.term),
    term: normalizeTerm(entry.term),
    type: entry.type || (/\s/.test(entry.term ?? "") ? "phrase" : "word"),
    userMeaning: entry.userMeaning || "",
    referenceMeaning: entry.referenceMeaning || "",
    referenceSource: entry.referenceSource || "",
    sourceMeaning: entry.sourceMeaning || "",
    partOfSpeech: entry.partOfSpeech || "",
    phonetics: Array.isArray(entry.phonetics) ? entry.phonetics : [],
    examples: Array.isArray(entry.examples) ? entry.examples : [],
    forms: Array.isArray(entry.forms) ? entry.forms : [],
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    notes: entry.notes || "",
    sourceRaw: entry.sourceRaw || "",
    importWarnings: Array.isArray(entry.importWarnings) ? entry.importWarnings : [],
    status: entry.status || "pending",
    dictionarySource: entry.dictionarySource || "",
    dictionaryNote: entry.dictionaryNote || "",
    dictionaryLookupAttemptedAt: entry.dictionaryLookupAttemptedAt || "",
    createdAt: entry.createdAt || timestamp,
    updatedAt: entry.updatedAt || timestamp,
    lastSeenAt: entry.lastSeenAt || "",
    lastQueuedAt: entry.lastQueuedAt || "",
    queuedCount: entry.queuedCount || 0,
    nextReviewAt: entry.nextReviewAt || "",
    intervalDays: Number.isFinite(Number(entry.intervalDays)) ? Number(entry.intervalDays) : 0,
    ease: Number.isFinite(Number(entry.ease)) ? Number(entry.ease) : 2.3,
    seenCount: entry.seenCount || 0,
    correctCount: entry.correctCount || 0,
    wrongCount: entry.wrongCount || 0,
    forgottenCount: entry.forgottenCount || 0
  };
}

function safeJsonParse(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function validateSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const dailyGoal = Number(merged.dailyGoal);
  merged.dailyGoal = Number.isFinite(dailyGoal) ? Math.min(50, Math.max(1, Math.round(dailyGoal))) : 5;
  const reminderMinutes = Number(merged.reminderMinutes);
  merged.reminderMinutes = Number.isFinite(reminderMinutes) ? Math.min(240, Math.max(1, Math.round(reminderMinutes))) : 30;
  merged.reminderEnabled = Boolean(merged.reminderEnabled);
  return merged;
}

function parseEntryPayload(payload) {
  return withEntryDefaults(safeJsonParse(payload, {}));
}

function notInSql(ids) {
  if (!ids?.length) return { clause: "", params: [] };
  return { clause: `AND id NOT IN (${ids.map(() => "?").join(", ")})`, params: ids };
}

class SqliteAdapter {
  constructor(filePath) {
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        term TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        date TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      );
    `);
    this.#migrateSchedulingColumns();
  }

  #migrateSchedulingColumns() {
    const columns = new Set(this.db.prepare("PRAGMA table_info(entries)").all().map((row) => row.name));
    if (!columns.has("seen_count")) {
      this.db.exec(`
        ALTER TABLE entries ADD COLUMN seen_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE entries ADD COLUMN next_review_date TEXT NOT NULL DEFAULT '';
        ALTER TABLE entries ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';
      `);
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entries_status_seen ON entries(status, seen_count);
      CREATE INDEX IF NOT EXISTS idx_entries_next_review ON entries(next_review_date);
      CREATE INDEX IF NOT EXISTS idx_entries_term ON entries(term COLLATE NOCASE);
    `);

    if (this.getMeta("schedulingColumnsVersion") === "1") return;

    const rows = this.db.prepare("SELECT id, payload FROM entries").all();
    const update = this.db.prepare(
      "UPDATE entries SET seen_count = ?, next_review_date = ?, status = ? WHERE id = ?"
    );
    for (const row of rows) {
      const entry = parseEntryPayload(row.payload);
      const index = schedulingIndexFields(entry);
      update.run(index.seenCount, index.nextReviewDate, index.status, row.id);
    }
    this.setMeta("schedulingColumnsVersion", "1");
  }

  #parseRows(rows) {
    return rows.map((row) => parseEntryPayload(row.payload)).filter((entry) => entry.term);
  }

  getSettings() {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get("settings");
    return validateSettings(safeJsonParse(row?.value, DEFAULT_SETTINGS));
  }

  saveSettings(settings) {
    const payload = JSON.stringify(validateSettings(settings));
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run("settings", payload);
  }

  getMeta(key) {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  setMeta(key, value) {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, String(value));
  }

  getEntries() {
    return this.#parseRows(this.db.prepare("SELECT payload FROM entries ORDER BY term COLLATE NOCASE").all());
  }

  getEntryById(id) {
    const row = this.db.prepare("SELECT payload FROM entries WHERE id = ?").get(id);
    return row ? parseEntryPayload(row.payload) : null;
  }

  findEntryByTerm(term) {
    const row = this.db.prepare("SELECT payload FROM entries WHERE term = ?").get(normalizeTerm(term).toLowerCase());
    return row ? parseEntryPayload(row.payload) : null;
  }

  getEntriesByIds(ids) {
    if (!ids?.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return this.#parseRows(
      this.db.prepare(`SELECT payload FROM entries WHERE id IN (${placeholders})`).all(...ids)
    );
  }

  getEntryStats() {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready,
          SUM(CASE WHEN status IN ('pending', 'needs-review') THEN 1 ELSE 0 END) AS needsReview
        FROM entries`
      )
      .get();
    return {
      total: Number(row?.total ?? 0),
      ready: Number(row?.ready ?? 0),
      needsReview: Number(row?.needsReview ?? 0)
    };
  }

  getSchedulingPool(today, excludeIds = []) {
    const { clause, params } = notInSql(excludeIds);
    const unseen = this.#parseRows(
      this.db
        .prepare(
          `SELECT payload FROM entries
           WHERE status != 'archived' ${clause} AND seen_count = 0
           ORDER BY seen_count ASC, term COLLATE NOCASE
           LIMIT 500`
        )
        .all(...params)
    );
    const due = this.#parseRows(
      this.db
        .prepare(
          `SELECT payload FROM entries
           WHERE status != 'archived' ${clause}
             AND seen_count > 0
             AND (next_review_date = '' OR next_review_date <= ?)
           ORDER BY next_review_date ASC, term COLLATE NOCASE
           LIMIT 400`
        )
        .all(...params, today)
    );
    const future = this.#parseRows(
      this.db
        .prepare(
          `SELECT payload FROM entries
           WHERE status != 'archived' ${clause}
             AND seen_count > 0
             AND next_review_date > ?
           ORDER BY next_review_date ASC, term COLLATE NOCASE
           LIMIT 200`
        )
        .all(...params, today)
    );
    const byId = new Map();
    for (const entry of [...unseen, ...due, ...future]) byId.set(entry.id, entry);
    return [...byId.values()];
  }

  listEntries({ query = "", offset = 0, limit = LIBRARY_PAGE_SIZE } = {}) {
    const normalized = String(query ?? "").trim().toLowerCase();
    let rows;
    let total;
    if (normalized) {
      const pattern = `%${normalized}%`;
      total = Number(
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM entries
             WHERE lower(term) LIKE ? OR lower(payload) LIKE ?`
          )
          .get(pattern, pattern)?.count ?? 0
      );
      rows = this.db
        .prepare(
          `SELECT payload FROM entries
           WHERE lower(term) LIKE ? OR lower(payload) LIKE ?
           ORDER BY term COLLATE NOCASE
           LIMIT ? OFFSET ?`
        )
        .all(pattern, pattern, limit, offset);
    } else {
      total = Number(this.db.prepare("SELECT COUNT(*) AS count FROM entries").get()?.count ?? 0);
      rows = this.db
        .prepare("SELECT payload FROM entries ORDER BY term COLLATE NOCASE LIMIT ? OFFSET ?")
        .all(limit, offset);
    }
    return { entries: this.#parseRows(rows), total };
  }

  getRandomEntries(limit = CHOICE_DISTRACTOR_LIMIT, excludeIds = []) {
    const { clause, params } = notInSql(excludeIds);
    return this.#parseRows(
      this.db
        .prepare(
          `SELECT payload FROM entries
           WHERE status != 'archived' ${clause}
           ORDER BY RANDOM()
           LIMIT ?`
        )
        .all(...params, limit)
    );
  }

  saveEntry(entry) {
    const clean = withEntryDefaults(entry);
    const index = schedulingIndexFields(clean);
    this.db
      .prepare(
        `INSERT INTO entries (id, term, payload, seen_count, next_review_date, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           term = excluded.term,
           payload = excluded.payload,
           seen_count = excluded.seen_count,
           next_review_date = excluded.next_review_date,
           status = excluded.status`
      )
      .run(
        clean.id,
        clean.term.toLowerCase(),
        JSON.stringify(clean),
        index.seenCount,
        index.nextReviewDate,
        index.status
      );
    return clean;
  }

  deleteEntry(id) {
    this.db.prepare("DELETE FROM entries WHERE id = ?").run(id);
  }

  getSession(date) {
    const row = this.db.prepare("SELECT payload FROM sessions WHERE date = ?").get(date);
    return safeJsonParse(row?.payload, null);
  }

  saveSession(session) {
    this.db
      .prepare("INSERT INTO sessions (date, payload) VALUES (?, ?) ON CONFLICT(date) DO UPDATE SET payload = excluded.payload")
      .run(session.date, JSON.stringify(session));
  }

  addReview(review) {
    this.db.prepare("INSERT INTO reviews (id, payload) VALUES (?, ?)").run(review.id, JSON.stringify(review));
  }

  listReviewedEntries({ offset = 0, limit = 100 } = {}) {
    const total = Number(
      this.db.prepare("SELECT COUNT(*) AS count FROM entries WHERE seen_count > 0").get()?.count ?? 0
    );
    const rows = this.db
      .prepare(
        `SELECT payload FROM entries
         WHERE seen_count > 0
         ORDER BY seen_count DESC, term COLLATE NOCASE
         LIMIT ? OFFSET ?`
      )
      .all(limit, offset);
    return { entries: this.#parseRows(rows), total };
  }
}

class JsonAdapter {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      settings: DEFAULT_SETTINGS,
      entries: [],
      sessions: {},
      reviews: [],
      meta: {}
    };
    if (fs.existsSync(filePath)) {
      this.data = { ...this.data, ...safeJsonParse(fs.readFileSync(filePath, "utf8"), {}) };
    }
  }

  persist() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  getSettings() {
    return validateSettings(this.data.settings);
  }

  saveSettings(settings) {
    this.data.settings = validateSettings(settings);
    this.persist();
  }

  getMeta(key) {
    return this.data.meta?.[key] ?? null;
  }

  setMeta(key, value) {
    this.data.meta = { ...(this.data.meta ?? {}), [key]: String(value) };
    this.persist();
  }

  getEntries() {
    return this.data.entries.map(withEntryDefaults).sort((a, b) => a.term.localeCompare(b.term));
  }

  getEntryById(id) {
    const entry = this.data.entries.find((item) => item.id === id);
    return entry ? withEntryDefaults(entry) : null;
  }

  findEntryByTerm(term) {
    const key = normalizeTerm(term).toLowerCase();
    const entry = this.data.entries.find((item) => item.term.toLowerCase() === key);
    return entry ? withEntryDefaults(entry) : null;
  }

  getEntriesByIds(ids) {
    if (!ids?.length) return [];
    const wanted = new Set(ids);
    return this.data.entries
      .filter((entry) => wanted.has(entry.id))
      .map(withEntryDefaults);
  }

  getEntryStats() {
    const entries = this.getEntries();
    return {
      total: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      needsReview: entries.filter((entry) => entry.status === "needs-review" || entry.status === "pending").length
    };
  }

  getSchedulingPool(today, excludeIds = []) {
    return buildSchedulingPool(this.getEntries(), {
      excludeIds,
      today,
      yesterdayIds: new Set(),
      settings: this.getSettings()
    });
  }

  listEntries({ query = "", offset = 0, limit = LIBRARY_PAGE_SIZE } = {}) {
    const normalized = String(query ?? "").trim().toLowerCase();
    const filtered = this.getEntries().filter((entry) => {
      if (!normalized) return true;
      return [
        entry.term,
        entry.userMeaning,
        entry.referenceMeaning,
        entry.sourceMeaning,
        entry.notes,
        ...(entry.tags ?? [])
      ]
        .join(" ")
        .toLowerCase()
        .includes(normalized);
    });
    return {
      entries: filtered.slice(offset, offset + limit),
      total: filtered.length
    };
  }

  getRandomEntries(limit = CHOICE_DISTRACTOR_LIMIT, excludeIds = []) {
    const exclude = new Set(excludeIds);
    const candidates = this.getEntries().filter((entry) => entry.status !== "archived" && !exclude.has(entry.id));
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    return candidates.slice(0, limit);
  }

  listReviewedEntries({ offset = 0, limit = 100 } = {}) {
    const reviewed = this.getEntries()
      .filter((entry) => entry.seenCount > 0)
      .sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""));
    return {
      entries: reviewed.slice(offset, offset + limit),
      total: reviewed.length
    };
  }

  saveEntry(entry) {
    const clean = withEntryDefaults(entry);
    const index = this.data.entries.findIndex((item) => item.id === clean.id);
    if (index >= 0) this.data.entries[index] = clean;
    else this.data.entries.push(clean);
    this.persist();
    return clean;
  }

  deleteEntry(id) {
    this.data.entries = this.data.entries.filter((entry) => entry.id !== id);
    this.persist();
  }

  getSession(date) {
    return this.data.sessions[date] ?? null;
  }

  saveSession(session) {
    this.data.sessions[session.date] = session;
    this.persist();
  }

  addReview(review) {
    this.data.reviews.push(review);
    this.persist();
  }
}

export class DataStore {
  constructor(appDataPath) {
    const dataDir = process.env.VOCAB_DESKTOP_DATA_DIR || appDataPath;
    fs.mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.storageKind = "json";
    try {
      if (DatabaseSync) {
        this.dataPath = path.join(dataDir, "vocabulary.sqlite");
        this.adapter = new SqliteAdapter(this.dataPath);
        this.storageKind = "sqlite";
      } else {
        this.dataPath = path.join(dataDir, "vocabulary.json");
        this.adapter = new JsonAdapter(this.dataPath);
      }
    } catch (error) {
      console.warn("SQLite unavailable, falling back to JSON:", error);
      this.dataPath = path.join(dataDir, "vocabulary.json");
      this.adapter = new JsonAdapter(this.dataPath);
      this.storageKind = "json";
    }

    this.seedMissingEntries();
    this.backfillReferenceMeanings();
    this.backfillMissingPhonetics();
  }

  // Many derived words (e.g. the adverb "instantaneously") have a meaning in
  // ECDICT but no phonetic of their own; the phonetic only lives on the base
  // word. lookupEcdict now borrows one from the base form, so re-run it for any
  // stored entry that is still missing a phonetic and persist the result.
  backfillMissingPhonetics() {
    const VERSION = "1";
    try {
      if (this.adapter.getMeta?.("phoneticBackfillVersion") === VERSION) return;
    } catch {
      return;
    }

    for (const stored of this.adapter.getEntries()) {
      if (stored.phonetics?.length) continue;
      const offline = lookupEcdict(stored.term);
      if (offline?.phonetics?.length) {
        this.adapter.saveEntry(
          withEntryDefaults({ ...stored, phonetics: offline.phonetics, updatedAt: nowIso() })
        );
      }
    }
    this.adapter.setMeta?.("phoneticBackfillVersion", VERSION);
  }

  // Existing installs already seeded the 498 entries before ECDICT reference data
  // existed. Backfill the clean reference meaning / phonetic onto those stored
  // entries once, without ever touching the user's own meaning.
  backfillReferenceMeanings() {
    const VERSION = "1";
    try {
      if (this.adapter.getMeta?.("ecdictReferenceVersion") === VERSION) return;
    } catch {
      return;
    }

    const seedByTerm = new Map(seedEntries.map((entry) => [entry.term.toLowerCase(), entry]));
    for (const stored of this.adapter.getEntries()) {
      const seed = seedByTerm.get(stored.term.toLowerCase());
      if (!seed) continue;

      const updates = {};
      if (seed.referenceMeaning && stored.referenceMeaning !== seed.referenceMeaning) {
        updates.referenceMeaning = seed.referenceMeaning;
        updates.referenceSource = seed.referenceSource || "ECDICT";
      }
      if ((!stored.phonetics || stored.phonetics.length === 0) && seed.phonetics?.length) {
        updates.phonetics = seed.phonetics;
      }
      if (Object.keys(updates).length) {
        this.adapter.saveEntry(withEntryDefaults({ ...stored, ...updates, updatedAt: nowIso() }));
      }
    }
    this.adapter.setMeta?.("ecdictReferenceVersion", VERSION);
  }

  seedMissingEntries() {
    const existingEntries = this.adapter.getEntries();
    const existingTerms = new Set(existingEntries.map((entry) => entry.term.toLowerCase()));
    const deletedTerms = new Set(safeJsonParse(this.adapter.getMeta?.("deletedTerms"), []));
    if (existingEntries.length === 0) this.adapter.saveSettings(DEFAULT_SETTINGS);
    for (const entry of seedEntries) {
      const key = entry.term.toLowerCase();
      if (existingTerms.has(key) || deletedTerms.has(key)) continue;
      this.adapter.saveEntry(withEntryDefaults(entry));
    }
  }

  #planningEntries(existingSession, today) {
    const completedIds = new Set(existingSession?.completedIds ?? []);
    const preservedIds = (existingSession?.entryIds ?? []).filter((id) => completedIds.has(id));
    const pool = this.adapter.getSchedulingPool(today, preservedIds);
    const completedEntries = this.adapter.getEntriesByIds(preservedIds);
    const byId = new Map();
    for (const entry of completedEntries) byId.set(entry.id, entry);
    for (const entry of pool) byId.set(entry.id, entry);
    return [...byId.values()];
  }

  #studyEntriesForSession(todaySession) {
    const studyIds = new Set(todaySession.entryIds);
    const distractors = this.adapter.getRandomEntries(CHOICE_DISTRACTOR_LIMIT, [...studyIds]);
    for (const entry of distractors) studyIds.add(entry.id);
    return this.adapter.getEntriesByIds([...studyIds]);
  }

  getState() {
    const settings = this.adapter.getSettings();
    const today = todayKey();
    const existing = this.adapter.getSession(today);
    const planningEntries = this.#planningEntries(existing, today);
    const todaySession = this.ensureTodaySession(settings, planningEntries, false);
    const entries = this.#studyEntriesForSession(todaySession);
    return {
      settings,
      entries,
      todaySession,
      stats: this.getStats(todaySession),
      storageKind: this.storageKind,
      dataPath: this.dataPath
    };
  }

  getStats(session) {
    const completed = new Set(session.completedIds);
    const counts = this.adapter.getEntryStats();
    return {
      ...counts,
      todayRemaining: Math.max(0, session.entryIds.length - completed.size)
    };
  }

  getEntry(entryId) {
    return this.adapter.getEntryById(entryId);
  }

  findEntryByTerm(term) {
    return this.adapter.findEntryByTerm(term);
  }

  listLibraryEntries({ query = "", offset = 0, limit = LIBRARY_PAGE_SIZE } = {}) {
    return this.adapter.listEntries({ query, offset, limit });
  }

  listHistoryEntries({ offset = 0, limit = 100 } = {}) {
    return this.adapter.listReviewedEntries({ offset, limit });
  }

  updateSettings(partial) {
    const next = validateSettings({ ...this.adapter.getSettings(), ...partial });
    this.adapter.saveSettings(next);
    const today = todayKey();
    this.ensureTodaySession(next, this.#planningEntries(this.adapter.getSession(today), today), true);
    return this.getState();
  }

  addEntry(input) {
    const term = normalizeTerm(input.term);
    if (!term) throw new Error("Please enter a word or phrase.");

    const existing = this.adapter
      .getEntries()
      .find((entry) => entry.term.toLowerCase() === term.toLowerCase());
    const base = existing ?? { id: slugify(term), term };
    const baseExamples = Array.isArray(base.examples) ? base.examples : [];
    const newExample = makeUserExample(input.example);
    const examples = newExample ? [...baseExamples, newExample] : baseExamples;
    const entry = withEntryDefaults({
      ...base,
      term,
      type: input.type || (/\s/.test(term) ? "phrase" : "word"),
      userMeaning: input.userMeaning ?? base.userMeaning ?? "",
      notes: input.notes ?? base.notes ?? "",
      examples,
      status: base.status ?? "pending",
      updatedAt: nowIso()
    });

    this.adapter.saveEntry(entry);
    return this.getState();
  }

  mergeEnrichment(entryId, enrichment) {
    const entry = this.adapter.getEntryById(entryId);
    if (!entry) throw new Error("Entry not found.");

    // The user's own example sentences must survive a dictionary refresh. Keep
    // them and merge dictionary examples (which only replace previous dictionary
    // examples, never the user's).
    const userExamples = (entry.examples ?? []).filter((example) => example.userAdded);
    const dictExamples = enrichment.examples?.length
      ? enrichment.examples
      : (entry.examples ?? []).filter((example) => !example.userAdded);
    const mergedExamples = [...dictExamples, ...userExamples];

    const next = withEntryDefaults({
      ...entry,
      // userMeaning (the user's own/PDF meaning) is intentionally preserved.
      referenceMeaning: enrichment.referenceMeaning || entry.referenceMeaning,
      referenceSource: enrichment.referenceSource || entry.referenceSource,
      sourceMeaning: enrichment.sourceMeaning || entry.sourceMeaning,
      partOfSpeech: enrichment.partOfSpeech || entry.partOfSpeech,
      phonetics: enrichment.phonetics?.length ? enrichment.phonetics : entry.phonetics,
      examples: mergedExamples,
      status: enrichment.status || entry.status,
      dictionarySource: enrichment.source || entry.dictionarySource,
      dictionaryNote: enrichment.note || entry.dictionaryNote,
      dictionaryLookupAttemptedAt: nowIso(),
      updatedAt: nowIso()
    });
    this.adapter.saveEntry(next);
    return this.getState();
  }

  favoriteExample(entryId, exampleIndex) {
    const entry = this.adapter.getEntryById(entryId);
    if (!entry) throw new Error("Entry not found.");
    const examples = entry.examples.map((example, index) =>
      index === exampleIndex ? { ...example, favorite: !example.favorite } : example
    );
    this.adapter.saveEntry(withEntryDefaults({ ...entry, examples, updatedAt: nowIso() }));
    return this.getState();
  }

  // Manual edits from the library "管理" panel: change the user's meaning / notes
  // and replace the full example list (used for adding or removing examples).
  updateEntry(entryId, updates = {}) {
    const entry = this.adapter.getEntryById(entryId);
    if (!entry) throw new Error("Entry not found.");

    const next = withEntryDefaults({
      ...entry,
      userMeaning: updates.userMeaning !== undefined ? String(updates.userMeaning).trim() : entry.userMeaning,
      notes: updates.notes !== undefined ? String(updates.notes) : entry.notes,
      examples: updates.examples !== undefined ? normalizeExamples(updates.examples) : entry.examples,
      updatedAt: nowIso()
    });
    this.adapter.saveEntry(next);
    return this.getState();
  }

  deleteEntry(entryId) {
    const entry = this.adapter.getEntryById(entryId);
    if (!entry) return this.getState();

    this.adapter.deleteEntry(entryId);

    // Remember the term so seedMissingEntries() does not re-add it on the next
    // launch (the seed list would otherwise resurrect a deleted seed word).
    const deleted = new Set(safeJsonParse(this.adapter.getMeta?.("deletedTerms"), []));
    deleted.add(entry.term.toLowerCase());
    this.adapter.setMeta?.("deletedTerms", JSON.stringify([...deleted]));

    // Drop the word from today's queue so the UI never points at a missing entry.
    const date = todayKey();
    const session = this.adapter.getSession(date);
    if (session?.entryIds?.includes(entryId)) {
      session.entryIds = session.entryIds.filter((id) => id !== entryId);
      session.completedIds = (session.completedIds ?? []).filter((id) => id !== entryId);
      session.updatedAt = nowIso();
      this.adapter.saveSession(session);
    }

    return this.getState();
  }

  recordReview({ entryId, mode, result, shouldComplete = true }) {
    const entry = this.adapter.getEntryById(entryId);
    if (!entry) throw new Error("Entry not found.");
    const scheduling = nextScheduling(entry, result);

    const updates = {
      lastSeenAt: nowIso(),
      nextReviewAt: scheduling.nextReviewAt,
      intervalDays: scheduling.intervalDays,
      ease: scheduling.ease,
      seenCount: entry.seenCount + 1,
      correctCount: entry.correctCount + (result === "correct" || result === "remembered" ? 1 : 0),
      wrongCount: entry.wrongCount + (result === "wrong" ? 1 : 0),
      forgottenCount: entry.forgottenCount + (result === "forgotten" ? 1 : 0)
    };
    this.adapter.saveEntry(withEntryDefaults({ ...entry, ...updates, updatedAt: nowIso() }));

    const review = {
      id: randomUUID(),
      entryId,
      mode,
      result,
      createdAt: nowIso()
    };
    this.adapter.addReview(review);

    if (shouldComplete) {
      const date = todayKey();
      const session = this.adapter.getSession(date);
      if (session && !session.completedIds.includes(entryId)) {
        session.completedIds.push(entryId);
        session.updatedAt = nowIso();
        this.adapter.saveSession(session);
      }
    }

    return this.getState();
  }

  ensureTodaySession(settings, entries, force = false) {
    const date = todayKey();
    const existing = this.adapter.getSession(date);
    const previous = this.adapter.getSession(todayKey(-1));
    const { session: planned, reused } = planTodaySession({
      settings,
      entries,
      existingSession: existing,
      yesterdayEntryIds: previous?.entryIds ?? [],
      today: date,
      force
    });

    if (reused) return planned;

    this.markNewlyQueued(planned.entryIds, existing?.entryIds ?? []);

    const session = {
      ...planned,
      createdAt: existing?.createdAt || nowIso(),
      updatedAt: nowIso()
    };
    this.adapter.saveSession(session);
    return session;
  }

  markNewlyQueued(selectedIds, previousIds) {
    for (const entryId of newlyQueuedEntryIds(selectedIds, previousIds)) {
      const entry = this.adapter.getEntryById(entryId);
      if (!entry) continue;
      this.adapter.saveEntry(
        withEntryDefaults({
          ...entry,
          lastQueuedAt: nowIso(),
          queuedCount: entry.queuedCount + 1,
          updatedAt: nowIso()
        })
      );
    }
  }

  isDue(entry, today) {
    return schedulingIsDue(entry, today);
  }

  scoreEntry(entry, yesterdayIds, settings) {
    return schedulingScoreEntry(entry, yesterdayIds, settings, { today: todayKey() });
  }
}

export { DEFAULT_SETTINGS, LIBRARY_PAGE_SIZE };
