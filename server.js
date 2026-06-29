import express from "express";
import cors from "cors";

const app = express();
const PORT = Number(process.env.PORT || 5177);

const COURTLISTENER_SEARCH = "https://www.courtlistener.com/api/rest/v4/search/";
const COURTLISTENER_OPINIONS = "https://www.courtlistener.com/api/rest/v4/opinions/";
const DEFAULT_ARBITER_URL = process.env.ARBITER_URL || "https://recast-reviver-outlook.ngrok-free.dev/v1/compare";
const MAX_CANDIDATES = Number(process.env.MAX_CANDIDATES || 300);
const DEFAULT_CANDIDATES = Number(process.env.DEFAULT_CANDIDATES || 64);
const DEFAULT_RETURN = Number(process.env.DEFAULT_RETURN || 20);
const MAX_RETURN = Number(process.env.MAX_RETURN || 80);
const MIN_SURFACE_CHARS = Number(process.env.MIN_SURFACE_CHARS || 120);
const MAX_OPINION_FETCHES = Number(process.env.MAX_OPINION_FETCHES || 90);
const MAX_SURFACE_CHARS = Number(process.env.MAX_SURFACE_CHARS || 7600);
const MAX_COURTLISTENER_FETCH = Number(process.env.MAX_COURTLISTENER_FETCH || 900);
const COURTLISTENER_PAGE_SIZE = Number(process.env.COURTLISTENER_PAGE_SIZE || 100);
const MAX_PAGES_PER_QUERY = Number(process.env.MAX_PAGES_PER_QUERY || 6);
const USER_AGENT = "authority-finder-arbiter/0.4 contact: local-demo";

app.use(cors());
app.use(express.json({ limit: "4mb" }));
app.use(express.static("public"));

const opinionCache = new Map();

function asText(value) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.filter(Boolean).join("; ");
  return String(value);
}

function stripHtml(input) {
  return asText(input)
    .replace(/<mark>/gi, "")
    .replace(/<\/mark>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\u2014/g, " — ")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compact(input, limit = MAX_SURFACE_CHARS) {
  const cleaned = stripHtml(input);
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit).trim()}…`;
}

function safeUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  return `https://www.courtlistener.com${String(path).startsWith("/") ? "" : "/"}${path}`;
}

