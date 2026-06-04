import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DataStore, DEFAULT_SETTINGS } from "./dataStore.js";
import {
  applyReviewToEntry,
  buildSchedulingPool,
  dateKeyFromIso,
  expectedDueDateKey,
  isDue,
  nextScheduling,
  planTodaySession,
  SCHEDULING_POOL_CAPS,
  todayKey
} from "./scheduling.js";

const FIXED_NOW = new Date("2026-06-04T15:30:00.000Z");
const TODAY = todayKey(0, FIXED_NOW);
const YESTERDAY = todayKey(-1, FIXED_NOW);
const TOMORROW = todayKey(1, FIXED_NOW);

function entry(overrides = {}) {
  return {
    id: "word",
    term: "word",
    status: "ready",
    seenCount: 0,
    correctCount: 0,
    wrongCount: 0,
    forgottenCount: 0,
    intervalDays: 0,
    ease: 2.3,
    nextReviewAt: "",
    queuedCount: 0,
    ...overrides
  };
}

function settings(overrides = {}) {
  return { ...DEFAULT_SETTINGS, dailyGoal: 10, avoidYesterday: true, ...overrides };
}

/** In-memory adapter for DataStore integration tests. */
class MemoryAdapter {
  constructor() {
    this.settings = { ...DEFAULT_SETTINGS };
    this.entries = [];
    this.sessions = {};
    this.reviews = [];
    this.meta = {};
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(next) {
    this.settings = next;
  }

  getMeta(key) {
    return this.meta[key] ?? null;
  }

  setMeta(key, value) {
    this.meta[key] = value;
  }

  getEntries() {
    return this.entries;
  }

  getEntryById(id) {
    return this.entries.find((item) => item.id === id) ?? null;
  }

  getEntriesByIds(ids) {
    if (!ids?.length) return [];
    const wanted = new Set(ids);
    return this.entries.filter((item) => wanted.has(item.id));
  }

  getEntryStats() {
    return {
      total: this.entries.length,
      ready: this.entries.filter((item) => item.status === "ready").length,
      needsReview: this.entries.filter((item) => item.status === "needs-review" || item.status === "pending").length
    };
  }

  getSchedulingPool(today, excludeIds = []) {
    return buildSchedulingPool(this.entries, {
      excludeIds,
      today,
      yesterdayIds: new Set(),
      settings: this.settings
    });
  }

  getRandomEntries(limit = 100, excludeIds = []) {
    const exclude = new Set(excludeIds);
    return this.entries.filter((item) => !exclude.has(item.id)).slice(0, limit);
  }

  listEntries({ query = "", offset = 0, limit = 50 } = {}) {
    const normalized = String(query).trim().toLowerCase();
    const filtered = this.entries.filter((entry) => {
      if (!normalized) return true;
      return entry.term.toLowerCase().includes(normalized);
    });
    return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
  }

  listReviewedEntries({ offset = 0, limit = 100 } = {}) {
    const reviewed = this.entries.filter((entry) => entry.seenCount > 0);
    return { entries: reviewed.slice(offset, offset + limit), total: reviewed.length };
  }

  findEntryByTerm(term) {
    const key = String(term).trim().toLowerCase();
    return this.entries.find((item) => item.term.toLowerCase() === key) ?? null;
  }

  saveEntry(entry) {
    const index = this.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) this.entries[index] = entry;
    else this.entries.push(entry);
    return entry;
  }

  deleteEntry(id) {
    this.entries = this.entries.filter((item) => item.id !== id);
  }

  getSession(date) {
    return this.sessions[date] ?? null;
  }

  saveSession(session) {
    this.sessions[session.date] = session;
  }

  addReview(review) {
    this.reviews.push(review);
  }
}

