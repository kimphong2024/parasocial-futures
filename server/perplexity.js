// Perplexity Sonar — broad, undirected horizon scanning. Six fixed themed
// queries, weekly recency, json_schema response format with a tolerant parser
// (Perplexity's structured output is not fully reliable).
const KEY = (process.env.PERPLEXITY_API_KEY || "").trim();
export const perplexityEnabled = () => !!KEY;

// Every query names the human-relationship angle explicitly and excludes
// generic AI industry news — the scan is about the social fabric, not the tech.
export const THEMES = [
  { key: "companions", query: "AI companion and AI friend apps as relationships: user attachment stories, incidents involving emotional dependence, companion shutdowns and user grief, changes to how companions handle intimacy (Replika, Character.AI, Talkie and similar). Exclude generic AI product or model news with no relationship angle." },
  { key: "governance", query: "Regulation, litigation or policy specifically about AI companions and human relationships: chatbots and minors, addictive companion design, AI romance fraud, emotional-manipulation rules, age verification for companion apps. Exclude general AI regulation like copyright, jobs or safety benchmarks." },
  { key: "research", query: "New studies about parasocial attachment to AI, AI companionship and loneliness, chatbots substituting or supporting human friendship and romance, effects of AI relationships on wellbeing or social skills. Exclude AI research with no human-relationship dimension." },
  { key: "grief_tech", query: "Grief technology and digital resurrection as relationships: deadbots, AI avatars of deceased people, mourning and continuing bonds with AI recreations, memorial chatbot services and controversies." },
  { key: "market", query: "Business of artificial intimacy: funding, revenue or acquisitions of AI companion, AI dating and grief-tech products, monetisation of AI relationships, dating apps adding or losing to AI companions. Exclude general AI industry funding with no intimacy or relationship product." },
  { key: "discourse", query: "Cultural debate about humans forming relationships with AI: essays, backlash, normalization of AI romance and friendship, AI companions in family or religious life, loneliness discourse tied to AI. Exclude general AI hype or doom commentary without the relationship theme." },
];

const SIGNAL_SCHEMA = {
  type: "object",
  properties: {
    signals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          url: { type: "string" },
          source: { type: "string" },
          date: { type: "string" },
        },
        required: ["title", "summary", "url"],
      },
    },
  },
  required: ["signals"],
};

// Tolerant JSON extraction: whole parse → first {...} block → give up.
function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

async function queryTheme(theme) {
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: "You are a horizon-scanning assistant for a foresight research team studying parasocial AI — how AI reshapes human relationships and social structures. Return only signals where the human-relationship or social-fabric angle is explicit: AI companionship, artificial intimacy, attachment, loneliness, grief tech, AI and family or romance, social norms around AI relationships. REJECT generic AI news (model releases, chips, enterprise tools, coding assistants, general AI policy) unless the item is specifically about AI's effect on human relationships. Return distinct, dated, citable signals with a real, specific source URL each. Return JSON only." },
        { role: "user", content: theme.query },
      ],
      search_recency_filter: "week",
      response_format: { type: "json_schema", json_schema: { schema: SIGNAL_SCHEMA } },
    }),
  });
  if (!r.ok) throw new Error(`perplexity ${theme.key} ${r.status} ${(await r.text()).slice(0, 160)}`);
  const j = await r.json();
  const parsed = extractJson(j.choices?.[0]?.message?.content || "");
  if (!parsed?.signals) throw new Error(`perplexity ${theme.key}: unparseable response`);
  return parsed.signals
    .filter((s) => s && s.title && /^https?:\/\//.test(s.url || ""))
    .map((s) => ({ ...s, theme: theme.key }));
}

// Returns { candidates, errors } — one theme failing never kills the rest.
export async function perplexityScan() {
  const candidates = [], errors = [];
  if (!KEY) return { candidates, errors: [{ step: "perplexity", message: "PERPLEXITY_API_KEY unset" }] };
  for (const theme of THEMES) {
    try {
      candidates.push(...await queryTheme(theme));
    } catch (e) {
      errors.push({ step: "perplexity", source: theme.key, message: e.message });
    }
  }
  return { candidates, errors };
}