function normalizeArbiterUrl(raw) {
  const value = String(raw || DEFAULT_ARBITER_URL).trim();
  if (!value) return DEFAULT_ARBITER_URL;
  try {
    const url = new URL(value);
    const cleanPath = url.pathname.replace(/\/+$/, "");
    if (!cleanPath || cleanPath === "/") {
      url.pathname = url.hostname.includes("localhost") || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0"
        ? "/v1/compare"
        : "/public/compare";
    } else if (!/\/compare$/.test(cleanPath)) {
      url.pathname = cleanPath.endsWith("/v1") || cleanPath.endsWith("/public")
        ? `${cleanPath}/compare`
        : `${cleanPath}/v1/compare`;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function uniqueTokens(text) {
  return [...new Set(stripHtml(text).toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [])];
}

const GENERIC_STOP_WORDS = new Set([
  "where", "cases", "case", "find", "similar", "because", "after", "before", "with", "that", "they", "their",
  "were", "was", "the", "and", "for", "from", "into", "over", "under", "claims", "claim", "request", "legal",
  "what", "when", "why", "how", "this", "there", "would", "could", "should", "about", "against", "participate",
  "participating", "believed", "lacked", "current", "upheld", "rejected"
]);

const STOP_WORDS = new Set([
  ...GENERIC_STOP_WORDS,
  "not", "but", "are", "has", "had", "have", "its", "his", "her", "who", "court", "conduct"
]);

function distinctiveTerms(query, limit = 14) {
  return uniqueTokens(query)
    .filter((token) => token.length > 3 && !GENERIC_STOP_WORDS.has(token))
    .slice(0, limit);
}

function rxAny(patterns) {
  return patterns.map((pattern) => pattern.source || String(pattern)).join("|");
}

function buildIntentPlan(query) {
  const q = stripHtml(query);
  const lower = q.toLowerCase();
  const terms = distinctiveTerms(q);
  const fallback = terms.join(" ") || q;

  const intents = [
    {
      name: "stale_informant_warrant",
      label: "stale informant tip / search warrant reliability",
      pattern: /stale|staleness|informant|confidential informant|tip|tipster|current reliability|probable cause|affidavit/i,
      requiredGroups: [
        { name: "informant/tip", terms: ["informant", "confidential informant", "ci", "tipster", "anonymous tip", "informant tip"] },
        { name: "warrant/probable cause", terms: ["search warrant", "warrant", "affidavit", "probable cause", "magistrate", "issuing judge"] },
        { name: "freshness/reliability", terms: ["stale", "staleness", "current", "recent", "reliability", "reliable", "timeliness", "too remote", "old information", "fresh"] },
      ],
      proximityPairs: [["informant/tip", "freshness/reliability", 1800], ["warrant/probable cause", "freshness/reliability", 2200]],
      boostTerms: ["informant", "confidential informant", "tipster", "search warrant", "affidavit", "probable cause", "stale", "staleness", "recent", "current", "reliability", "Illinois v. Gates", "Aguilar", "Spinelli"],
      retrievalQueries: [
        '("confidential informant" OR informant OR tipster OR "informant tip") AND ("search warrant" OR affidavit) AND (stale OR staleness OR current OR recent OR reliability OR "probable cause")',
        '"informant tip"~20 AND ("search warrant" OR affidavit OR "probable cause")',
        '"confidential informant" AND affidavit AND "probable cause" AND (stale OR staleness OR recent OR current)',
        '"Illinois v. Gates" informant affidavit "probable cause"',
        fallback
      ]
    },
    {
      name: "public_employee_speech",
      label: "public employee retaliation / official-duty speech",
      pattern: /public employee|government employee|employee.*speech|official duties|retaliation|whistleblower|first amendment|protected speech/i,
      requiredGroups: [
        { name: "public employee", terms: ["public employee", "government employee", "employee"] },
        { name: "speech/whistleblower", terms: ["speech", "whistleblower", "first amendment", "protected speech", "official duties", "pursuant to official duties"] },
        { name: "retaliation/employment action", terms: ["retaliation", "adverse employment", "termination", "fired", "discipline"] },
      ],
      proximityPairs: [["speech/whistleblower", "retaliation/employment action", 2200]],
      boostTerms: ["public employee", "First Amendment", "retaliation", "protected speech", "official duties", "Garcetti", "Pickering", "whistleblower"],
      retrievalQueries: [
        '("public employee" OR "government employee") AND (retaliation OR "First Amendment" OR whistleblower) AND ("official duties" OR Garcetti OR Pickering OR "protected speech")',
        'Garcetti Pickering "public employee" retaliation "First Amendment"',
        fallback
      ]
    },
    {
      name: "damages_cap_unconscionability",
      label: "contract damages cap / consequential damages / bargaining power",
      pattern: /damages cap|consequential damages|limitation of liability|bargaining power|unconscion|liability cap/i,
      requiredGroups: [
        { name: "limitation clause", terms: ["limitation of liability", "liability cap", "damages cap", "limit damages", "limited liability"] },
        { name: "consequential damages", terms: ["consequential damages", "special damages", "incidental damages"] },
        { name: "bargaining power/unconscionability", terms: ["bargaining power", "unconscionability", "unconscionable", "adhesion", "commercially reasonable"] },
      ],
      proximityPairs: [["limitation clause", "bargaining power/unconscionability", 2400]],
      boostTerms: ["limitation of liability", "damages cap", "consequential damages", "unconscionability", "bargaining power", "adhesion"],
      retrievalQueries: [
        '("limitation of liability" OR "damages cap" OR "liability cap") AND ("consequential damages" OR unconscionability OR "bargaining power")',
        '"consequential damages" "limitation of liability" unconscionability',
        fallback
      ]
    },
    {
      name: "premises_constructive_notice",
      label: "premises liability / constructive notice / hazard duration",
      pattern: /premises liability|constructive notice|hazard|slip|fall|how long|length of time/i,
      requiredGroups: [
        { name: "premises/hazard", terms: ["premises liability", "hazard", "dangerous condition", "slip", "fall"] },
        { name: "constructive notice", terms: ["constructive notice", "notice", "knew or should have known"] },
        { name: "duration/time", terms: ["length of time", "how long", "duration", "existed", "reasonable inspection"] },
      ],
      proximityPairs: [["constructive notice", "duration/time", 2200]],
      boostTerms: ["premises liability", "constructive notice", "hazard", "length of time", "reasonable inspection", "slip and fall"],
      retrievalQueries: [
        '"constructive notice" AND (hazard OR "dangerous condition" OR premises OR "slip and fall") AND (duration OR "length of time" OR existed OR inspection)',
        '"constructive notice" "length of time" hazard',
        fallback
      ]
    },
    {
      name: "inventory_search",
      label: "inventory search / investigatory motive",
      pattern: /inventory search|impound|investigatory/i,
      requiredGroups: [
        { name: "inventory/impound", terms: ["inventory search", "inventory", "impound", "impounded"] },
        { name: "procedure/motive", terms: ["standardized procedure", "investigatory", "pretext", "motive", "policy"] },
      ],
      proximityPairs: [["inventory/impound", "procedure/motive", 2200]],
      boostTerms: ["inventory search", "impound", "standardized procedure", "investigatory motive", "pretext", "Fourth Amendment"],
      retrievalQueries: [
        '("inventory search" OR impound) AND ("standardized procedure" OR investigatory OR pretext OR policy)',
        fallback
      ]
    }
  ];

  const matched = intents.find((intent) => intent.pattern.test(lower));
  if (matched) return { ...matched, retrievalQueries: [...new Set(matched.retrievalQueries.filter(Boolean))] };

  const generic = {
    name: "generic_legal_request",
    label: "generic legal authority search",
    requiredGroups: [],
    proximityPairs: [],
    boostTerms: terms,
    retrievalQueries: [fallback || q]
  };
  return generic;
}

function surfacePieces(result) {
  const opinions = Array.isArray(result.opinions) ? result.opinions : [];
  const opinionSnippets = opinions
    .map((opinion) => stripHtml(opinion.snippet))
    .filter(Boolean);

  return [
    { kind: "case summary", text: result.syllabus },
    { kind: "procedural posture", text: result.posture },
    { kind: "procedural history", text: result.procedural_history },
    { kind: "opinion excerpt", text: opinionSnippets.join(" ") },
  ].map((piece) => ({ ...piece, text: stripHtml(piece.text) })).filter((piece) => piece.text);
}

function preferredSurfaceKind(pieces, fullTextAvailable = false) {
  if (pieces.find((piece) => piece.kind === "case summary")) return "case summary";
  if (pieces.find((piece) => piece.kind === "focused opinion text")) return "focused opinion text";
  if (pieces.find((piece) => piece.kind === "procedural posture")) return "procedural posture";
  if (pieces.find((piece) => piece.kind === "procedural history")) return "procedural history";
  if (pieces.find((piece) => piece.kind === "opinion excerpt")) return fullTextAvailable ? "opinion excerpt + full-text focus" : "opinion excerpt";
  return "metadata";
}

function normalizeCaseKey(item) {
  const title = stripHtml(item.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const docket = stripHtml(item.docketNumber).toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const citation = stripHtml(item.citation).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 80);
  if (item.clusterId) return `cluster:${item.clusterId}`;
  if (docket && title) return `docket:${title}:${docket}`;
  if (citation && title) return `cite:${title}:${citation}`;
  return `title:${title}`;
}


function firstPresent(...values) {
  for (const value of values) {
    const text = asText(value).trim();
    if (text) return text;
  }
  return "";
}

function extractIdFromUrl(value) {
  const text = asText(value);
  const match = text.match(/\/opinions?\/(\d+)\/?/i) || text.match(/\/opinion\/(\d+)\//i);
  return match ? Number(match[1]) : null;
}

function extractOpinionIds(result) {
  const ids = [];
  const push = (value) => {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) ids.push(num);
  };

  const directKeys = [
    "opinion_id", "opinionId", "opinion_pk", "opinionPk", "opinion", "opinion_id_exact"
  ];
  for (const key of directKeys) push(result?.[key]);

  const opinions = Array.isArray(result?.opinions) ? result.opinions : [];
  for (const opinion of opinions) {
    for (const key of ["id", "pk", "opinion_id", "opinionId", "resource_id"]) push(opinion?.[key]);
    const fromUrl = extractIdFromUrl(opinion?.absolute_url || opinion?.download_url || opinion?.resource_uri || opinion?.url || opinion?.path);
    if (fromUrl) ids.push(fromUrl);
  }

  const fromResultUrl = extractIdFromUrl(result?.absolute_url || result?.download_url || result?.resource_uri || result?.url);
  if (fromResultUrl) ids.push(fromResultUrl);

  return [...new Set(ids)].slice(0, 6);
}

function textFromOpinionPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  return stripHtml(
    payload.html_with_citations ||
    payload.html_columbia ||
    payload.html_lawbox ||
    payload.html_anon_2020 ||
    payload.html ||
    payload.plain_text ||
    payload.text ||
    payload.xml_harvard ||
    payload.snippet ||
    ""
  );
}

function betterCandidate(existing, incoming) {
  if (!existing) return incoming;
  const existingValue = (existing.surface?.length || 0) + (existing.opinionIds?.length || 0) * 200 + (existing.citeCount || 0) * 2;
  const incomingValue = (incoming.surface?.length || 0) + (incoming.opinionIds?.length || 0) * 200 + (incoming.citeCount || 0) * 2;
  return incomingValue > existingValue ? incoming : existing;
}

function mergeCandidateData(target, source) {
  if (!target || !source || target === source) return target || source;
  target.opinionIds = [...new Set([...(target.opinionIds || []), ...(source.opinionIds || [])])].slice(0, 8);
  const mergedPieces = [...(target.rawPieces || []), ...(source.rawPieces || [])];
  const seenPieces = new Set();
  target.rawPieces = mergedPieces.filter((piece) => {
    const key = `${piece.kind}:${stripHtml(piece.text).slice(0, 240).toLowerCase()}`;
    if (seenPieces.has(key)) return false;
    seenPieces.add(key);
    return true;
  });
  if ((source.bestSnippet || "").length > (target.bestSnippet || "").length) target.bestSnippet = source.bestSnippet;
  if ((source.surface || "").length > (target.surface || "").length) target.surface = source.surface;
  target.citeCount = Math.max(Number(target.citeCount || 0), Number(source.citeCount || 0));
  target.keywordScore = target.keywordScore ?? source.keywordScore;
  return target;
}

function candidateDedupeKeys(item) {
  const keys = new Set();
  const title = stripHtml(item.title).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const court = stripHtml(item.court).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const date = String(item.dateFiled || "").slice(0, 10);
  const docket = stripHtml(item.docketNumber).toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const citation = stripHtml(item.citation).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  const urlId = asText(item.url).match(/\/opinion\/(\d+)\//i)?.[1] || "";
  const snippetKey = stripHtml(item.bestSnippet).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 280);

  if (item.clusterId) keys.add(`cluster:${item.clusterId}`);
  if (urlId) keys.add(`urlop:${urlId}`);
  if (title && docket) keys.add(`title-docket:${title}:${docket}`);
  if (title && court && date) keys.add(`title-court-date:${title}:${court}:${date}`);
  if (title && citation) keys.add(`title-cite:${title}:${citation}`);
  if (title && snippetKey.length > 80) keys.add(`title-snippet:${title}:${snippetKey}`);
  if (!keys.size && title) keys.add(`title:${title}`);
  return [...keys];
}

function buildCaseItem(result) {
  const title = stripHtml(result.caseNameFull || result.caseName || "Untitled case");
  const citation = Array.isArray(result.citation) ? result.citation.join(", ") : asText(result.citation);
  const pieces = surfacePieces(result);
  const metadata = [
    `Case: ${title}`,
    result.court ? `Court: ${result.court}` : "",
    result.dateFiled ? `Date filed: ${result.dateFiled}` : "",
    citation ? `Citation: ${citation}` : "",
    result.docketNumber ? `Docket: ${result.docketNumber}` : "",
  ].filter(Boolean);

  const surfaceText = [
    ...metadata,
    ...pieces.map((piece) => `${piece.kind}: ${piece.text}`),
  ].filter(Boolean).join("\n");

  const bestSnippet = pieces[0]?.text || pieces.find((piece) => piece.kind === "opinion excerpt")?.text || metadata.join(" · ");
  const opinionIds = extractOpinionIds(result).slice(0, 6);

  const item = {
    id: String(result.cluster_id || result.id || title),
    clusterId: result.cluster_id || null,
    title,
    court: result.court || result.court_citation_string || "",
    courtId: result.court_id || "",
    dateFiled: result.dateFiled || "",
    citation,
    citeCount: Number(result.citeCount || 0),
    docketNumber: result.docketNumber || "",
    url: safeUrl(result.absolute_url),
    keywordScore: result.meta?.score?.bm25 ?? null,
    sourceRank: null,
    bestSnippet: compact(bestSnippet, 900),
    surface: compact(surfaceText, MAX_SURFACE_CHARS),
    surfaceKind: preferredSurfaceKind(pieces),
    surfaceQuality: pieces.length ? "search-result surface" : "metadata fallback",
    fullTextAvailable: false,
    fullTextLength: 0,
    fullTextFetchStatus: "not requested",
    opinionIds,
    rawPieces: pieces,
    rawResult: result,
  };

  item.caseKey = normalizeCaseKey(item);
  item.courtScope = inferCourtScope(item);
  item.noiseReasons = candidateNoiseReasons(item);
  return item;
}

function inferCourtScope(item) {
  const court = `${item.court || ""} ${item.courtId || ""}`.toLowerCase();
  if (/supreme court of the united states|\bscotus\b/.test(court)) return "scotus";
  if (/court of appeals for|u\.s\. court of appeals|united states court of appeals|\bca[0-9a-z]+\b|federal circuit/.test(court)) return "federal_appellate";
  if (/district court|bankruptcy court|tax court|court of federal claims|international trade|\bd\.|\bed\.|\bwd\.|\bsd\.|\bnd\./.test(court)) return "federal_district";
  if (/supreme court/.test(court)) return "state_supreme";
  if (/court of appeals|court of appeal|appellate/.test(court)) return "state_appellate";
  if (/court of claims|superior court|trial court|circuit court|county court|common pleas/.test(court)) return "state_trial";
  return "other";
}

function matchesJurisdiction(item, jurisdiction = "all") {
  const value = String(jurisdiction || "all");
  if (value === "all") return true;

  const court = `${item.court || ""} ${item.courtId || ""}`.toLowerCase();
  const scope = item.courtScope;
  const isFederal = ["scotus", "federal_appellate", "federal_district"].includes(scope);
  const isState = ["state_supreme", "state_appellate", "state_trial"].includes(scope);

  if (value === "federal") return isFederal;
  if (value === "state") return isState;
  if (value === "scotus") return scope === "scotus";
  if (value === "federal_appellate") return scope === "federal_appellate";
  if (value === "federal_district") return scope === "federal_district";
  if (value === "state_supreme") return scope === "state_supreme";
  if (value === "ninth_circuit") return /ninth circuit|9th cir|\bca9\b/.test(court);
  if (value === "california") return /california|cal\.|\bcal\b|\bca\b/.test(court) && !/\bca9\b|ninth circuit/.test(court);
  if (value === "new_york") return /new york|n\.y\.|\bny\b/.test(court);
  if (value === "texas") return /texas|tex\.|\btx\b/.test(court);
  if (value === "ohio") return /ohio|\boh\b/.test(court);
  return true;
}

function isWithinDateRange(item, dateFrom = "", dateTo = "") {
  const filed = String(item.dateFiled || "").slice(0, 10);
  if (!filed) return true;
  if (dateFrom && filed < dateFrom) return false;
  if (dateTo && filed > dateTo) return false;
  return true;
}

function candidateNoiseReasons(item) {
  const title = item.title.toLowerCase();
  const court = String(item.court || "").toLowerCase();
  const surface = String(item.surface || "").toLowerCase();
  const combined = `${title} ${court} ${surface}`;
  const reasons = [];

  if (item.surface.length < MIN_SURFACE_CHARS) reasons.push("thin surface");
  if (/jury instruction|standard jury instructions|report no\.\s*\d|civil jury instructions/.test(combined)) reasons.push("jury instructions/admin material");
  if (/in re complaint as to the conduct|conduct and disability|judicial conduct|disciplinary board|bar counsel|accused\b|attorney discipline|lawyer discipline|committee to review/.test(combined)) reasons.push("disciplinary/admin proceeding");
  if (/advisory opinion|rules of court|amendments to the rules|proposed rule|administrative order|local rule|standing order/.test(combined)) reasons.push("procedural/admin order");
  if (/\bin re\b/.test(title) && /rule|instruction|conduct|disciplin|advisory|committee|amendment|petition/.test(title)) reasons.push("likely non-merits authority");
  if (/^untitled case$/i.test(item.title)) reasons.push("missing title");

  return [...new Set(reasons)];
}

function shouldKeepCandidate(item, { includeNoise = false } = {}) {
  if (includeNoise) return true;
  return item.noiseReasons.length === 0;
}

function dedupeCandidates(candidates) {
  const keyToItem = new Map();
  const deduped = [];

  for (const item of candidates) {
    const keys = candidateDedupeKeys(item);
    const existing = keys.map((key) => keyToItem.get(key)).find(Boolean);

    if (existing) {
      const keeper = betterCandidate(existing, item);
      const loser = keeper === existing ? item : existing;
      mergeCandidateData(keeper, loser);

      if (keeper !== existing) {
        const idx = deduped.indexOf(existing);
        if (idx >= 0) deduped[idx] = keeper;
      }

      for (const key of [...keys, ...candidateDedupeKeys(existing)]) keyToItem.set(key, keeper);
      continue;
    }

    deduped.push(item);
    for (const key of keys) keyToItem.set(key, item);
  }

  return deduped.map((item) => {
    item.caseKey = candidateDedupeKeys(item)[0] || item.caseKey || normalizeCaseKey(item);
    return item;
  });
}

function groupRegex(group) {
  const escaped = group.terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

function groupMatches(text, group) {
  const lower = stripHtml(text).toLowerCase();
  return group.terms.some((term) => {
    if (term.length <= 3) return new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(lower);
    return lower.includes(term.toLowerCase());
  });
}

function groupPositions(text, group) {
  const lower = stripHtml(text).toLowerCase();
  const positions = [];
  for (const term of group.terms) {
    const needle = term.toLowerCase();
    let start = lower.indexOf(needle);
    while (start !== -1) {
      positions.push(start);
      start = lower.indexOf(needle, start + Math.max(needle.length, 1));
    }
  }
  return positions;
}

function hasProximity(text, groupA, groupB, maxDistance) {
  const a = groupPositions(text, groupA);
  const b = groupPositions(text, groupB);
  if (!a.length || !b.length) return false;
  for (const ai of a) {
    for (const bi of b) {
      if (Math.abs(ai - bi) <= maxDistance) return true;
    }
  }
  return false;
}

function intentCoverage(item, intent) {
  const text = `${item.title}\n${item.surface}`;
  const groups = (intent.requiredGroups || []).map((group) => ({ name: group.name, present: groupMatches(text, group) }));
  const presentCount = groups.filter((group) => group.present).length;
  const proximity = (intent.proximityPairs || []).map(([aName, bName, maxDistance]) => {
    const a = intent.requiredGroups.find((group) => group.name === aName);
    const b = intent.requiredGroups.find((group) => group.name === bName);
    return { pair: `${aName}↔${bName}`, present: a && b ? hasProximity(text, a, b, maxDistance) : false };
  });
  const proximityCount = proximity.filter((pair) => pair.present).length;
  return { groups, presentCount, proximity, proximityCount, totalGroups: groups.length };
}

function passesIntentGate(item, intent, mode = "strict") {
  if (!intent.requiredGroups?.length) return true;
  const coverage = intentCoverage(item, intent);
  item.intentCoverage = coverage;
  if (mode === "strict") {
    return coverage.presentCount === coverage.totalGroups && (!intent.proximityPairs?.length || coverage.proximityCount >= 1);
  }
  if (mode === "relaxed") {
    return coverage.presentCount >= Math.min(2, coverage.totalGroups);
  }
  return true;
}

function filterCandidates(candidates, filters = {}, intent) {
  const includeNoise = Boolean(filters.includeNoise);
  const jurisdiction = filters.jurisdiction || "all";
  const dateFrom = String(filters.dateFrom || "").trim();
  const dateTo = String(filters.dateTo || "").trim();

  const base = candidates.filter((item) => {
    if (!shouldKeepCandidate(item, { includeNoise })) return false;
    if (!matchesJurisdiction(item, jurisdiction)) return false;
    if (!isWithinDateRange(item, dateFrom, dateTo)) return false;
    return true;
  });

  if (!intent?.requiredGroups?.length) return { filtered: base, intentMode: "none", intentFilteredOutCount: 0 };

  const strict = base.filter((item) => passesIntentGate(item, intent, "strict"));
  if (strict.length >= Math.min(8, Math.max(4, filters.requested || DEFAULT_CANDIDATES))) {
    return { filtered: strict, intentMode: "strict", intentFilteredOutCount: base.length - strict.length };
  }

  const relaxed = base.filter((item) => passesIntentGate(item, intent, "relaxed"));
  if (relaxed.length >= Math.min(6, Math.max(3, filters.returnLimit || DEFAULT_RETURN))) {
    return { filtered: relaxed, intentMode: "relaxed", intentFilteredOutCount: base.length - relaxed.length };
  }

  return { filtered: base, intentMode: "fallback", intentFilteredOutCount: 0 };
}

async function fetchCourtListenerPageUrl(url) {
  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": USER_AGENT
    }
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`CourtListener ${response.status}: ${text.slice(0, 300)}`);
  }

  return response.json();
}

