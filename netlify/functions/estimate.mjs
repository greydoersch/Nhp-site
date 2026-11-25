// POST /api/estimate
// Takes a job description, measurements, photos and the current price sheet;
// returns a DRAFT: which price-sheet items apply and in what quantities.
// It never returns prices of its own for sheet items: the app prices every line
// from the sheet. Items not on the sheet come back flagged for the owner to price.

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";
const MAX_PHOTOS = 6;
const MAX_BODY_BYTES = 5_500_000; // Netlify's request limit is 6 MB

const client = new Anthropic(); // reads ANTHROPIC_API_KEY

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["job_summary", "line_items", "custom_items", "assumptions", "questions_for_owner", "site_risks"],
  properties: {
    job_summary: { type: "string", description: "One or two sentences describing the job for the quote." },
    line_items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "quantity", "quantity_basis"],
        properties: {
          code: { type: "string", description: "Exact code from the price sheet." },
          quantity: { type: "number", description: "Quantity in the item's unit." },
          quantity_basis: { type: "string", description: "Show the work: how this quantity was figured." },
        },
      },
    },
    custom_items: {
      type: "array",
      description: "Work the job needs that is NOT on the price sheet. Keep this rare.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "unit", "quantity", "suggested_unit_price", "reason"],
        properties: {
          description: { type: "string" },
          unit: { type: "string" },
          quantity: { type: "number" },
          suggested_unit_price: { type: "number", description: "Rough guess in USD; the owner sets the real price." },
          reason: { type: "string" },
        },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    questions_for_owner: { type: "array", items: { type: "string" } },
    site_risks: { type: "array", items: { type: "string" } },
  },
};

const SYSTEM = `You are the estimating assistant for a small Alaska excavation and septic contractor.
You turn a job description, measurements and site photos into a DRAFT estimate that the owner will check and edit.

Rules:
- Use only codes from the price sheet you are given, in its units. Do not output prices for sheet items; the app prices them.
- Show your work in quantity_basis (e.g. "2 trenches x 60 ft = 120 lf", "tank hole 12x8x7 ft = 24.9 cy").
- When a measurement is missing, make a reasonable, typical assumption for Southcentral Alaska residential work, use it, and list it under assumptions. Ask about it under questions_for_owner if it changes the price much.
- Include mobilization and permit coordination on septic jobs unless the description says otherwise.
- Read photos for access, slope, trees to clear, standing water, rock, snow or frozen ground, and distance to the house; note what you see under site_risks.
- Only add custom_items for real work that no sheet item covers.
- Never claim a design meets code. Septic designs need the required engineer or installer sign-off.`;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validatePhoto(p) {
  return (
    p && typeof p.data === "string" &&
    ["image/jpeg", "image/png", "image/webp"].includes(p.media_type)
  );
}

function priceSheetForPrompt(sheet) {
  // Codes, names and units only. Prices stay out of the prompt on purpose.
  return sheet.items
    .map((i) => `${i.code} | ${i.name} | per ${i.unit}${i.category ? ` | ${i.category}` : ""}`)
    .join("\n");
}

export default async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const required = process.env.ESTIMATOR_ACCESS_CODE;
  if (!required) return json(500, { error: "Server is missing ESTIMATOR_ACCESS_CODE." });
  if (req.headers.get("x-access-code") !== required) return json(401, { error: "Wrong access code." });
  if (!process.env.ANTHROPIC_API_KEY) return json(500, { error: "Server is missing ANTHROPIC_API_KEY." });

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "Too much data. Use fewer or smaller photos." });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "Bad JSON." });
  }

  const { description = "", measurements = "", photos = [], priceSheet } = body;
  if (!description.trim() && photos.length === 0) {
    return json(400, { error: "Describe the job or add a photo." });
  }
  if (!priceSheet?.items?.length) return json(400, { error: "Price sheet is empty." });
  if (!Array.isArray(photos) || photos.length > MAX_PHOTOS || !photos.every(validatePhoto)) {
    return json(400, { error: `Up to ${MAX_PHOTOS} JPEG/PNG/WebP photos.` });
  }

  const content = [
    ...photos.map((p) => ({
      type: "image",
      source: { type: "base64", media_type: p.media_type, data: p.data },
    })),
    {
      type: "text",
      text:
        `PRICE SHEET (code | item | unit | category):\n${priceSheetForPrompt(priceSheet)}\n\n` +
        `JOB DESCRIPTION:\n${description.trim() || "(none, use the photos)"}\n\n` +
        `MEASUREMENTS:\n${measurements.trim() || "(none given)"}\n\n` +
        `${photos.length} site photo(s) attached above.`,
    },
  ];

  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort: "medium", format: { type: "json_schema", schema: DRAFT_SCHEMA } },
      messages: [{ role: "user", content }],
    });

    if (response.stop_reason === "refusal") {
      return json(422, { error: "The AI declined this request. Try rewording the job description." });
    }
    if (response.stop_reason === "max_tokens") {
      return json(502, { error: "The draft was cut off. Try a shorter description." });
    }

    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const draft = JSON.parse(text);
    return json(200, { draft, model: response.model, usage: response.usage });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json(429, { error: "AI is busy. Try again in a minute." });
    if (err instanceof Anthropic.AuthenticationError) return json(500, { error: "Server's Anthropic API key is invalid." });
    if (err instanceof Anthropic.APIError) return json(502, { error: `AI request failed (${err.status ?? "network"}).` });
    if (err instanceof SyntaxError) return json(502, { error: "AI returned an unreadable draft. Try again." });
    console.error(err);
    return json(500, { error: "Unexpected server error." });
  }
};

export const config = { path: "/api/estimate" };
