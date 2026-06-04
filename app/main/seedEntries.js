import importedVocabulary from "./importedVocabulary.json" with { type: "json" };

const detailedSeedEntries = [
  {
    id: "equilibrium",
    term: "equilibrium",
    type: "word",
    userMeaning: "平衡，均衡；（心情的）平静，心理平衡；（经济）（供求的）平衡；（化）平衡；能量均分",
    sourceMeaning: "a state in which opposing forces or influences are balanced",
    partOfSpeech: "n.",
    phonetics: [
      { region: "US", text: "/ˌiːkwəˈlɪbriəm/", audio: "" },
      { region: "UK", text: "/ˌiːkwɪˈlɪbriəm/", audio: "" }
    ],
    forms: ["equilibria", "equilibriums"],
    tags: ["GRE", "GMAT", "SAT", "商务英语"],
    notes: "在论文或工作汇报中常用，描述系统达到稳定状态。",
    examples: [
      {
        en: "The market eventually reached a new equilibrium.",
        zh: "市场最终达到了新的均衡状态。",
        favorite: false
      },
      {
        en: "She paused for a moment to recover her equilibrium.",
        zh: "她停顿了一会儿，让自己重新恢复平静。",
        favorite: false
      }
    ],
    status: "ready"
  },
  {
    id: "reconcile",
    term: "reconcile",
    type: "word",
    userMeaning: "调和，使协调一致；使和解；核对账目",
    sourceMeaning: "to make two different ideas, facts, or situations agree with each other",
    partOfSpeech: "v.",
    phonetics: [{ region: "US", text: "/ˈrekənsaɪl/", audio: "" }],
    forms: ["reconciled", "reconciling"],
    tags: ["工作表达"],
    notes: "常用于 reconcile differences / reconcile data / reconcile accounts。",
    examples: [
      {
        en: "The team tried to reconcile the conflicting requirements.",
        zh: "团队试图协调这些相互冲突的需求。",
        favorite: false
      },
      {
        en: "We need to reconcile the numbers before the report is sent.",
        zh: "报告发送前，我们需要核对这些数字。",
        favorite: false
      }
    ],
    status: "ready"
  },
  {
    id: "vigilant",
    term: "vigilant",
    type: "word",
    userMeaning: "警惕的；保持警觉的",
    sourceMeaning: "watching carefully for possible danger or problems",
    partOfSpeech: "adj.",
    phonetics: [{ region: "US", text: "/ˈvɪdʒələnt/", audio: "" }],
    forms: [],
    tags: ["高频复习"],
    notes: "适合描述安全、隐私、风险场景。",
    examples: [
      {
        en: "Researchers must remain vigilant about privacy leakage.",
        zh: "研究人员必须对隐私泄露保持警惕。",
        favorite: false
      },
      {
        en: "The system stays vigilant for unusual behavior.",
        zh: "系统会持续警惕异常行为。",
        favorite: false
      }
    ],
    status: "ready"
  },
  {
    id: "privacy-leakage",
    term: "privacy leakage",
    type: "phrase",
    userMeaning: "隐私泄露",
    sourceMeaning: "the unwanted exposure of private information",
    partOfSpeech: "phrase",
    phonetics: [],
    forms: [],
    tags: ["短语", "工作表达"],
    notes: "短语类词条优先使用系统 TTS 发音，在线词典结果需要人工确认。",
    examples: [
      {
        en: "The model may cause privacy leakage if sensitive data is memorized.",
        zh: "如果模型记住了敏感数据，就可能造成隐私泄露。",
        favorite: false
      },
      {
        en: "The audit focused on potential privacy leakage in the workflow.",
        zh: "审计重点关注流程中潜在的隐私泄露问题。",
        favorite: false
      }
    ],
    status: "needs-review"
  },
  {
    id: "benchmark",
    term: "benchmark",
    type: "word",
    userMeaning: "基准；基准测试；衡量标准",
    sourceMeaning: "a standard or point of reference against which things may be compared",
    partOfSpeech: "n.",
    phonetics: [{ region: "US", text: "/ˈbentʃmɑːrk/", audio: "" }],
    forms: ["benchmarks"],
    tags: ["研究", "工程"],
    notes: "论文、实验、模型评估里很常见。",
    examples: [
      {
        en: "The benchmark measures performance across several tasks.",
        zh: "这个基准测试会衡量多个任务上的表现。",
        favorite: false
      },
      {
        en: "We used the previous model as a benchmark.",
        zh: "我们把之前的模型作为衡量基准。",
        favorite: false
      }
    ],
    status: "ready"
  },
  {
    id: "illusion",
    term: "illusion",
    type: "word",
    userMeaning: "幻觉，错觉；错误的观念；不切实际的幻想",
    sourceMeaning: "an idea or belief that is not true, or something that is not what it seems to be",
    partOfSpeech: "n.",
    phonetics: [{ region: "US", text: "/ɪˈluːʒn/", audio: "" }],
    forms: ["illusions"],
    tags: ["拼写练习"],
    notes: "",
    examples: [
      {
        en: "The optical illusion made the room look much larger.",
        zh: "这个视觉错觉让房间看起来大了很多。",
        favorite: false
      },
      {
        en: "It is an illusion to think the problem will disappear by itself.",
        zh: "以为问题会自行消失是不切实际的幻想。",
        favorite: false
      }
    ],
    status: "ready"
  }
];

const detailedByTerm = new Map(detailedSeedEntries.map((entry) => [entry.term.toLowerCase(), entry]));

export const seedEntries = importedVocabulary.map((entry) => {
  const detailed = detailedByTerm.get(entry.term.toLowerCase());
  if (!detailed) return entry;

  return {
    ...entry,
    ...detailed,
    sourceRaw: entry.sourceRaw,
    importWarnings: entry.importWarnings,
    tags: [...new Set([...(entry.tags ?? []), ...(detailed.tags ?? [])])]
  };
});