function buildCourtListenerSearchUrl(searchQuery, pageSize, semantic = false) {
  const url = new URL(COURTLISTENER_SEARCH);
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("type", "o");
  url.searchParams.set("highlight", "on");
  url.searchParams.set("page_size", String(Math.max(20, Math.min(COURTLISTENER_PAGE_SIZE, pageSize))));
  if (semantic) url.searchParams.set("semantic", "true");
  return url;
}

async function fetchCourtListenerPages(searchQuery, targetLimit, semantic = false) {
  const target = Math.max(1, Number(targetLimit) || 1);
  let url = buildCourtListenerSearchUrl(searchQuery, Math.min(COURTLISTENER_PAGE_SIZE, target), semantic);
  const results = [];
  const pageStatuses = [];

  for (let page = 1; page <= MAX_PAGES_PER_QUERY && url && results.length < target; page++) {
    const payload = await fetchCourtListenerPageUrl(url);
    const rows = Array.isArray(payload.results) ? payload.results : [];
    results.push(...rows);
    pageStatuses.push(`${page}:${rows.length}`);
    if (!payload.next) break;
    url = new URL(payload.next);
  }

  return {
    results: results.slice(0, target),
    fetched: results.length,
    pageStatuses,
  };
}

// Backwards-compatible one-shot fetch used by older callers/tests.
async function fetchCourtListenerPage(searchQuery, limit, semantic = false) {
  const payload = await fetchCourtListenerPages(searchQuery, limit, semantic);
  return payload.results;
}

