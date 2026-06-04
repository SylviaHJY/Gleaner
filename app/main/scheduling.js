/**
 * Pure scheduling helpers (intervals, due dates, daily queue planning).
 * Used by DataStore and unit-tested without Electron.
 */

export function todayKey(offsetDays = 0, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateKeyFromIso(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function daysBetween(dateA, dateB) {
  const a = new Date(`${dateA}T00:00:00`);
  const b = new Date(`${dateB}T00:00:00`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

export function isoFromToday(offsetDays, now = new Date()) {
  const date = new Date(now);
  date.setHours(9, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString();
}

export function nextScheduling(entry, result, { now = new Date() } = {}) {
  const isSuccess = result === "correct" || result === "remembered";
  const isFailure = result === "wrong" || result === "forgotten";
  const currentInterval = Math.max(0, Number(entry.intervalDays || 0));
  const currentEase = Number(entry.ease || 2.3);

  if (isFailure) {
    return {
      intervalDays: 1,
      ease: Math.max(1.35, currentEase - 0.28),
      nextReviewAt: isoFromToday(1, now)
    };
  }

  if (isSuccess) {
    const intervalDays =
      currentInterval <= 0 ? 2 : Math.min(90, Math.max(2, Math.round(currentInterval * currentEase)));
    return {
      intervalDays,
      ease: Math.min(2.8, currentEase + 0.08),
      nextReviewAt: isoFromToday(intervalDays, now)
    };
  }

  return {
    intervalDays: currentInterval || 1,
    ease: currentEase,
    nextReviewAt: entry.nextReviewAt || isoFromToday(1, now)
  };
}

export function isDue(entry, today) {
  if (!entry.nextReviewAt) return true;
  const dueDate = dateKeyFromIso(entry.nextReviewAt);
  return !dueDate || dueDate <= today;
}

export function scoreEntry(entry, yesterdayIds, settings, { today = todayKey(0), random = Math.random } = {}) {
  const dueDate = dateKeyFromIso(entry.nextReviewAt);
  const overdueBoost = dueDate ? Math.max(0, daysBetween(dueDate, today)) * 0.9 : 0;
  const dueBoost = entry.seenCount > 0 && isDue(entry, today) ? 7 + overdueBoost : 0;
  const unseenBoost = entry.seenCount === 0 ? 8 : 0;
  const struggleBoost = entry.forgottenCount * 3 + entry.wrongCount * 2;
  const knownPenalty = entry.correctCount * 0.45;
  const queuedPenalty = entry.seenCount === 0 ? entry.queuedCount * 12 : 0;
  const yesterdayPenalty = settings.avoidYesterday && yesterdayIds.has(entry.id) ? 8 : 0;
  const oldSeenBoost = entry.lastSeenAt
    ? Math.min(4, Math.max(0, daysBetween(dateKeyFromIso(entry.lastSeenAt), today)) * 0.2)
    : 0;
  return dueBoost + unseenBoost + struggleBoost + oldSeenBoost - knownPenalty - queuedPenalty - yesterdayPenalty + random();
}

export function pickEntries(selected, candidates, limit, yesterdayIds, settings) {
  if (limit <= 0) return [];
  const picked = [];
  const targetLength = selected.length + limit;
  const selectedSet = new Set(selected);
  const preferred = candidates.filter(
    (entry) => !selectedSet.has(entry.id) && !(settings.avoidYesterday && yesterdayIds.has(entry.id))
  );
  const fallback = candidates.filter((entry) => !selectedSet.has(entry.id) && !preferred.includes(entry));

  for (const entry of [...preferred, ...fallback]) {
    if (selected.length >= targetLength) break;
    if (selectedSet.has(entry.id)) continue;
    selected.push(entry.id);
    selectedSet.add(entry.id);
    picked.push(entry.id);
  }
  return picked;
}

export function reviewStatsDelta(result) {
  return {
    seenCountDelta: 1,
    correctCountDelta: result === "correct" || result === "remembered" ? 1 : 0,
    wrongCountDelta: result === "wrong" ? 1 : 0,
    forgottenCountDelta: result === "forgotten" ? 1 : 0
  };
}

export const SCHEDULING_POOL_CAPS = {
  unseen: 500,
  due: 400,
  future: 200
};

function capSortByScore(entries, max, scoreFn) {
  if (entries.length <= max) {
    return [...entries].sort((a, b) => scoreFn(b) - scoreFn(a));
  }
  return entries
    .map((entry) => ({ entry, score: scoreFn(entry) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((item) => item.entry);
}

/** Narrow a large library to scheduling-relevant candidates before scoring/sorting. */
export function buildSchedulingPool(
  entries,
  { excludeIds = [], today = todayKey(0), yesterdayIds = new Set(), settings = { avoidYesterday: true }, random = Math.random } = {}
) {
  const exclude = new Set(excludeIds);
  const score = (entry) => scoreEntry(entry, yesterdayIds, settings, { today, random });
  const base = entries.filter((entry) => entry.status !== "archived" && !exclude.has(entry.id));

  const unseen = base.filter((entry) => entry.seenCount === 0);
  const due = base.filter((entry) => entry.seenCount > 0 && isDue(entry, today));
  const future = base.filter((entry) => entry.seenCount > 0 && !isDue(entry, today));

  const byId = new Map();
  for (const entry of [
    ...capSortByScore(unseen, SCHEDULING_POOL_CAPS.unseen, score),
    ...capSortByScore(due, SCHEDULING_POOL_CAPS.due, score),
    ...capSortByScore(future, SCHEDULING_POOL_CAPS.future, score)
  ]) {
    byId.set(entry.id, entry);
  }
  return [...byId.values()];
}

export function schedulingIndexFields(entry) {
  return {
    seenCount: entry.seenCount || 0,
    nextReviewDate: dateKeyFromIso(entry.nextReviewAt) || "",
    status: entry.status || "pending"
  };
}

export function applyReviewToEntry(entry, result, { now = new Date() } = {}) {
  const scheduling = nextScheduling(entry, result, { now });
  const delta = reviewStatsDelta(result);
  return {
    ...entry,
    lastSeenAt: now.toISOString(),
    nextReviewAt: scheduling.nextReviewAt,
    intervalDays: scheduling.intervalDays,
    ease: scheduling.ease,
    seenCount: (entry.seenCount || 0) + delta.seenCountDelta,
    correctCount: (entry.correctCount || 0) + delta.correctCountDelta,
    wrongCount: (entry.wrongCount || 0) + delta.wrongCountDelta,
    forgottenCount: (entry.forgottenCount || 0) + delta.forgottenCountDelta
  };
}

/**
 * Build today's queue without touching storage. Returns session fields plus phase
 * traces for tests.
 */
export function planTodaySession({
  settings,
  entries,
  existingSession = null,
  yesterdayEntryIds = [],
  today = todayKey(0),
  random = Math.random,
  force = false
}) {
  const goal = settings.dailyGoal;
  const existing = existingSession;
  const yesterdayIds = new Set(yesterdayEntryIds);

  if (!force && existing && existing.entryIds?.length === goal) {
    return {
      session: existing,
      reviewSlots: 0,
      phases: { duePrimary: [], unseen: [], dueSecondary: [], future: [] },
      reused: true
    };
  }

  const completedIds = new Set(existing?.completedIds ?? []);
  const selected = [...(existing?.entryIds ?? [])].filter((id) => completedIds.has(id));

  const pool = buildSchedulingPool(entries, {
    excludeIds: selected,
    today,
    yesterdayIds,
    settings,
    random
  });

  const score = (entry) => scoreEntry(entry, yesterdayIds, settings, { today, random });

  const dueReviews = pool
    .filter((entry) => entry.seenCount > 0 && isDue(entry, today))
    .sort((a, b) => score(b) - score(a));
  const unseen = pool
    .filter((entry) => entry.seenCount === 0)
    .sort((a, b) => score(b) - score(a));
  const futureReviews = pool
    .filter((entry) => entry.seenCount > 0 && !isDue(entry, today))
    .sort((a, b) => score(b) - score(a));

  const reviewSlots = Math.min(dueReviews.length, Math.max(1, Math.floor(goal * 0.35)));
  const phases = {
    duePrimary: pickEntries(selected, dueReviews, reviewSlots, yesterdayIds, settings),
    unseen: pickEntries(selected, unseen, goal - selected.length, yesterdayIds, settings),
    dueSecondary: pickEntries(selected, dueReviews, goal - selected.length, yesterdayIds, settings),
    future: pickEntries(selected, futureReviews, goal - selected.length, yesterdayIds, settings)
  };

  const entryIds = selected.slice(0, goal);
  const session = {
    date: today,
    entryIds,
    completedIds: [...completedIds].filter((id) => entryIds.includes(id))
  };

  return { session, reviewSlots, phases, reused: false };
}

export function newlyQueuedEntryIds(selectedIds, previousIds) {
  const previous = new Set(previousIds);
  return selectedIds.filter((id) => !previous.has(id));
}

/** Assert scheduling payload matches intervalDays from a fixed clock. */
export function expectedDueDateKey(intervalDays, now = new Date()) {
  return dateKeyFromIso(isoFromToday(intervalDays, now));
}