describe("nextScheduling — interval arithmetic", () => {
  it("first success → 2 days and ease 2.38", () => {
    const result = nextScheduling(entry(), "remembered", { now: FIXED_NOW });
    assert.equal(result.intervalDays, 2);
    assert.equal(result.ease, 2.38);
    assert.equal(dateKeyFromIso(result.nextReviewAt), expectedDueDateKey(2, FIXED_NOW));
  });

  it("repeated success increases interval until capped at 90", () => {
    let state = entry({ intervalDays: 2, ease: 2.3 });
    const intervals = [];

    for (let i = 0; i < 12; i++) {
      const result = nextScheduling(state, "correct", { now: FIXED_NOW });
      intervals.push(result.intervalDays);
      assert.ok(result.intervalDays >= 2);
      assert.ok(result.intervalDays <= 90);
      state = { ...state, intervalDays: result.intervalDays, ease: result.ease };
    }

    assert.ok(intervals.at(-1) >= intervals[0], "interval should grow overall");
    assert.equal(intervals.at(-1), 90);
  });

  it("failure resets interval to 1, ease floor 1.35, due tomorrow", () => {
    const result = nextScheduling(entry({ intervalDays: 30, ease: 1.4 }), "wrong", { now: FIXED_NOW });
    assert.equal(result.intervalDays, 1);
    assert.equal(result.ease, 1.35);
    assert.equal(dateKeyFromIso(result.nextReviewAt), TOMORROW);
  });
});

describe("isDue", () => {
  it("missing nextReviewAt is due", () => {
    assert.equal(isDue(entry(), TODAY), true);
  });

  it("due date yesterday or today is due; tomorrow is not", () => {
    const yesterdayDue = entry({ nextReviewAt: new Date(`${YESTERDAY}T09:00:00`).toISOString() });
    const todayDue = entry({ nextReviewAt: new Date(`${TODAY}T09:00:00`).toISOString() });
    const tomorrowDue = entry({ nextReviewAt: new Date(`${TOMORROW}T09:00:00`).toISOString() });

    assert.equal(isDue(yesterdayDue, TODAY), true);
    assert.equal(isDue(todayDue, TODAY), true);
    assert.equal(isDue(tomorrowDue, TODAY), false);
  });
});

describe("buildSchedulingPool", () => {
  it("caps each scheduling bucket before planning", () => {
    const manyUnseen = Array.from({ length: 800 }, (_, index) => entry({ id: `u${index}`, term: `u${index}` }));
    const manyDue = Array.from({ length: 600 }, (_, index) =>
      entry({
        id: `d${index}`,
        term: `d${index}`,
        seenCount: 2,
        nextReviewAt: new Date(`${YESTERDAY}T09:00:00`).toISOString()
      })
    );
    const pool = buildSchedulingPool([...manyUnseen, ...manyDue], {
      today: TODAY,
      random: () => 0
    });
    assert.ok(pool.length <= SCHEDULING_POOL_CAPS.unseen + SCHEDULING_POOL_CAPS.due + SCHEDULING_POOL_CAPS.future);
    assert.ok(pool.length < 1400);
  });
});