async function fetchOpinionTextById(id) {
  const key = `id:${String(id)}`;
  if (opinionCache.has(key)) return opinionCache.get(key);

  const url = `${COURTLISTENER_OPINIONS}${encodeURIComponent(String(id))}/`;
  const promise = fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": USER_AGENT }
  }).then(async (response) => {
    if (!response.ok) return { id, ok: false, status: response.status, text: "", source: "opinion-id" };
    const payload = await response.json();
    const text = textFromOpinionPayload(payload);
    return { id, ok: Boolean(text), status: response.status, text, type: payload.type || "", author: payload.author_str || "", source: "opinion-id" };
  }).catch((error) => ({ id, ok: false, status: 0, error: error.message, text: "", source: "opinion-id" }));

  opinionCache.set(key, promise);
  return promise;
}

async function fetchOpinionTextsByCluster(clusterId) {
  const cluster = String(clusterId || "").trim();
  if (!cluster) return { ok: false, status: 0, textEntries: [], source: "cluster", error: "missing cluster id" };

  const cacheKey = `cluster:${cluster}`;
  if (opinionCache.has(cacheKey)) return opinionCache.get(cacheKey);

  const paramsToTry = ["cluster", "cluster_id", "cluster__id"];
  const promise = (async () => {
    const attempts = [];
    for (const param of paramsToTry) {
      const url = new URL(COURTLISTENER_OPINIONS);
      url.searchParams.set(param, cluster);
      url.searchParams.set("page_size", "6");
      try {
        const response = await fetch(url, { headers: { "Accept": "application/json", "User-Agent": USER_AGENT } });
        attempts.push(`${param}:${response.status}`);
        if (!response.ok) continue;
        const payload = await response.json();
        const rows = Array.isArray(payload.results) ? payload.results : [];
        const textEntries = rows
          .map((row) => ({ id: row.id || row.pk || null, ok: true, status: response.status, text: textFromOpinionPayload(row), source: `cluster-${param}` }))
          .filter((entry) => entry.text && entry.text.length > 120);
        if (textEntries.length) return { ok: true, status: response.status, textEntries, source: `cluster-${param}`, attempts };
      } catch (error) {
        attempts.push(`${param}:error:${error.message}`);
      }
    }
    return { ok: false, status: 0, textEntries: [], source: "cluster", attempts, error: "no text returned from cluster lookup" };
  })();

  opinionCache.set(cacheKey, promise);
  return promise;
}

