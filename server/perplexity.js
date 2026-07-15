// Perplexity Sonar — broad, undirected horizon scanning. Twelve fixed themed
// queries, weekly recency, json_schema response format with a tolerant parser
// (Perplexity's structured output is not fully reliable).
const KEY = (process.env.PERPLEXITY_API_KEY || "").trim();
export const perplexityEnabled = () => !!KEY;

// Every query names the human-relationship angle explicitly and excludes
// generic AI industry news — the scan is about the social fabric, not the tech.
// These are the shipped defaults; the live set is user-editable in scan_themes
// (seeded from this array) and passed into perplexityScan by the orchestrator.
export const DEFAULT_THEMES = [
  { key: "companions", query: "AI companion and AI friend apps as relationships: user attachment stories, incidents involving emotional dependence, companion shutdowns and user grief, changes to how companions handle intimacy (Replika, Character.AI, Talkie and similar). Exclude generic AI product or model news with no relationship angle." },
  { key: "governance", query: "Regulation, litigation or policy specifically about AI companions and human relationships: chatbots and minors, addictive companion design, AI romance fraud, emotional-manipulation rules, age verification for companion apps. Exclude general AI regulation like copyright, jobs or safety benchmarks." },
  { key: "research", query: "New studies about parasocial attachment to AI, AI companionship and loneliness, chatbots substituting or supporting human friendship and romance, effects of AI relationships on wellbeing or social skills. Exclude AI research with no human-relationship dimension." },
  { key: "grief_tech", query: "Grief technology and digital resurrection as relationships: deadbots, AI avatars of deceased people, mourning and continuing bonds with AI recreations, memorial chatbot services and controversies." },
  { key: "market", query: "Business of artificial intimacy: funding, revenue or acquisitions of AI companion, AI dating and grief-tech products, monetisation of AI relationships, dating apps adding or losing to AI companions. Exclude general AI industry funding with no intimacy or relationship product." },
  { key: "discourse", query: "Cultural debate about humans forming relationships with AI: essays, backlash, normalization of AI romance and friendship, AI companions in family or religious life, loneliness discourse tied to AI. Exclude general AI hype or doom commentary without the relationship theme." },
  { key: "clones", query: "AI clones and personas of real people as relationship objects: licensed or unauthorized AI versions of celebrities, influencers and creators that fans talk to, virtual influencers with parasocial followings, creators selling AI girlfriend/boyfriend versions of themselves, deepfake romance and impersonation in relationships. Exclude deepfake stories that are purely about misinformation or politics." },
  { key: "youth_family", query: "Children, teens and families with AI companions: minors forming attachments to chatbots, school and parental responses, family conflict or bonding over AI companions, AI imaginary friends, toys with companion AI, custody or parenting debates about AI relationships. Exclude general ed-tech or AI-in-classroom news without a relationship angle." },
  { key: "therapy", query: "Therapy and mental-health chatbots as relationships: people substituting AI for therapists or confidants, emotional reliance on wellbeing bots, clinical or regulatory reactions to AI emotional support, incidents where AI counseling affected a human relationship or crisis. Exclude generic digital-health funding or product news." },
  { key: "elder_care", query: "AI companions for older adults and care relationships: companion robots or chatbots in eldercare, loneliness interventions with AI for seniors, families outsourcing contact to AI, caregiving norms changing around social AI. Exclude medical-device or diagnostics news without a companionship role." },
  { key: "work_school", query: "Social AI reshaping everyday relationship norms in workplaces and schools: AI colleagues or study buddies people bond with, etiquette and friendship norms around always-available AI, people preferring AI interaction over coworkers or classmates, institutional rules about befriending AI. Exclude pure productivity-tool coverage." },
  { key: "fandom", query: "Virtual beings, VTubers, romance games and fandom parasociality with AI: AI-powered idols and streamers with devoted fans, dating sims and romance games adding AI characters, fan communities forming around AI personas, parasocial dynamics of AI-generated influencers. Exclude game-industry business news without the fan-relationship angle." },
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

async function queryTheme(theme, recency) {
  const r = await fetch("https://api.perplexity.ai/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
    body: JSON.stringify({
      model: "sonar",
      messages: [
        { role: "system", content: "You are a horizon-scanning assistant for a foresight research team studying parasocial AI — how AI reshapes human relationships and social structures. Return only signals where the human-relationship or social-fabric angle is explicit: AI companionship, artificial intimacy, attachment, loneliness, grief tech, AI and family or romance, social norms around AI relationships. REJECT generic AI news (model releases, chips, enterprise tools, coding assistants, general AI policy) unless the item is specifically about AI's effect on human relationships. Return up to 10 distinct, dated, citable signals with a real, specific source URL each — prioritize items published in the last 48 hours over older ones, and prefer the primary source over syndicated copies of the same story. Return JSON only." },
        { role: "user", content: theme.query },
      ],
      search_recency_filter: recency,
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
// themes: rows with {key, query} (the user-editable scan_themes set);
// recency: day | week | month.
export async function perplexityScan({ themes = DEFAULT_THEMES, recency = "week" } = {}) {
  const candidates = [], errors = [];
  if (!KEY) return { candidates, errors: [{ step: "perplexity", message: "PERPLEXITY_API_KEY unset" }] };
  for (const theme of themes) {
    try {
      candidates.push(...await queryTheme(theme, recency));
    } catch (e) {
      errors.push({ step: "perplexity", source: theme.key, message: e.message });
    }
  }
  return { candidates, errors };
}
