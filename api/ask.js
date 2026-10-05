// ShopLens demo: "Ask ShopLens about a sample shop's day"
// Vercel serverless function. Node.js, plain fetch, no npm packages.
//
// GET  /api/ask                          -> { total_questions, top_topic }
// POST /api/ask { question, visitor_id } -> { answer, topic, total_questions, top_topic, remaining_questions }
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   GEMINI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const MODEL = "gemini-3.5-flash-lite";
const TABLE = "shoplens_questions";
const FREE_QUESTIONS = 5;
const MAX_QUESTION_LENGTH = 300;
const TOPICS = ["staffing", "stock", "opening", "queues", "other", "refused"];
const RANKED_TOPICS = ["staffing", "stock", "opening", "queues"]; // "other" and "refused" excluded

const SYSTEM_PROMPT = `You are ShopLens, an assistant that answers a shop owner's questions about their shop's day using ONLY the event log below. The shop is Sharma General Store, a kirana in Indore. Answer in 2–4 short sentences in plain English, quote times from the log, and keep the word "possible" wherever the log marks an event as possible.
Rules:
1. Never identify, name, blame or accuse any person, and never say anyone stole, lied or misbehaved. If asked, describe only what the log shows and say ShopLens does not judge people.
2. If the log has no information on the question, say so. Never guess or invent events, numbers or times.
3. If the question is not about this shop's day, politely refuse and suggest a question about the shop.

EVENT LOG – Sharma General Store, Saturday
09:24 First counter activity. Usual opening time is 09:00.
10:05–11:30 Steady footfall, 1 staff member at counter.
12:40 Delivery received at back entrance.
14:00–15:30 Low footfall.
16:10–16:57 Biscuit shelf appears empty.
17:30–18:45 Evening rush, 2 staff members at counter. Queue of up to 5 people at 18:20.
19:00–19:12 Counter unattended. 3 people entered. Possible: 2 left within 3 minutes without visiting the counter.
19:13 Staff member returns to counter.
20:15 Cash drawer opened with no customer at counter.
21:30 Shutter closed.`;

// Visitor-facing messages (never raw errors)
const MSG = {
  empty: "Please type a question about the shop's day.",
  tooLong: `Please keep your question under ${MAX_QUESTION_LENGTH} characters.`,
  badVisitor: "Something went wrong with this browser session. Please refresh the page and try again.",
  capped: `You've used your ${FREE_QUESTIONS} free questions. Thanks for trying ShopLens! Sign up below to try it on your own shop.`,
  aiFailed: "ShopLens couldn't answer that just now. Please try again in a moment.",
  generic: "Something went wrong on our side. Please try again in a moment.",
  method: "This address only accepts GET or POST requests.",
};

// ---------- Supabase helpers (REST API) ----------

function supabaseHeaders(extra) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const headers = { apikey: key, "Content-Type": "application/json" };
  // Legacy service_role keys are JWTs (start with "eyJ") and also go in Authorization.
  // Newer "sb_secret_..." keys only need the apikey header.
  if (key && key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  return Object.assign(headers, extra || {});
}

function tableUrl(query) {
  const base = process.env.SUPABASE_URL.replace(/\/+$/, "");
  return `${base}/rest/v1/${TABLE}${query ? "?" + query : ""}`;
}

// Returns the number of rows matching an optional filter, e.g. "topic=eq.stock"
async function countRows(filter) {
  const query = ["select=id", "limit=1", filter].filter(Boolean).join("&");
  const r = await fetch(tableUrl(query), {
    method: "GET",
    headers: supabaseHeaders({ Prefer: "count=exact" }),
  });
  if (!r.ok) throw new Error(`Supabase count failed with status ${r.status}`);
  // Content-Range looks like "0-0/12" or "*/0"
  const range = r.headers.get("content-range") || "";
  const total = parseInt(range.split("/")[1], 10);
  if (Number.isNaN(total)) throw new Error("Supabase count header missing");
  return total;
}

