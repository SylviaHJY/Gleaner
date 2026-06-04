import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BookOpen,
  CalendarCheck,
  Check,
  Database,
  FilePlus2,
  Headphones,
  History,
  ListChecks,
  Loader2,
  Minus,
  PencilLine,
  Plus,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Star,
  Trash2,
  Volume2,
  X
} from "lucide-react";
import { seedEntries } from "../main/seedEntries.js";
import "./styles/app.css";

const api = window.vocabApi ?? createPreviewApi();
const modes = ["card", "choice", "spell"];
const LIBRARY_PAGE_SIZE = 50;

function classNames(...values) {
  return values.filter(Boolean).join(" ");
}

function firstPhonetic(entry) {
  return entry?.phonetics?.[0]?.text || "";
}

function entryStatusLabel(entry) {
  if (entry.importWarnings?.length) return "待确认";
  if (entry.status === "ready") return "已准备";
  if (entry.status === "needs-review") return "待确认";
  return "待补全";
}

function formatReviewDate(value) {
  if (!value) return "尚未安排复习";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "复习时间待确认";
  return `下次复习 ${date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })}`;
}

function databaseFileName(dataPath) {
  if (!dataPath) return "";
  if (dataPath === "Preview mode") return dataPath;
  const normalized = String(dataPath).replace(/\\/g, "/");
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  return name || dataPath;
}

function getTodayEntry(state) {
  const completed = new Set(state?.todaySession?.completedIds ?? []);
  const nextId = state?.todaySession?.entryIds?.find((id) => !completed.has(id));
  return state?.entries?.find((entry) => entry.id === nextId) ?? null;
}

function getEntryIndex(state, entry) {
  if (!state || !entry) return 0;
  return Math.max(0, state.todaySession.entryIds.indexOf(entry.id));
}

function speakText(text, region = "US") {
  if (!window.speechSynthesis || !text) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = region === "UK" ? "en-GB" : "en-US";
  utterance.rate = 0.88;
  window.speechSynthesis.speak(utterance);
}

function playPronunciation(entry, region = "US") {
  const phonetic = entry.phonetics?.find((item) => item.region === region && item.audio);
  if (phonetic?.audio) {
    new Audio(phonetic.audio).play().catch(() => speakText(entry.term, region));
    return;
  }
  speakText(entry.term, region);
}

function createPreviewApi() {
  let previewState = makePreviewState();

  function recompute() {
    const completed = new Set(previewState.todaySession.completedIds);
    previewState = {
      ...previewState,
      stats: {
        total: previewState.entries.length,
        ready: previewState.entries.filter((entry) => entry.status === "ready").length,
        needsReview: previewState.entries.filter((entry) => entry.status !== "ready").length,
        todayRemaining: Math.max(0, previewState.todaySession.entryIds.length - completed.size)
      }
    };
    return structuredClone(previewState);
  }

  return {
    getState: async () => recompute(),
    updateSettings: async (partial) => {
      previewState.settings = { ...previewState.settings, ...partial };
      previewState.todaySession.entryIds = previewState.entries.slice(0, previewState.settings.dailyGoal).map((entry) => entry.id);
      previewState.todaySession.completedIds = previewState.todaySession.completedIds.filter((id) => previewState.todaySession.entryIds.includes(id));
      return recompute();
    },
    addEntry: async (input) => {
      const term = input.term.trim();
      if (!term) return recompute();
      const exampleText = String(input.example ?? "").trim();
      const examples = exampleText
        ? [{ en: exampleText.split(/\r?\n/)[0].trim(), zh: exampleText.split(/\r?\n/).slice(1).join(" ").trim(), favorite: false, userAdded: true }]
        : [];
      previewState.entries.unshift({
        id: term.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        term,
        type: /\s/.test(term) ? "phrase" : "word",
        userMeaning: input.userMeaning,
        sourceMeaning: "",
        partOfSpeech: "",
        phonetics: [],
        examples,
        forms: [],
        tags: ["待确认"],
        notes: input.notes,
        status: "pending",
        dictionaryLookupAttemptedAt: new Date().toISOString(),
        dictionaryNote: "Preview mode does not call external APIs.",
        lastQueuedAt: "",
        queuedCount: 0,
        nextReviewAt: "",
        intervalDays: 0,
        ease: 2.3,
        seenCount: 0,
        correctCount: 0,
        wrongCount: 0,
        forgottenCount: 0
      });
      return recompute();
    },
    updateEntry: async ({ entryId, updates }) => {
      previewState.entries = previewState.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              userMeaning: updates.userMeaning !== undefined ? updates.userMeaning : entry.userMeaning,
              notes: updates.notes !== undefined ? updates.notes : entry.notes,
              examples: updates.examples !== undefined ? updates.examples : entry.examples
            }
          : entry
      );
      return recompute();
    },
    deleteEntry: async (entryId) => {
      previewState.entries = previewState.entries.filter((entry) => entry.id !== entryId);
      previewState.todaySession.entryIds = previewState.todaySession.entryIds.filter((id) => id !== entryId);
      previewState.todaySession.completedIds = previewState.todaySession.completedIds.filter((id) => id !== entryId);
      return recompute();
    },
    favoriteExample: async ({ entryId, exampleIndex }) => {
      previewState.entries = previewState.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              examples: entry.examples.map((example, index) =>
                index === exampleIndex ? { ...example, favorite: !example.favorite } : example
              )
            }
          : entry
      );
      return recompute();
    },
    recordReview: async ({ entryId, result, shouldComplete = true }) => {
      previewState.entries = previewState.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              seenCount: entry.seenCount + 1,
              correctCount: entry.correctCount + (result === "correct" || result === "remembered" ? 1 : 0),
              wrongCount: entry.wrongCount + (result === "wrong" ? 1 : 0),
              forgottenCount: entry.forgottenCount + (result === "forgotten" ? 1 : 0)
            }
          : entry
      );
      if (shouldComplete && !previewState.todaySession.completedIds.includes(entryId)) {
        previewState.todaySession.completedIds.push(entryId);
      }
      return recompute();
    },
    enrichEntry: async (entryId) => {
      previewState.entries = previewState.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              status: "needs-review",
              dictionaryLookupAttemptedAt: new Date().toISOString(),
              dictionaryNote: "Preview mode does not call external APIs."
            }
          : entry
      );
      return recompute();
    },
    listEntries: async ({ query = "", offset = 0, limit = LIBRARY_PAGE_SIZE } = {}) => {
      const normalized = String(query).trim().toLowerCase();
      const filtered = previewState.entries.filter((entry) => {
        if (!normalized) return true;
        return [entry.term, entry.userMeaning, entry.referenceMeaning, entry.notes]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      });
      return { entries: filtered.slice(offset, offset + limit), total: filtered.length };
    },
    listHistory: async () => ({
      entries: previewState.entries.filter((entry) => entry.seenCount > 0),
      total: previewState.entries.filter((entry) => entry.seenCount > 0).length
    }),
    getEntry: async (entryId) => previewState.entries.find((entry) => entry.id === entryId) ?? null,
    setWindowMode: async () => true,
    minimizeWindow: async () => true,
    quitApp: async () => true
  };
}

