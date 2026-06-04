import { lookupEcdict } from "./ecdict.js";

const FREE_DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
const MERRIAM_LEARNER_URL = "https://www.dictionaryapi.com/api/v3/references/learners/json/";
const LOOKUP_TIMEOUT_MS = 8000;

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAudioUrl(value) {
  const audio = cleanText(value);
  if (audio.startsWith("//")) return `https:${audio}`;
  return audio;
}

function inferAudioRegion(audio) {
  const normalized = audio.toLowerCase();
  if (/[_/-](?:us|usa)[_.-]/.test(normalized)) return "US";
  if (/[_/-](?:gb|uk)[_.-]/.test(normalized)) return "UK";
  return "EN";
}

function uniquePhonetics(phonetics) {
  const seen = new Set();
  return phonetics.filter((phonetic) => {
    const key = `${phonetic.region}|${phonetic.text}|${phonetic.audio}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(phonetic.text || phonetic.audio);
  });
}

function pickExamples(meanings) {
  const examples = [];
  for (const meaning of meanings ?? []) {
    for (const definition of meaning.definitions ?? []) {
      if (definition.example && examples.length < 2) {
        examples.push({
          en: definition.example,
          zh: "",
          favorite: false,
          needsTranslation: true
        });
      }
    }
  }
  return examples;
}

function cleanMerriamText(value) {
  return cleanText(value)
    .replace(/\{(?:a_link|d_link|i_link|et_link|mat|sx)\|([^|}]*)[^}]*\}/g, "$1")
    .replace(/\{(?:ldquo|rdquo)\}/g, "\"")
    .replace(/\{(?:lsquo|rsquo)\}/g, "'")
    .replace(/\{[^}]+\}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function collectMerriamExamples(value, examples = []) {
  if (examples.length >= 2 || value == null) return examples;
  if (Array.isArray(value)) {
    if (value[0] === "vis" && Array.isArray(value[1])) {
      for (const item of value[1]) {
        const text = cleanMerriamText(item?.t);
        if (text && examples.length < 2) {
          examples.push({ en: text, zh: "", favorite: false, needsTranslation: true });
        }
      }
      return examples;
    }
    for (const item of value) collectMerriamExamples(item, examples);
    return examples;
  }
  if (typeof value === "object") {
    if (Array.isArray(value.vis)) {
      for (const item of value.vis) {
        const text = cleanMerriamText(item?.t);
        if (text && examples.length < 2) {
          examples.push({ en: text, zh: "", favorite: false, needsTranslation: true });
        }
      }
    }
    for (const item of Object.values(value)) collectMerriamExamples(item, examples);
  }
  return examples;
}

function merriamAudioUrl(audioValue) {
  const audio = cleanText(audioValue);
  if (!audio) return "";
  let subdirectory = audio[0].toLowerCase();
  if (audio.startsWith("bix")) subdirectory = "bix";
  else if (audio.startsWith("gg")) subdirectory = "gg";
  else if (!/[a-z]/i.test(audio[0])) subdirectory = "number";
  return `https://media.merriam-webster.com/audio/prons/en/us/mp3/${subdirectory}/${audio}.mp3`;
}

function parseFreeDictionary(payload) {
  const first = Array.isArray(payload) ? payload[0] : null;
  if (!first) return null;

  const phonetics = [];
  for (const phonetic of first.phonetics ?? []) {
    const text = cleanText(phonetic.text);
    const audio = normalizeAudioUrl(phonetic.audio);
    if (!text && !audio) continue;
    phonetics.push({
      region: inferAudioRegion(audio),
      text,
      audio
    });
  }
  if (!phonetics.length && cleanText(first.phonetic)) {
    phonetics.push({ region: "EN", text: cleanText(first.phonetic), audio: "" });
  }

  const meanings = first.meanings ?? [];
  const primaryMeaning = meanings[0];
  const firstDefinition = primaryMeaning?.definitions?.[0]?.definition ?? "";

  return {
    source: "Free Dictionary API",
    sourceMeaning: cleanText(firstDefinition),
    partOfSpeech: cleanText(primaryMeaning?.partOfSpeech),
    phonetics: uniquePhonetics(phonetics),
    examples: pickExamples(meanings),
    status: phonetics.length || firstDefinition ? "needs-review" : "pending"
  };
}

function parseMerriam(payload) {
  const first = Array.isArray(payload) ? payload.find((item) => typeof item === "object") : null;
  if (!first) return null;

  const shortdef = Array.isArray(first.shortdef) ? first.shortdef[0] : "";
  const phonetics = uniquePhonetics(
    (first.hwi?.prs ?? []).map((pronunciation) => ({
      region: "US",
      text: pronunciation.ipa ? `/${pronunciation.ipa}/` : "",
      audio: merriamAudioUrl(pronunciation.sound?.audio)
    }))
  );

  return {
    source: "Merriam-Webster Learner's Dictionary API",
    sourceMeaning: cleanText(shortdef),
    partOfSpeech: cleanText(first.fl),
    phonetics,
    examples: collectMerriamExamples(first),
    status: shortdef || phonetics.length ? "needs-review" : "pending"
  };
}

async function fetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) return null;
  return response.json();
}