async function fetchOpinionTextsForItem(item) {
  const byId = item.opinionIds?.length
    ? await asyncPool(item.opinionIds.slice(0, 3), 2, fetchOpinionTextById)
    : [];

  let textEntries = byId.filter((entry) => entry.ok && entry.text && entry.text.length > 120);
  const attempts = byId.map((entry) => `${entry.source || "opinion-id"}:${entry.id || "?"}:${entry.status || 0}`);

  if (!textEntries.length && item.clusterId) {
    const cluster = await fetchOpinionTextsByCluster(item.clusterId);
    attempts.push(...(cluster.attempts || [`${cluster.source}:${cluster.status || 0}`]));
    textEntries = cluster.textEntries || [];
  }

  return {
    ok: textEntries.length > 0,
    textEntries,
    attempts,
    status: textEntries.length > 0 ? "ok" : (attempts.length ? attempts.join(", ") : "no opinion ids"),
  };
}

async function asyncPool(items, concurrency, worker) {
  const results = [];
  let index = 0;
  async function run() {
    while (index < items.length) {
      const current = index++;
      results[current] = await worker(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run));
  return results;
}

function splitSentences(text) {
  const cleaned = stripHtml(text);
  if (!cleaned) return [];
  return cleaned
    .replace(/([.!?])\s+(?=[A-Z\[])/g, "$1\n")
    .split(/\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30);
}

function sentenceScore(sentence, queryTerms, intent) {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const term of queryTerms) if (lower.includes(term.toLowerCase())) score += 2;
  for (const term of intent.boostTerms || []) {
    if (lower.includes(term.toLowerCase())) score += term.includes(" ") ? 5 : 3;
  }
  for (const group of intent.requiredGroups || []) {
    if (groupMatches(sentence, group)) score += 7;
  }
  if (/holding|held|conclude|probable cause|reasonable|affidavit|warrant|informant|stale|staleness|reliability/i.test(sentence)) score += 2;
  return score;
}

function buildFocusedExcerpt(query, fullText, intent) {
  const sentences = splitSentences(fullText);
  if (!sentences.length) return "";
  const queryTerms = distinctiveTerms(query, 18);
  const scored = sentences.map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, queryTerms, intent) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return compact(sentences.slice(0, 12).join(" "), 4200);

  const selected = [];
  const used = new Set();
  for (const row of scored) {
    if (selected.length >= 4) break;
    if (used.has(row.index)) continue;
    const start = Math.max(0, row.index - 1);
    const end = Math.min(sentences.length, row.index + 2);
    for (let i = start; i < end; i++) used.add(i);
    selected.push(sentences.slice(start, end).join(" "));
  }

  return compact(selected.join(" […] "), 5200);
}