function makePreviewState() {
  const entries = seedEntries.map((entry) => ({
    ...entry,
    seenCount: 0,
    correctCount: 0,
    wrongCount: 0,
    forgottenCount: 0
  }));
  const todaySession = {
    date: "preview",
    entryIds: entries.slice(0, 5).map((entry) => entry.id),
    completedIds: []
  };
  return {
    settings: {
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
    },
    entries,
    todaySession,
    stats: {
      total: entries.length,
      ready: entries.filter((entry) => entry.status === "ready").length,
      needsReview: entries.filter((entry) => entry.status !== "ready").length,
      todayRemaining: 5
    },
    storageKind: "preview",
    dataPath: "Preview mode"
  };
}

// Prefer the clean offline ECDICT reference for quizzes so the (sometimes garbled)
// raw PDF meaning is never turned into a question or a distractor. Fall back to the
// user's own meaning only when no reference exists.
function quizMeaning(entry) {
  return entry?.referenceMeaning || entry?.userMeaning || "";
}

const MISSING_MEANING_PLACEHOLDER = "暂未填写释义，需要在词库中补全";

// Provenance tags that are useful for filtering/import bookkeeping but just clutter
// the study card.
const HIDDEN_TAGS = new Set(["Vocabulary.pdf"]);

function visibleTags(tags) {
  return (tags ?? []).filter((tag) => !HIDDEN_TAGS.has(tag));
}

// True when there is a clean ECDICT reference worth showing alongside the user's
// own (possibly messy) meaning.
function hasDistinctReference(entry) {
  return Boolean(
    entry?.userMeaning &&
      entry?.referenceMeaning &&
      entry.referenceMeaning !== entry.userMeaning
  );
}

// A meaning is only usable as a quiz option if it has real text once separators
// like "；" / "," are stripped. Garbled entries sometimes reduce to a lone
// semicolon, which must never become one of the four options.
function hasRealMeaning(meaning) {
  return String(meaning ?? "").replace(/[；;，,、\s/.|·]+/g, "").length > 0;
}

function shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function makeChoiceOptions(entry, entries) {
  const rawAnswer = quizMeaning(entry);
  const answer = hasRealMeaning(rawAnswer) ? rawAnswer : MISSING_MEANING_PLACEHOLDER;
  const seen = new Set([answer]);
  const pool = [];
  for (const item of entries) {
    if (item.id === entry.id) continue;
    const meaning = quizMeaning(item);
    if (!hasRealMeaning(meaning) || seen.has(meaning)) continue;
    seen.add(meaning);
    pool.push(meaning);
  }
  // Randomly pick three distractors so the wrong options vary each time instead
  // of always being the same alphabetically-first meanings.
  const chosen = shuffleInPlace(pool).slice(0, 3);
  // With hundreds of entries this fallback is essentially never hit, but keep a
  // readable placeholder rather than an empty / punctuation-only option.
  while (chosen.length < 3) chosen.push(MISSING_MEANING_PLACEHOLDER);

  const correctIndex = Math.floor(Math.random() * (chosen.length + 1));
  chosen.splice(correctIndex, 0, answer);
  return chosen.map((meaning, index) => ({
    key: String.fromCharCode(65 + index),
    meaning,
    correct: index === correctIndex
  }));
}

// Show up to three example sentences, always keeping at least one of the user's
// own examples in view so a manually added sentence is never hidden behind the
// dictionary's examples. Returns the original index so favoriting still works.
function pickDisplayExamples(examples, limit = 3) {
  const indexed = (examples ?? []).map((example, index) => ({ example, index }));
  const userOwned = indexed.filter((item) => item.example.userAdded);
  if (!userOwned.length) return indexed.slice(0, limit);
  const dictionary = indexed.filter((item) => !item.example.userAdded);
  const combined = [...dictionary.slice(0, Math.max(0, limit - userOwned.length)), ...userOwned];
  return combined.slice(0, limit);
}

function makeSpellModel(term) {
  const clean = term.toLowerCase().replace(/[^a-z]/g, "");
  if (clean.length <= 4) {
    return { pattern: clean, hidden: "", answer: clean, disabled: true };
  }
  const keepStart = Math.min(2, clean.length - 2);
  const keepEnd = Math.min(3, clean.length - keepStart - 1);
  const hiddenStart = keepStart;
  const hiddenEnd = clean.length - keepEnd;
  return {
    prefix: clean.slice(0, hiddenStart),
    suffix: clean.slice(hiddenEnd),
    hidden: clean.slice(hiddenStart, hiddenEnd),
    answer: clean,
    disabled: false
  };
}