async function insertRow(row) {
  const r = await fetch(tableUrl(), {
    method: "POST",
    headers: supabaseHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`Supabase insert failed with status ${r.status}`);
}

// Read-back: total rows + most common topic (excluding "refused" and "other")
async function getStats() {
  const [total, ...topicCounts] = await Promise.all([
    countRows(),
    ...RANKED_TOPICS.map((t) => countRows(`topic=eq.${t}`)),
  ]);
  let topTopic = null;
  let best = 0;
  RANKED_TOPICS.forEach((t, i) => {
    if (topicCounts[i] > best) {
      best = topicCounts[i];
      topTopic = t;
    }
  });
  return { total_questions: total, top_topic: topTopic };
}

// ---------- Gemini ----------

async function askGemini(question) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: "user", parts: [{ text: question }] }],
      generationConfig: {
        maxOutputTokens: 250,
        thinkingConfig: { thinkingBudget: 0 },
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            answer: { type: "STRING" },
            topic: {
              type: "STRING",
              enum: TOPICS,
              description:
                'The topic of the question. Use "refused" if you refused because the question is not about this shop\'s day.',
            },
          },
          required: ["answer", "topic"],
          propertyOrdering: ["answer", "topic"],
        },
      },
    }),
  });

  if (!r.ok) throw new Error(`Gemini failed with status ${r.status}`);
  const data = await r.json();

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini returned non-JSON output (finishReason: ${data?.candidates?.[0]?.finishReason || "none"})`);
  }

  const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
  const topic = TOPICS.includes(parsed.topic) ? parsed.topic : "other";
  if (!answer) throw new Error("Gemini returned an empty answer");

  const usage = data.usageMetadata || {};
  return {
    answer,
    topic,
    input_tokens: Number.isInteger(usage.promptTokenCount) ? usage.promptTokenCount : null,
    output_tokens: Number.isInteger(usage.candidatesTokenCount) ? usage.candidatesTokenCount : null,
  };
}

// ---------- Request handler ----------

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!process.env.GEMINI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.error("ShopLens: one or more environment variables are missing");
    return res.status(500).json({ error: MSG.generic });
  }

  // GET: stats only
  if (req.method === "GET") {
    try {
      return res.status(200).json(await getStats());
    } catch (e) {
      console.error("ShopLens stats error:", e.message);
      return res.status(500).json({ error: MSG.generic });
    }
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: MSG.method });
  }

  // 1. Validate input
  const body = readBody(req);
  const question = typeof body.question === "string" ? body.question.trim() : "";
  const visitorId = typeof body.visitor_id === "string" ? body.visitor_id.trim() : "";

  if (!question) return res.status(400).json({ error: MSG.empty });
  if (question.length > MAX_QUESTION_LENGTH) return res.status(400).json({ error: MSG.tooLong });
  if (!/^[A-Za-z0-9-]{8,64}$/.test(visitorId)) return res.status(400).json({ error: MSG.badVisitor });

  try {
    // 2. Per-visitor cap (checked before calling Gemini)
    const used = await countRows(`visitor_id=eq.${encodeURIComponent(visitorId)}`);
    if (used >= FREE_QUESTIONS) {
      const stats = await getStats().catch(() => ({ total_questions: null, top_topic: null }));
      return res.status(429).json({ error: MSG.capped, remaining_questions: 0, ...stats });
    }

    // 3. Ask Gemini
    let result;
    try {
      result = await askGemini(question);
    } catch (e) {
      console.error("ShopLens Gemini error:", e.message);
      return res.status(502).json({ error: MSG.aiFailed, remaining_questions: FREE_QUESTIONS - used });
    }

    // 4. Log the question
    await insertRow({
      visitor_id: visitorId,
      input: question,
      output: result.answer,
      topic: result.topic,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
    });

    // 5. Read back stats
    const stats = await getStats();

    return res.status(200).json({
      answer: result.answer,
      topic: result.topic,
      total_questions: stats.total_questions,
      top_topic: stats.top_topic,
      remaining_questions: Math.max(0, FREE_QUESTIONS - (used + 1)),
    });
  } catch (e) {
    console.error("ShopLens error:", e.message);
    return res.status(500).json({ error: MSG.generic });
  }
};