describe("planTodaySession — daily queue", () => {
  const deterministicRandom = () => 0;

  it("unseen words only enter via the unseen phase when no due reviews exist", () => {
    const entries = [
      entry({ id: "a", term: "a" }),
      entry({ id: "b", term: "b" }),
      entry({ id: "c", term: "c" })
    ];
    const { session, phases, reviewSlots } = planTodaySession({
      settings: settings({ dailyGoal: 3 }),
      entries,
      today: TODAY,
      random: deterministicRandom,
      force: true
    });

    assert.equal(reviewSlots, 0);
    assert.equal(phases.duePrimary.length, 0);
    assert.equal(phases.dueSecondary.length, 0);
    assert.equal(session.entryIds.length, 3);
    assert.deepEqual(new Set(phases.unseen), new Set(session.entryIds));
    for (const id of session.entryIds) {
      assert.equal(entries.find((item) => item.id === id).seenCount, 0);
    }
  });

  it("allocates primary due slots ≈ floor(goal * 0.35)", () => {
    const dueEntries = Array.from({ length: 5 }, (_, index) =>
      entry({
        id: `due-${index}`,
        term: `due-${index}`,
        seenCount: 2,
        nextReviewAt: new Date(`${YESTERDAY}T09:00:00`).toISOString()
      })
    );
    const { reviewSlots, phases, session } = planTodaySession({
      settings: settings({ dailyGoal: 10 }),
      entries: dueEntries,
      today: TODAY,
      random: deterministicRandom,
      force: true
    });

    assert.equal(reviewSlots, 3);
    assert.equal(phases.duePrimary.length, 3);
    for (const id of phases.duePrimary) {
      assert.ok(session.entryIds.includes(id));
    }
  });

  it("avoidYesterday prefers non-yesterday ids when enough candidates exist", () => {
    const entries = [
      entry({ id: "fresh", term: "fresh" }),
      entry({ id: "stale", term: "stale" })
    ];
    const { session } = planTodaySession({
      settings: settings({ dailyGoal: 1, avoidYesterday: true }),
      entries,
      yesterdayEntryIds: ["stale"],
      today: TODAY,
      random: deterministicRandom,
      force: true
    });

    assert.deepEqual(session.entryIds, ["fresh"]);
  });

  it("keeps completed ids in the truncated queue when daily goal shrinks", () => {
    const existing = {
      date: TODAY,
      entryIds: ["one", "two", "three", "four", "five"],
      completedIds: ["one", "two", "three", "four", "five"]
    };
    const entries = existing.entryIds.map((id) => entry({ id, term: id, seenCount: 1 }));

    const { session } = planTodaySession({
      settings: settings({ dailyGoal: 3 }),
      entries,
      existingSession: existing,
      today: TODAY,
      random: deterministicRandom,
      force: true
    });

    assert.deepEqual(session.entryIds, ["one", "two", "three"]);
    assert.deepEqual(session.completedIds, ["one", "two", "three"]);
  });
});

describe("random review simulation", () => {
  it("nextReviewAt always matches intervalDays from the fixed clock", () => {
    let state = entry();
    const results = ["remembered", "correct", "wrong", "forgotten", "remembered"];

    for (const result of results) {
      const scheduling = nextScheduling(state, result, { now: FIXED_NOW });
      assert.equal(dateKeyFromIso(scheduling.nextReviewAt), expectedDueDateKey(scheduling.intervalDays, FIXED_NOW));
      state = applyReviewToEntry(state, result, { now: FIXED_NOW });
      assert.equal(state.intervalDays, scheduling.intervalDays);
      assert.equal(state.ease, scheduling.ease);
      assert.equal(state.nextReviewAt, scheduling.nextReviewAt);
    }
  });
});

describe("DataStore.recordReview — UI contract", () => {
  it("shouldComplete false does not add completedIds but still increments seenCount", () => {
    const adapter = new MemoryAdapter();
    const store = new DataStore("/tmp/vocab-scheduling-test-unused");
    store.adapter = adapter;
    store.storageKind = "memory";

    const word = entry({ id: "alpha", term: "alpha" });
    adapter.saveEntry(word);
    adapter.saveSession({
      date: todayKey(),
      entryIds: ["alpha"],
      completedIds: []
    });

    store.recordReview({
      entryId: "alpha",
      mode: "choice",
      result: "correct",
      shouldComplete: false
    });

    const saved = adapter.getEntries().find((item) => item.id === "alpha");
    const session = adapter.getSession(todayKey());

    assert.equal(saved.seenCount, 1);
    assert.equal(saved.correctCount, 1);
    assert.deepEqual(session.completedIds, []);

    store.recordReview({
      entryId: "alpha",
      mode: "card",
      result: "remembered",
      shouldComplete: true
    });

    assert.deepEqual(adapter.getSession(todayKey()).completedIds, ["alpha"]);
  });
});