async function enrichWithOpinionText(items, originalQuery, intent, fetchFullText = true) {
  if (!fetchFullText) return items;

  const candidatesToFetch = items
    .filter((item) => item.opinionIds.length || item.clusterId)
    .slice(0, MAX_OPINION_FETCHES);

  await asyncPool(candidatesToFetch, 6, async (item) => {
    item.fullTextFetchStatus = "attempted";
    const fetched = await fetchOpinionTextsForItem(item);
    const texts = fetched.textEntries.map((entry) => entry.text).filter((text) => text && text.length > 120);
    item.fullTextFetchAttempts = fetched.attempts || [];
    if (!texts.length) {
      item.fullTextFetchStatus = fetched.status || "fetch failed";
      return item;
    }

    const fullText = texts.join("\n\n");
    const focused = buildFocusedExcerpt(originalQuery, fullText, intent);
    item.fullTextAvailable = true;
    item.fullTextLength = fullText.length;
    item.fullTextFetchStatus = "ok";

    const metadata = [
      `Case: ${item.title}`,
      item.court ? `Court: ${item.court}` : "",
      item.dateFiled ? `Date filed: ${item.dateFiled}` : "",
      item.citation ? `Citation: ${item.citation}` : "",
      item.docketNumber ? `Docket: ${item.docketNumber}` : "",
    ].filter(Boolean);

    const pieces = [...item.rawPieces];
    if (focused) pieces.push({ kind: "focused opinion text", text: focused });

    item.surface = compact([
      ...metadata,
      ...pieces.map((piece) => `${piece.kind}: ${piece.text}`),
    ].join("\n"), MAX_SURFACE_CHARS);
    item.surfaceKind = preferredSurfaceKind(pieces, true);
    item.surfaceQuality = "full-text focused surface";
    item.bestSnippet = compact(focused || item.bestSnippet, 1100);
    item.noiseReasons = candidateNoiseReasons(item);
    item.intentCoverage = intentCoverage(item, intent);
    return item;
  });

  return items;
}