function App() {
  const [state, setState] = useState(null);
  const [view, setView] = useState(() => {
    if (window.location.hash.includes("settings")) return "settings";
    if (window.location.hash.includes("completed")) return "completed";
    return "study";
  });
  const [settingsTab, setSettingsTab] = useState(() => {
    const match = window.location.hash.match(/tab=([a-z-]+)/);
    return match?.[1] || "plan";
  });
  const [studyOverride, setStudyOverride] = useState(() => {
    const match = window.location.hash.match(/mode=([a-z-]+)/);
    return modes.includes(match?.[1]) ? match[1] : null;
  });
  const [reviewEntryId, setReviewEntryId] = useState(null);
  const [isBusy, setIsBusy] = useState(false);
  const currentEntry = getTodayEntry(state);
  const currentIndex = getEntryIndex(state, currentEntry);
  const activeMode = studyOverride ?? (state?.settings?.mixModes ? modes[currentIndex % modes.length] : "card");

  function navigate(nextView) {
    setView(nextView);
    if (nextView !== "review") setReviewEntryId(null);
  }

  async function refresh() {
    setState(await api.getState());
  }

  async function runAction(action) {
    setIsBusy(true);
    try {
      const next = await action();
      setState(next);
      setStudyOverride(null);
    } finally {
      setIsBusy(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    api.setWindowMode?.(view === "settings" ? "settings" : "study");
  }, [view]);

  useEffect(() => {
    if (view !== "study" || !currentEntry || currentEntry.dictionaryLookupAttemptedAt) return;
    const isIncomplete =
      !currentEntry.referenceMeaning ||
      currentEntry.phonetics.length === 0 ||
      currentEntry.examples.length === 0;
    if (!isIncomplete) return;

    let cancelled = false;
    api.enrichEntry(currentEntry.id).then((nextState) => {
      if (!cancelled) setState(nextState);
    });
    return () => {
      cancelled = true;
    };
  }, [view, currentEntry?.id, currentEntry?.dictionaryLookupAttemptedAt]);

  if (!state) {
    return (
      <main className="loading-screen">
        <Loader2 className="spin" size={28} />
        <span>Loading vocabulary...</span>
      </main>
    );
  }

  return (
    <main className={classNames("app-shell", view === "settings" && "settings-mode")}>
      {view === "study" ? (
        <StudySurface
          state={state}
          entry={currentEntry}
          mode={activeMode}
          busy={isBusy}
          setMode={setStudyOverride}
          onNavigate={navigate}
          onFavorite={(entryId, exampleIndex) => runAction(() => api.favoriteExample({ entryId, exampleIndex }))}
          onRecord={(payload) => runAction(() => api.recordReview(payload))}
        />
      ) : view === "completed" ? (
        <CompletedSurface
          state={state}
          onNavigate={navigate}
          onSelect={(entryId) => {
            setReviewEntryId(entryId);
            setView("review");
          }}
        />
      ) : view === "review" ? (
        <StudySurface
          state={state}
          entry={state.entries.find((entry) => entry.id === reviewEntryId)}
          mode="card"
          busy={isBusy}
          setMode={setStudyOverride}
          isReview
          onNavigate={navigate}
          onFavorite={(entryId, exampleIndex) => runAction(() => api.favoriteExample({ entryId, exampleIndex }))}
          onRecord={(payload) => runAction(() => api.recordReview(payload))}
        />
      ) : (
        <SettingsSurface
          state={state}
          tab={settingsTab}
          setTab={setSettingsTab}
          onClose={() => navigate("study")}
          onSelect={(entryId) => {
            setReviewEntryId(entryId);
            setView("review");
          }}
          onUpdate={(partial) => runAction(() => api.updateSettings(partial))}
          onAdd={(input) => runAction(() => api.addEntry(input))}
          onEnrich={(entryId) => runAction(() => api.enrichEntry(entryId))}
          onUpdateEntry={(entryId, updates) => runAction(() => api.updateEntry({ entryId, updates }))}
          onDeleteEntry={(entryId) => runAction(() => api.deleteEntry(entryId))}
        />
      )}
    </main>
  );
}

function StudySurface({ state, entry, mode, busy, setMode, onNavigate, onFavorite, onRecord, isReview = false }) {
  if (!entry) {
    return <DoneCard state={state} onNavigate={onNavigate} />;
  }

  return (
    <section className="study-wrap">
      {mode === "choice" ? (
        <ChoiceCard state={state} entry={entry} busy={busy} setMode={setMode} onNavigate={onNavigate} onRecord={onRecord} />
      ) : mode === "spell" && entry.type === "word" ? (
        <SpellCard state={state} entry={entry} busy={busy} setMode={setMode} onNavigate={onNavigate} onRecord={onRecord} />
      ) : (
        <WordCard state={state} entry={entry} busy={busy} isReview={isReview} onNavigate={onNavigate} onFavorite={onFavorite} onRecord={onRecord} />
      )}
    </section>
  );
}

function CompactNav({ onNavigate, spaced = false }) {
  const studyGroup = (
    <>
      <button className="mini-nav-button icon-mini" onClick={() => onNavigate("study")} title="背词" aria-label="背词">
        <BookOpen size={14} />
      </button>
      <button className="mini-nav-button icon-mini" onClick={() => onNavigate("completed")} title="查看已背" aria-label="查看已背">
        <ListChecks size={14} />
      </button>
      <button className="mini-nav-button icon-mini" onClick={() => onNavigate("settings")} title="设置" aria-label="设置">
        <Settings size={15} />
      </button>
    </>
  );
  const windowGroup = (
    <>
      <button className="mini-nav-button icon-mini" onClick={() => api.minimizeWindow?.()} title="最小化" aria-label="最小化">
        <Minus size={14} />
      </button>
      <button className="mini-nav-button icon-mini" onClick={() => api.hideWindow?.()} title="收起到菜单栏（仍会定时提醒）" aria-label="收起">
        <X size={14} />
      </button>
    </>
  );

  if (spaced) {
    return (
      <div className="compact-nav compact-nav--spaced">
        <div className="compact-nav-group">{studyGroup}</div>
        <div className="compact-nav-group">{windowGroup}</div>
      </div>
    );
  }

  return (
    <div className="compact-nav">
      {studyGroup}
      <span className="nav-divider" aria-hidden="true" />
      {windowGroup}
    </div>
  );
}

function CardTop({ state, label, icon, onNavigate, isReview = false }) {
  const done = state.todaySession.completedIds.length;
  const total = state.todaySession.entryIds.length;
  return (
    <div className="card-top">
      <div className="card-top-left">
        <div className="progress-pill">
          <span className="green-dot" />
          {isReview ? "完整释义" : `今日 ${Math.min(done + 1, total)}/${total} · 剩 ${state.stats.todayRemaining}`}
        </div>
        <div className="mode-pill">
          {icon}
          {label}
        </div>
      </div>
      <CompactNav onNavigate={onNavigate} />
    </div>
  );
}

function Phonetics({ entry }) {
  const hasUk = entry.phonetics?.some((item) => item.region === "UK");
  return (
    <div className="phonetics-row">
      <span>
        {entry.phonetics?.[0]?.region || "美"} {firstPhonetic(entry)}
      </span>
      <button className="voice-button" onClick={() => playPronunciation(entry, "US")}>
        <Volume2 size={15} />
        US
      </button>
      <button className="voice-button" onClick={() => playPronunciation(entry, hasUk ? "UK" : "US")}>
        <Volume2 size={15} />
        UK
      </button>
    </div>
  );
}

function WordCard({ state, entry, busy, isReview = false, onNavigate, onFavorite, onRecord }) {
  return (
    <article className="word-card">
      <CardTop state={state} label={isReview ? "回看" : "展示"} icon={<BookOpen size={15} />} onNavigate={onNavigate} isReview={isReview} />
      <h1 className="word-title">{entry.term}</h1>
      <Phonetics entry={entry} />

      <section className="meaning-panel">
        <p className="meaning-main">
          {hasDistinctReference(entry) ? <span className="reference-chip your">你的释义</span> : null}
          <span>{entry.partOfSpeech}</span>
          {entry.userMeaning || entry.referenceMeaning || "还没有中文释义"}
        </p>
        {hasDistinctReference(entry) ? (
          <p className="meaning-reference">
            <span className="reference-chip">参考 · {entry.referenceSource || "ECDICT"}</span>
            {entry.referenceMeaning}
          </p>
        ) : null}
        <div className="tag-row">
          {visibleTags(entry.tags).map((tag) => (
            <span className="tag" key={tag}>
              {tag}
            </span>
          ))}
          {entry.forms.length ? (
            <span className="forms">
              变形 {entry.forms.map((form) => <strong key={form}>{form}</strong>)}
            </span>
          ) : null}
        </div>
      </section>

      <section className="examples-list">
        {pickDisplayExamples(entry.examples).map(({ example, index }) => (
          <article className="example-item" key={`${entry.id}-example-${index}`}>
            <div>
              <p className="example-en">{example.en}</p>
              {example.zh ? <p className="example-zh">{example.zh}</p> : null}
            </div>
            <button className={classNames("star-button", example.favorite && "active")} onClick={() => onFavorite(entry.id, index)}>
              <Star size={17} />
            </button>
          </article>
        ))}
      </section>

      <footer className="card-actions">
        {isReview ? (
          <>
            <button className="secondary-button" onClick={() => onNavigate("completed")}>返回已背</button>
            <button className="primary-button" onClick={() => onNavigate("study")}>继续背词</button>
          </>
        ) : (
          <>
            <button className="secondary-button" disabled={busy} onClick={() => onRecord({ entryId: entry.id, mode: "card", result: "forgotten" })}>
              不记得
            </button>
            <button className="primary-button" disabled={busy} onClick={() => onRecord({ entryId: entry.id, mode: "card", result: "remembered" })}>
              我记住了
            </button>
          </>
        )}
      </footer>
    </article>
  );
}

function ChoiceCard({ state, entry, busy, setMode, onNavigate, onRecord }) {
  const [selected, setSelected] = useState(null);
  const options = useMemo(() => makeChoiceOptions(entry, state.entries), [entry, state.entries]);

  async function selectOption(option) {
    if (selected) return;
    setSelected(option);
    await onRecord({
      entryId: entry.id,
      mode: "choice",
      result: option.correct ? "correct" : "wrong"
    });
  }

  return (
    <article className="word-card quiz-card">
      <CardTop state={state} label="选择" icon={<FilePlus2 size={15} />} onNavigate={onNavigate} />
      <p className="question-label">这个单词是什么意思？</p>
      <h1 className="word-title">{entry.term}</h1>
      <div className="quiz-pron">
        <span className="quiz-subtitle">{firstPhonetic(entry)} · {entry.partOfSpeech || entry.type}</span>
        <button className="voice-button" onClick={() => playPronunciation(entry, "US")}>
          <Volume2 size={14} />
          US
        </button>
        <button className="voice-button" onClick={() => playPronunciation(entry, entry.phonetics?.some((item) => item.region === "UK") ? "UK" : "US")}>
          <Volume2 size={14} />
          UK
        </button>
      </div>

      <section className="options-list">
        {options.map((option) => (
          <button
            key={option.key}
            className={classNames(
              "option-button",
              selected && option.correct && "correct",
              selected?.key === option.key && !option.correct && "wrong"
            )}
            onClick={() => selectOption(option)}
          >
            <span>{option.key}</span>
            {option.meaning}
          </button>
        ))}
      </section>

      {selected ? (
        <section className="answer-callout">
          <strong>正确答案</strong>
          <p>{quizMeaning(entry) || MISSING_MEANING_PLACEHOLDER}</p>
          {hasDistinctReference(entry) ? <p className="answer-your">你的释义：{entry.userMeaning}</p> : null}
        </section>
      ) : null}

      <footer className="card-actions">
        <button className="secondary-button" disabled={busy} onClick={() => onRecord({ entryId: entry.id, mode: "choice", result: "forgotten" })}>
          不记得
        </button>
        <button className="primary-button" disabled={!selected || busy} onClick={() => setMode("card")}>
          看完整卡片
        </button>
      </footer>
    </article>
  );
}

function SpellCard({ state, entry, busy, setMode, onNavigate, onRecord }) {
  const model = useMemo(() => makeSpellModel(entry.term), [entry.term]);
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const correct = value.toLowerCase() === model.hidden;

  async function submit() {
    if (!value) return;
    setSubmitted(true);
    await onRecord({
      entryId: entry.id,
      mode: "spell",
      result: correct ? "correct" : "wrong"
    });
  }

  return (
    <article className="word-card spell-card">
      <CardTop state={state} label="拼写" icon={<PencilLine size={15} />} onNavigate={onNavigate} />
      <p className="question-label">根据中文释义补全单词</p>

      <section className="meaning-panel prompt-panel">
        <p className="meaning-main">{quizMeaning(entry) || entry.userMeaning}</p>
      </section>

      <div className="spell-pattern">
        <span>{model.prefix}</span>
        <span className="spell-blank">{"_".repeat(Math.max(2, model.hidden.length))}</span>
        <span>{model.suffix}</span>
      </div>

      <input
        className={classNames("spell-input", submitted && (correct ? "correct" : "wrong"))}
        value={value}
        onChange={(event) => setValue(event.target.value.replace(/[^a-zA-Z]/g, "").slice(0, model.hidden.length))}
        placeholder={`填写 ${model.hidden.length} 个字母`}
      />
      <p className="hint-line">提示：保留首尾字母，隐藏中间部分字母。</p>

      {submitted ? (
        <section className="answer-callout">
          <strong>{correct ? "拼写正确" : "正确拼写"}</strong>
          <p>
            {entry.term} · {firstPhonetic(entry)} · {entry.examples?.[0]?.en}
          </p>
        </section>
      ) : null}

      <footer className="card-actions with-icon">
        <button className="icon-only-button" onClick={() => playPronunciation(entry, "US")}>
          <Headphones size={17} />
        </button>
        <button className="secondary-button" disabled={busy} onClick={() => onRecord({ entryId: entry.id, mode: "spell", result: "forgotten" })}>
          不记得
        </button>
        <button className="primary-button" disabled={busy} onClick={submitted ? () => setMode("card") : submit}>
          {submitted ? "看完整卡片" : "提交"}
        </button>
      </footer>
    </article>
  );
}

function DoneCard({ state, onNavigate }) {
  return (
    <article className="done-card">
      <CompactNav onNavigate={onNavigate} spaced />
      <Check size={34} />
      <h1>今天的队列完成了</h1>
      <p>你已经处理完 {state.todaySession.entryIds.length} 个单词/短语。明天会尽量避开今天和昨天重复的词。</p>
      <button className="primary-button" onClick={() => onNavigate("completed")}>查看今天已背</button>
    </article>
  );
}

function CompletedSurface({ state, onNavigate, onSelect }) {
  const completedIds = new Set(state.todaySession.completedIds);
  const completedToday = state.todaySession.entryIds
    .map((id) => state.entries.find((entry) => entry.id === id))
    .filter((entry) => entry && completedIds.has(entry.id));

  return (
    <section className="study-wrap completed-scroll">
      <article className="completed-card">
        <div className="card-top compact-list-top">
          <div>
            <div className="progress-pill"><span className="green-dot" />已背词</div>
            <p className="compact-subtitle">点击任意词可以回看完整释义和例句。</p>
          </div>
          <CompactNav onNavigate={onNavigate} />
        </div>

        <CompletedGroup title="今天完成" entries={completedToday} onSelect={onSelect} emptyText="今天还没有处理过的词。" />
      </article>
    </section>
  );
}

function CompletedGroup({ title, entries, onSelect, emptyText }) {
  return (
    <section className="completed-group">
      <h2>{title}</h2>
      {entries.length ? (
        <div className="completed-list">
          {entries.map((entry) => (
            <button className="completed-row" key={entry.id} onClick={() => onSelect(entry.id)}>
              <span>{entry.term}</span>
              <small>{entry.userMeaning || entry.referenceMeaning}</small>
            </button>
          ))}
        </div>
      ) : (
        <p className="empty-text">{emptyText}</p>
      )}
    </section>
  );
}

function SettingsSurface({ state, tab, setTab, onClose, onSelect, onUpdate, onAdd, onEnrich, onUpdateEntry, onDeleteEntry }) {
  return (
    <section className="settings-window">
      <aside className="settings-sidebar">
        <SettingsNavItem active={tab === "plan"} icon={<CalendarCheck size={17} />} label="今日计划" onClick={() => setTab("plan")} />
        <SettingsNavItem active={tab === "library"} icon={<BookOpen size={17} />} label="词库管理" onClick={() => setTab("library")} />
        <SettingsNavItem active={tab === "favorites"} icon={<Star size={17} />} label="收藏例句" onClick={() => setTab("favorites")} />
        <SettingsNavItem active={tab === "history"} icon={<History size={17} />} label="复习记录" onClick={() => setTab("history")} />
        <SettingsNavItem active={tab === "dictionary"} icon={<Database size={17} />} label="词典来源" onClick={() => setTab("dictionary")} />
      </aside>
      <section className="settings-content">
        <button className="settings-close" onClick={onClose} title="返回背词">
          <X size={18} />
        </button>
        {tab === "plan" ? <PlanSettings state={state} onUpdate={onUpdate} /> : null}
        {tab === "library" ? (
          <LibrarySettings
            state={state}
            onAdd={onAdd}
            onEnrich={onEnrich}
            onSelect={onSelect}
            onUpdateEntry={onUpdateEntry}
            onDeleteEntry={onDeleteEntry}
          />
        ) : null}
        {tab === "favorites" ? <FavoritesSettings state={state} /> : null}
        {tab === "history" ? <HistorySettings state={state} /> : null}
        {tab === "dictionary" ? <DictionarySettings state={state} onUpdate={onUpdate} /> : null}
      </section>
    </section>
  );
}

function SettingsNavItem({ active, icon, label, onClick }) {
  return (
    <button className={classNames("settings-nav-item", active && "active")} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function PlanSettings({ state, onUpdate }) {
  const settings = state.settings;
  return (
    <>
      <SettingsHeader title="今日计划" subtitle="今日队列会按设置数量轮完，处理过才进入下一个。" badge={`今日还剩 ${state.stats.todayRemaining} 个`} />
      <section className="settings-section">
        <div className="goal-row">
          <div>
            <label>每日轮番单词量</label>
            <input
              className="range"
              type="range"
              min="1"
              max="30"
              value={settings.dailyGoal}
              onChange={(event) => onUpdate({ dailyGoal: Number(event.target.value) })}
            />
          </div>
          <div className="goal-box">
            <strong>{settings.dailyGoal}</strong>
            <span>个 / 天</span>
          </div>
        </div>

        <div className="two-col">
          <TextField label="活跃开始" value={settings.activeStart} onChange={(value) => onUpdate({ activeStart: value })} />
          <TextField label="活跃结束" value={settings.activeEnd} onChange={(value) => onUpdate({ activeEnd: value })} />
        </div>

        <ToggleRow title="定时弹出提醒" subtitle="在活跃时间内，每隔一段时间自动弹出窗口提醒背词。" checked={settings.reminderEnabled} onChange={(checked) => onUpdate({ reminderEnabled: checked })} />
        <div className="two-col">
          <TextField label="提醒间隔（分钟）" value={String(settings.reminderMinutes ?? 30)} onChange={(value) => onUpdate({ reminderMinutes: Number(value) || 30 })} />
        </div>

        <ToggleRow title="尽量避开昨天出现过的词" subtitle="错题和“不记得”的词仍可被优先安排。" checked={settings.avoidYesterday} onChange={(checked) => onUpdate({ avoidYesterday: checked })} />
        <ToggleRow title="混合三种模式" subtitle="词卡展示、选择释义、根据释义拼写单词。" checked={settings.mixModes} onChange={(checked) => onUpdate({ mixModes: checked })} />
      </section>

      <section className="info-list">
        <InfoRow title="今日队列" text={state.todaySession.entryIds.map((id) => state.entries.find((entry) => entry.id === id)?.term).filter(Boolean).join(" · ")} />
      </section>
    </>
  );
}

function LibrarySettings({ state, onAdd, onEnrich, onSelect, onUpdateEntry, onDeleteEntry }) {
  const [form, setForm] = useState({ term: "", userMeaning: "", notes: "", example: "" });
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [page, setPage] = useState(0);
  const [library, setLibrary] = useState({ entries: [], total: 0 });
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [managingId, setManagingId] = useState(null);
  const [previewId, setPreviewId] = useState(null);
  const [managingEntry, setManagingEntry] = useState(null);
  const [previewEntry, setPreviewEntry] = useState(null);
  const pageCount = Math.max(1, Math.ceil(library.total / LIBRARY_PAGE_SIZE));

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query);
      setPage(0);
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    setLoadingLibrary(true);
    api
      .listEntries({ query: debouncedQuery, offset: page * LIBRARY_PAGE_SIZE, limit: LIBRARY_PAGE_SIZE })
      .then((result) => {
        if (!cancelled) setLibrary(result);
      })
      .finally(() => {
        if (!cancelled) setLoadingLibrary(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, page, state.stats.total]);

  useEffect(() => {
    if (!managingId) {
      setManagingEntry(null);
      return;
    }
    api.getEntry(managingId).then((entry) => setManagingEntry(entry));
  }, [managingId]);

  useEffect(() => {
    if (!previewId) {
      setPreviewEntry(null);
      return;
    }
    api.getEntry(previewId).then((entry) => setPreviewEntry(entry));
  }, [previewId]);

  function updateForm(key, value) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    await onAdd(form);
    setForm({ term: "", userMeaning: "", notes: "", example: "" });
  }

  return (
    <>
      <SettingsHeader title="词库管理" subtitle={`本地 ${state.storageKind.toUpperCase()} 保存；Obsidian、CSV、PDF 导入后会先去重。`} badge={`${state.stats.total} 条`} />

      <form className="add-form" onSubmit={submit}>
        <div className="two-col">
          <TextField label="单词 / 短语" value={form.term} onChange={(value) => updateForm("term", value)} placeholder="例如 equilibrium" />
          <TextField label="你的中文释义" value={form.userMeaning} onChange={(value) => updateForm("userMeaning", value)} placeholder="例如 平衡；均衡" />
        </div>
        <label>
          例句（可选）
          <textarea
            value={form.example}
            onChange={(event) => updateForm("example", event.target.value)}
            placeholder={"英文例句和中文释义写在同一个框里，换行或用 / 分隔。\n例如：\nShe kept her equilibrium under pressure.\n她在压力下保持镇定。"}
          />
          <span className="field-hint">词典里有例句会一起显示；词典没有例句时只显示这里填写的例句。</span>
        </label>
        <label>
          个人语境
          <textarea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} placeholder="这个词为什么进入你的词库？常在哪些工作场景遇到？" />
        </label>
        <button className="primary-button inline-submit" type="submit">
          <Plus size={16} />
          保存到词库
        </button>
      </form>

      <div className="search-box">
        <Search size={16} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索单词、短语或释义" />
      </div>

      <div className="database-summary">
        <span>
          显示 {library.entries.length} / {library.total} 条
          {loadingLibrary ? " · 加载中…" : ""}
        </span>
        <span className="database-kind">{state.storageKind.toUpperCase()}</span>
      </div>
      <div className="database-path" title={state.dataPath}>
        <Database size={15} />
        <code>{databaseFileName(state.dataPath)}</code>
      </div>

      <div className="library-pagination">
        <button className="secondary-button" type="button" disabled={page <= 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>
          上一页
        </button>
        <span>
          第 {page + 1} / {pageCount} 页
        </span>
        <button
          className="secondary-button"
          type="button"
          disabled={page + 1 >= pageCount}
          onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
        >
          下一页
        </button>
      </div>

      <section className="library-list database-list">
        {library.entries.map((entry) => (
          <article className="library-row" key={entry.id}>
            <button className="library-entry-button" type="button" onClick={() => setPreviewId(entry.id)}>
              <div className="library-term-line">
                <h3>{entry.term}</h3>
                <span className={classNames("status-chip", entry.importWarnings?.length && "warning")}>
                  {entryStatusLabel(entry)}
                </span>
              </div>
              <p>{entry.userMeaning || entry.referenceMeaning || "中文释义待补全"}</p>
              {hasDistinctReference(entry) ? (
                <p className="library-source-meaning">参考 · {entry.referenceSource || "ECDICT"}：{entry.referenceMeaning}</p>
              ) : null}
              <div className="library-meta">
                <span>{entry.type === "phrase" ? "短语" : "单词"}</span>
                <span>复习 {entry.seenCount} 次</span>
                <span>入队 {entry.queuedCount} 次</span>
                <span>{formatReviewDate(entry.nextReviewAt)}</span>
                {entry.importWarnings?.length ? <span>导入提示 {entry.importWarnings.length} 条</span> : null}
              </div>
            </button>
            <div className="library-row-actions">
              <button className="small-button" type="button" onClick={() => onEnrich(entry.id)}>
                <RefreshCw size={14} />
                补全
              </button>
              <button className="small-button" type="button" onClick={() => setManagingId(entry.id)}>
                <SlidersHorizontal size={14} />
                管理
              </button>
            </div>
          </article>
        ))}
        {!loadingLibrary && !library.entries.length ? <p className="empty-text">没有找到匹配的词条。</p> : null}
      </section>

      {previewEntry ? <WordPreviewModal entry={previewEntry} onClose={() => setPreviewId(null)} /> : null}

      {managingEntry ? (
        <ManageEntryModal
          entry={managingEntry}
          onClose={() => setManagingId(null)}
          onUpdateEntry={onUpdateEntry}
          onDeleteEntry={onDeleteEntry}
        />
      ) : null}
    </>
  );
}

function splitExample(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\r?\n|\s*[|｜]\s*|\s+\/\s+/);
  const en = (parts.shift() ?? "").trim();
  const zh = parts.join(" ").trim();
  if (!en) return null;
  return { en, zh, favorite: false, needsTranslation: false, userAdded: true };
}

function ManageEntryModal({ entry, onClose, onUpdateEntry, onDeleteEntry }) {
  const [userMeaning, setUserMeaning] = useState(entry.userMeaning || "");
  const [notes, setNotes] = useState(entry.notes || "");
  const [examples, setExamples] = useState(() => (entry.examples ?? []).map((example) => ({ ...example })));
  const [newExample, setNewExample] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  function addExample() {
    const parsed = splitExample(newExample);
    if (!parsed) return;
    setExamples((current) => [...current, parsed]);
    setNewExample("");
  }

  function removeExample(index) {
    setExamples((current) => current.filter((_, i) => i !== index));
  }

  async function save() {
    setSaving(true);
    try {
      await onUpdateEntry(entry.id, { userMeaning, notes, examples });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setSaving(true);
    try {
      await onDeleteEntry(entry.id);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{entry.term}</h2>
            <p>修改释义、管理例句，或删除这个词条。改动会同步到本地数据库。</p>
          </div>
          <button className="settings-close modal-close" onClick={onClose} title="关闭">
            <X size={18} />
          </button>
        </header>

        <div className="modal-body">
          <label>
            中文释义
            <textarea value={userMeaning} onChange={(event) => setUserMeaning(event.target.value)} placeholder="填写或修改你的中文释义" />
          </label>

          {entry.referenceMeaning && entry.referenceMeaning !== userMeaning ? (
            <p className="modal-reference">参考 · {entry.referenceSource || "ECDICT"}：{entry.referenceMeaning}</p>
          ) : null}

          <div className="modal-section">
            <h3>例句</h3>
            {examples.length ? (
              <ul className="manage-example-list">
                {examples.map((example, index) => (
                  <li className="manage-example-item" key={`${entry.id}-manage-example-${index}`}>
                    <div>
                      <p className="example-en">{example.en}</p>
                      {example.zh ? <p className="example-zh">{example.zh}</p> : null}
                      {example.userAdded ? <span className="example-flag">我添加的</span> : null}
                    </div>
                    <button className="icon-only-button danger-icon" type="button" onClick={() => removeExample(index)} title="删除例句">
                      <Trash2 size={15} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty-text">还没有例句，在下面添加一条。</p>
            )}

            <label>
              添加例句
              <textarea
                value={newExample}
                onChange={(event) => setNewExample(event.target.value)}
                placeholder={"英文例句和中文释义写在同一个框里，换行或用 / 分隔。"}
              />
            </label>
            <button className="small-button modal-add-example" type="button" onClick={addExample} disabled={!splitExample(newExample)}>
              <Plus size={14} />
              添加到例句
            </button>
          </div>

          <label>
            个人语境
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="为什么记录这个词？" />
          </label>
        </div>

        <footer className="modal-actions">
          {confirmingDelete ? (
            <div className="modal-confirm">
              <span>确定删除「{entry.term}」？此操作不可撤销。</span>
              <div>
                <button className="small-button" type="button" disabled={saving} onClick={() => setConfirmingDelete(false)}>取消</button>
                <button className="small-button delete-button" type="button" disabled={saving} onClick={remove}>确认删除</button>
              </div>
            </div>
          ) : (
            <>
              <button className="small-button delete-button" type="button" disabled={saving} onClick={() => setConfirmingDelete(true)}>
                <Trash2 size={14} />
                删除单词
              </button>
              <button className="primary-button" type="button" disabled={saving} onClick={save}>
                {saving ? "保存中…" : "保存修改"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function FavoritesSettings({ state }) {
  const [entries, setEntries] = useState([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const collected = [];
      let offset = 0;
      const limit = 200;
      while (!cancelled) {
        const page = await api.listEntries({ offset, limit });
        collected.push(...page.entries);
        offset += page.entries.length;
        if (offset >= page.total || !page.entries.length) break;
      }
      if (!cancelled) setEntries(collected);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [state.stats.total]);

  const favorites = entries.flatMap((entry) =>
    entry.examples
      .map((example, index) => ({ ...example, entry, index }))
      .filter((example) => example.favorite)
  );
  return (
    <>
      <SettingsHeader title="收藏例句" subtitle="把你觉得值得反复模仿的句子沉淀下来。" badge={`${favorites.length} 条`} />
      <section className="info-list">
        {favorites.length ? favorites.map((example) => <InfoRow key={`${example.entry.id}-${example.index}`} title={example.entry.term} text={`${example.en} / ${example.zh}`} />) : <InfoRow title="还没有收藏" text="在单词卡片里点星标后，这里会出现收藏例句。" />}
      </section>
    </>
  );
}

function HistorySettings({ state }) {
  const [previewId, setPreviewId] = useState(null);
  const [previewEntry, setPreviewEntry] = useState(null);
  const [history, setHistory] = useState({ entries: [], total: 0 });

  useEffect(() => {
    api.listHistory({ offset: 0, limit: 200 }).then(setHistory);
  }, [state.stats.total]);

  useEffect(() => {
    if (!previewId) {
      setPreviewEntry(null);
      return;
    }
    api.getEntry(previewId).then((entry) => setPreviewEntry(entry));
  }, [previewId]);

  return (
    <>
      <SettingsHeader title="复习记录" subtitle="只统计已经背过的词；最新复习的排在最前，点击任意单词可查看单词卡。" badge={`${history.total} 个`} />
      <section className="library-list database-list history-list">
        {history.entries.map((entry) => (
          <article className="library-row" key={entry.id}>
            <button className="library-entry-button" type="button" onClick={() => setPreviewId(entry.id)}>
              <div className="library-term-line">
                <h3>{entry.term}</h3>
                <span className="status-chip">已复习</span>
              </div>
              <p>{entry.userMeaning || entry.referenceMeaning || "中文释义待补全"}</p>
              <div className="library-meta">
                <span>答错 {entry.wrongCount}</span>
                <span>不记得 {entry.forgottenCount}</span>
                <span>记住 {entry.correctCount}</span>
                <span>复习 {entry.seenCount} 次</span>
              </div>
            </button>
          </article>
        ))}
        {!history.entries.length ? <p className="empty-text">还没有复习记录，背过的词会出现在这里。</p> : null}
      </section>
      {previewEntry ? <WordPreviewModal entry={previewEntry} onClose={() => setPreviewId(null)} /> : null}
    </>
  );
}

function WordPreviewModal({ entry, onClose }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card word-preview-card" onClick={(event) => event.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>{entry.term}</h2>
            <p>{[entry.partOfSpeech, firstPhonetic(entry)].filter(Boolean).join(" · ")}</p>
          </div>
          <button className="nav-button icon-mini modal-close" type="button" onClick={onClose} title="关闭" aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <Phonetics entry={entry} />

          <section className="meaning-panel">
            <p className="meaning-main">
              {hasDistinctReference(entry) ? <span className="reference-chip your">你的释义</span> : null}
              {entry.partOfSpeech ? <span>{entry.partOfSpeech}</span> : null}
              {entry.userMeaning || entry.referenceMeaning || "还没有中文释义"}
            </p>
            {hasDistinctReference(entry) ? (
              <p className="meaning-reference">
                <span className="reference-chip">参考 · {entry.referenceSource || "ECDICT"}</span>
                {entry.referenceMeaning}
              </p>
            ) : null}
          </section>

          {pickDisplayExamples(entry.examples).length ? (
            <section className="examples-list">
              {pickDisplayExamples(entry.examples).map(({ example, index }) => (
                <article className="example-item" key={`${entry.id}-preview-${index}`}>
                  <div>
                    <p className="example-en">{example.en}</p>
                    {example.zh ? <p className="example-zh">{example.zh}</p> : null}
                  </div>
                </article>
              ))}
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DictionarySettings({ state, onUpdate }) {
  return (
    <>
      <SettingsHeader title="词典来源" subtitle="离线 ECDICT 提供中文参考释义和音标；在线免费词典只补发音和例句。你的释义始终保留。" badge={state.settings.dictionaryProvider} />
      <section className="settings-section">
        <InfoRow title="ECDICT 本地词典（MIT 许可）" text="离线英汉词典，作为中文参考释义和音标来源；不会覆盖你的 PDF 释义，也不联网。" pill="离线" />
        <InfoRow title="Free Dictionary API" text="无需 key；只用于补充发音音频和例句，不提供中文释义。" pill="已启用" />
        <InfoRow title="Merriam-Webster Learner's Dictionary API" text="可选免费 key；用于更好的发音和例句。填入 key 后会优先查询。" />
        <TextField
          label="Merriam-Webster API Key"
          value={state.settings.merriamWebsterKey}
          onChange={(value) => onUpdate({ merriamWebsterKey: value })}
          placeholder="暂不填写也可以"
        />
        <ToggleRow title="开机自启动" subtitle="正式安装后会跟随系统启动。" checked={state.settings.autostart} onChange={(checked) => onUpdate({ autostart: checked })} />
      </section>
    </>
  );
}

function SettingsHeader({ title, subtitle, badge }) {
  return (
    <header className="settings-header">
      <div>
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </div>
      {badge ? <span className="badge">{badge}</span> : null}
    </header>
  );
}

function TextField({ label, value, onChange, placeholder }) {
  return (
    <label>
      {label}
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
    </label>
  );
}

function ToggleRow({ title, subtitle, checked, onChange }) {
  return (
    <article className="toggle-row">
      <div>
        <h3>{title}</h3>
        <p>{subtitle}</p>
      </div>
      <button className={classNames("switch", checked && "on")} onClick={() => onChange(!checked)} aria-label={title}>
        <span />
      </button>
    </article>
  );
}

function InfoRow({ title, text, pill }) {
  return (
    <article className="info-row">
      <div>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
      {pill ? <span className="status-chip">{pill}</span> : null}
    </article>
  );
}

createRoot(document.getElementById("root")).render(<App />);