async function lookupOnline(normalized, settings) {
  const merriamKey = cleanText(settings.merriamWebsterKey);
  if (merriamKey) {
    try {
      const payload = await fetchJson(
        `${MERRIAM_LEARNER_URL}${encodeURIComponent(normalized)}?key=${encodeURIComponent(merriamKey)}`
      );
      const parsed = parseMerriam(payload);
      if (parsed) return parsed;
    } catch (error) {
      console.warn("Merriam-Webster lookup failed:", error);
    }
  }

  try {
    const payload = await fetchJson(`${FREE_DICTIONARY_URL}${encodeURIComponent(normalized)}`);
    const parsed = parseFreeDictionary(payload);
    if (parsed) return parsed;
  } catch (error) {
    console.warn("Free Dictionary lookup failed:", error);
  }

  return null;
}

// Online phonetics carry the audio; the offline ECDICT phonetic is a reliable text
// fallback. Keep audio-bearing entries and make sure at least one has IPA text.
function mergePhonetics(onlinePhonetics, offlinePhonetics) {
  const online = onlinePhonetics ?? [];
  const offline = offlinePhonetics ?? [];
  if (!online.length) return uniquePhonetics(offline);

  const offlineText = offline.find((item) => item.text)?.text || "";
  const filled = online.map((item) =>
    item.text ? item : { ...item, text: offlineText }
  );
  const hasText = filled.some((item) => item.text);
  if (!hasText && offlineText) {
    filled.push({ region: "US", text: offlineText, audio: "" });
  }
  return uniquePhonetics(filled);
}

export async function enrichTerm(term, settings = {}) {
  const normalized = cleanText(term).toLowerCase();
  if (!normalized) {
    return { status: "pending", error: "Missing term." };
  }

  // 1. Offline ECDICT (MIT) is the authoritative source for the Chinese reference
  //    meaning and phonetic. It never sees the network and never overwrites the
  //    user's own meaning.
  const offline = lookupEcdict(term);

  // 2. Free online dictionaries only contribute pronunciation audio and examples
  //    (plus an English gloss as a bonus). The vocabulary list is never sent to a
  //    paid service.
  const online = await lookupOnline(normalized, settings);

  if (!offline && !online) {
    return {
      status: "pending",
      source: "none",
      note: "No dictionary result found. System US and UK text-to-speech remain available; review the entry manually.",
      phonetics: [],
      examples: []
    };
  }

  const sourceLabels = [offline ? "ECDICT (offline)" : null, online?.source].filter(Boolean);

  return {
    referenceMeaning: offline?.referenceMeaning || "",
    referenceSource: offline?.referenceMeaning ? "ECDICT" : "",
    // English definitions are intentionally not stored: ECDICT supplies the
    // authoritative Chinese meaning, and online sources are limited to
    // pronunciation audio and example sentences (their English "first sense" is
    // often an obscure one, e.g. gross -> "twelve dozen = 144").
    sourceMeaning: "",
    partOfSpeech: online?.partOfSpeech || offline?.partOfSpeech || "",
    phonetics: mergePhonetics(online?.phonetics, offline?.phonetics),
    examples: online?.examples ?? [],
    status: "needs-review",
    source: sourceLabels.join(" + ") || "none"
  };
}