async function courtListenerCandidates(originalQuery, candidateLimit, options = {}) {
  const requested = Math.max(1, Math.min(MAX_CANDIDATES, Number(candidateLimit) || DEFAULT_CANDIDATES));
  const fetchLimit = Math.min(MAX_COURTLISTENER_FETCH, Math.max(requested * 4, 120));
  const intent = buildIntentPlan(originalQuery);
  const semantic = Boolean(options.semantic);
  const fetchFullText = options.fetchFullText !== false;

  const rawResults = [];
  const retrievalQueries = intent.retrievalQueries.slice(0, 5);
  const perQueryLimit = Math.max(40, Math.ceil(fetchLimit / Math.max(1, retrievalQueries.length)));
  const retrievalStats = [];

  for (const searchQuery of retrievalQueries) {
    const pageBundle = await fetchCourtListenerPages(searchQuery, perQueryLimit, semantic);
    rawResults.push(...pageBundle.results);
    retrievalStats.push({
      query: searchQuery,
      requested: perQueryLimit,
      fetched: pageBundle.fetched,
      used: pageBundle.results.length,
      pages: pageBundle.pageStatuses,
    });
    if (rawResults.length >= fetchLimit) break;
  }

  const rawResultCount = rawResults.length;
  const built = dedupeCandidates(rawResults.map(buildCaseItem));
  const duplicateCandidateCount = rawResultCount - built.length;
  await enrichWithOpinionText(built, originalQuery, intent, fetchFullText);

  const filterResult = filterCandidates(built, { ...options, requested, returnLimit: options.returnLimit || DEFAULT_RETURN }, intent);
  const finalCandidates = filterResult.filtered.slice(0, requested).map((item, index) => ({
    ...item,
    sourceRank: index + 1,
  }));

  const fullTextStatusCounts = built.reduce((acc, item) => {
    const status = item.fullTextAvailable ? "ok" : (item.fullTextFetchStatus || "not requested");
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const fullTextAttempted = built.filter((item) => item.fullTextFetchStatus && item.fullTextFetchStatus !== "not requested").length;

  return {
    originalQuery,
    intentName: intent.name,
    intentLabel: intent.label,
    retrievalQuery: retrievalQueries[0],
    retrievalQueries,
    retrievalStats,
    requested,
    fetchLimit,
    rawResultCount,
    duplicateCandidateCount,
    rawCount: built.length,
    filteredOutCount: built.length - filterResult.filtered.length,
    intentMode: filterResult.intentMode,
    intentFilteredOutCount: filterResult.intentFilteredOutCount,
    fullTextSurfaces: built.filter((item) => item.fullTextAvailable).length,
    fullTextAttempted,
    fullTextStatusCounts,
    candidates: finalCandidates,
  };
}

function pickRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const nested = payload.data || payload.result || payload.response;
  if (nested && nested !== payload) {
    const rows = pickRows(nested);
    if (rows.length) return rows;
  }

  for (const key of ["all", "results", "ranked", "matches", "items", "candidates", "scores", "top", "top_5"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  return [];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeArbiterRows(payload, candidates) {
  const candidateTexts = candidates.map((candidate) => candidate.surface);
  const textToCandidate = new Map(candidateTexts.map((text, index) => [text, candidates[index]]));
  const rows = pickRows(payload);

  const parsed = [];
  rows.forEach((row, i) => {
    if (typeof row === "number") {
      const score = finiteNumber(row);
      if (score !== null && candidates[i]) parsed.push({ candidate: candidates[i], score, raw: row });
      return;
    }

    if (typeof row === "string") {
      const candidate = textToCandidate.get(row) || candidates[i];
      if (candidate) parsed.push({ candidate, score: null, raw: row });
      return;
    }

    if (!row || typeof row !== "object") return;

    const score = finiteNumber(
      row.score ??
      row.coherence ??
      row.similarity ??
      row.value_score ??
      row.rank_score ??
      row.match ??
      row.value
    );

    const idxRaw = row.index ?? row.idx ?? row.i ?? row.candidate_index ?? row.candidateIndex;
    const idx = Number.isInteger(Number(idxRaw)) ? Number(idxRaw) : null;

    let text = row.text ?? row.candidate ?? row.content ?? row.document ?? row.input ?? row.label ?? row.name;
    if (typeof text !== "string") text = null;

    let candidate = text ? textToCandidate.get(text) : null;
    if (!candidate && idx !== null && candidates[idx]) candidate = candidates[idx];
    if (!candidate && candidates[i] && !text) candidate = candidates[i];

    if (!candidate && text) {
      const needle = stripHtml(text).slice(0, 120);
      candidate = candidates.find((item) => item.surface.includes(needle) || needle.includes(item.surface.slice(0, 80)));
    }

    if (candidate && score !== null) parsed.push({ candidate, score, raw: row });
  });

  return parsed
    .filter((row) => row.candidate && Number.isFinite(row.score))
    .sort((a, b) => b.score - a.score);
}

const LEGAL_CONCEPTS = [
  "retaliation", "public employee", "employee", "speech", "official duties", "whistleblower", "first amendment", "protected speech", "adverse action",
  "stale warrant", "warrant", "informant", "tip", "probable cause", "reliability", "affidavit", "staleness", "confidential informant",
  "contract", "damages cap", "consequential damages", "bargaining power", "unconscionability", "limitation of liability",
  "premises liability", "constructive notice", "hazard", "negligence", "duty", "breach", "causation",
  "qualified immunity", "clearly established", "state action", "inventory search", "summary judgment", "due process", "discrimination", "hostile work environment"
];

function inferWhyMatched(query, item) {
  const q = stripHtml(query).toLowerCase();
  const surface = `${item.title} ${item.surface}`.toLowerCase();
  const concepts = [];

  for (const concept of LEGAL_CONCEPTS) {
    if (q.includes(concept) && surface.includes(concept)) concepts.push(concept);
  }

  const coverage = item.intentCoverage || { groups: [], presentCount: 0, proximity: [], proximityCount: 0 };
  const coverageNames = coverage.groups?.filter((group) => group.present).map((group) => group.name) || [];
  const proximityNames = coverage.proximity?.filter((pair) => pair.present).map((pair) => pair.pair) || [];

  const qTokens = uniqueTokens(query)
    .filter((token) => token.length > 3 && !STOP_WORDS.has(token));
  const overlaps = qTokens.filter((token) => surface.includes(token)).slice(0, 6);
  const merged = [...new Set([...coverageNames, ...concepts, ...overlaps])].slice(0, 8);

  if (merged.length && proximityNames.length) return `Matched on ${merged.join(", ")}; required concepts appear near each other in the selected case text.`;
  if (merged.length >= 3) return `Matched on ${merged.join(", ")}.`;
  if (merged.length === 2) return `Matched on ${merged[0]} and ${merged[1]}.`;
  if (merged.length === 1) return `Matched on ${merged[0]} plus nearby case language in the selected authority surface.`;
  return `Matched by ARBITER against the available ${item.surfaceKind}; open the case to verify legal fit.`;
}

async function arbiterRank(query, candidates, arbiterUrl, returnLimit) {
  const endpoint = normalizeArbiterUrl(arbiterUrl);
  const texts = candidates.map((candidate) => candidate.surface);
  const top = Math.max(1, Math.min(candidates.length, MAX_RETURN, Number(returnLimit) || DEFAULT_RETURN));

  const started = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "ngrok-skip-browser-warning": "true"
    },
    body: JSON.stringify({
      query,
      candidates: texts,
      top_k: top,
      top_n: top,
      limit: top,
      use_freq: true
    })
  });

  const bodyText = await response.text();
  let payload;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    payload = { error: bodyText };
  }

  if (!response.ok) {
    throw new Error(`ARBITER ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const rows = normalizeArbiterRows(payload, candidates);
  if (!rows.length) {
    throw new Error(`ARBITER response had no parseable score rows: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  const uniqueRows = [];
  const seenAuthorityKeys = new Set();
  for (const row of rows) {
    const key = row.candidate.caseKey || row.candidate.clusterId || row.candidate.id || normalizeCaseKey(row.candidate);
    if (seenAuthorityKeys.has(key)) continue;
    seenAuthorityKeys.add(key);
    uniqueRows.push(row);
    if (uniqueRows.length >= top) break;
  }

  const ranked = uniqueRows.map((row, index) => {
    const item = row.candidate;
    return {
      rank: index + 1,
      score: row.score,
      id: item.id,
      clusterId: item.clusterId,
      title: item.title,
      court: item.court,
      courtId: item.courtId,
      courtScope: item.courtScope,
      dateFiled: item.dateFiled,
      citation: item.citation,
      citeCount: item.citeCount,
      docketNumber: item.docketNumber,
      url: item.url,
      surfaceKind: item.surfaceKind,
      surfaceQuality: item.surfaceQuality,
      fullTextAvailable: item.fullTextAvailable,
      fullTextLength: item.fullTextLength,
      fullTextFetchStatus: item.fullTextFetchStatus,
      caseKey: item.caseKey,
      surface: item.surface,
      snippet: item.bestSnippet,
      whyMatched: inferWhyMatched(query, item),
      keywordScore: item.keywordScore,
      intentCoverage: item.intentCoverage || null
    };
  });

  return {
    endpoint,
    latencyMs: Date.now() - started,
    ranked,
    rawShape: Object.keys(payload || {})
  };
}

app.get("/api/cases", async (req, res) => {
  try {
    const query = String(req.query.q || "").trim();
    if (!query) return res.status(400).json({ error: "Missing q" });

    const bundle = await courtListenerCandidates(query, Number(req.query.limit || DEFAULT_CANDIDATES), {
      semantic: String(req.query.semantic || "false") === "true",
      jurisdiction: String(req.query.jurisdiction || "all"),
      dateFrom: String(req.query.dateFrom || ""),
      dateTo: String(req.query.dateTo || ""),
      includeNoise: String(req.query.includeNoise || "false") === "true",
      fetchFullText: String(req.query.fetchFullText || "true") !== "false",
      returnLimit: Number(req.query.returnLimit || DEFAULT_RETURN),
    });
    res.json({ query, ...bundle, count: bundle.candidates.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/search", async (req, res) => {
  const started = Date.now();
  try {
    const query = String(req.body?.query || "").trim();
    if (!query) return res.status(400).json({ error: "Missing query" });

    const candidateLimit = Number(req.body?.candidateLimit || DEFAULT_CANDIDATES);
    const returnLimit = Number(req.body?.returnLimit || DEFAULT_RETURN);
    const semantic = Boolean(req.body?.semantic);
    const arbiterUrl = normalizeArbiterUrl(req.body?.arbiterUrl || DEFAULT_ARBITER_URL);

    const bundle = await courtListenerCandidates(query, candidateLimit, {
      semantic,
      jurisdiction: String(req.body?.jurisdiction || "all"),
      dateFrom: String(req.body?.dateFrom || ""),
      dateTo: String(req.body?.dateTo || ""),
      includeNoise: Boolean(req.body?.includeNoise),
      fetchFullText: req.body?.fetchFullText !== false,
      returnLimit,
    });

    if (!bundle.candidates.length) {
      return res.json({
        query,
        retrievalQuery: bundle.retrievalQuery,
        retrievalQueries: bundle.retrievalQueries,
        intent: bundle.intentLabel,
        intentMode: bundle.intentMode,
        rawCandidateCount: bundle.rawCount,
        rawResultCount: bundle.rawResultCount,
        duplicateCandidateCount: bundle.duplicateCandidateCount,
        retrievalStats: bundle.retrievalStats,
        filteredOutCount: bundle.filteredOutCount,
        intentFilteredOutCount: bundle.intentFilteredOutCount,
        fullTextSurfaces: bundle.fullTextSurfaces,
        fullTextAttempted: bundle.fullTextAttempted,
        fullTextStatusCounts: bundle.fullTextStatusCounts,
        count: 0,
        ranked: [],
        message: "CourtListener returned no usable candidates after filters. Try All jurisdictions, disable full-text surfaces, or enable noisy/admin authorities."
      });
    }

    const arbiter = await arbiterRank(query, bundle.candidates, arbiterUrl, returnLimit);

    res.json({
      query,
      retrievalQuery: bundle.retrievalQuery,
      retrievalQueries: bundle.retrievalQueries,
      intent: bundle.intentLabel,
      intentName: bundle.intentName,
      intentMode: bundle.intentMode,
      mode: "query_vs_case_surfaces",
      source: "CourtListener search API + optional opinion text API",
      rawCandidateCount: bundle.rawCount,
      rawResultCount: bundle.rawResultCount,
      duplicateCandidateCount: bundle.duplicateCandidateCount,
      retrievalStats: bundle.retrievalStats,
      fetchLimit: bundle.fetchLimit,
      filteredOutCount: bundle.filteredOutCount,
      intentFilteredOutCount: bundle.intentFilteredOutCount,
      fullTextSurfaces: bundle.fullTextSurfaces,
      fullTextAttempted: bundle.fullTextAttempted,
      fullTextStatusCounts: bundle.fullTextStatusCounts,
      candidateCount: bundle.candidates.length,
      returnedCount: arbiter.ranked.length,
      arbiterEndpoint: arbiter.endpoint,
      arbiterLatencyMs: arbiter.latencyMs,
      totalLatencyMs: Date.now() - started,
      ranked: arbiter.ranked
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Authority Finder running at http://localhost:${PORT}`);
  console.log(`ARBITER endpoint default: ${normalizeArbiterUrl(DEFAULT_ARBITER_URL)}`);
});
