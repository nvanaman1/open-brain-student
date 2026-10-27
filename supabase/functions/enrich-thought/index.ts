// enrich-thought — runs automatically whenever a new thought is saved.
// Triggered by a Supabase Database Webhook (INSERT on the thoughts table).
// Asks the AI, via the call-llm gateway, for tags, a category and a summary,
// then writes them back onto the thought.
//
// Never calls an AI provider directly — everything goes through call-llm.

import { createClient } from "jsr:@supabase/supabase-js@2";

const CATEGORIES = ["idea", "learning", "question", "reference", "plan", "reflection"];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Webhooks should never "fail" — always answer 200 so Supabase doesn't retry forever.
const ok = (note: string) =>
  new Response(JSON.stringify({ ok: true, note }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

// Pull a JSON object out of the AI's reply, even if it wrapped it in ```json fences.
function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  try {
    const payload = await req.json();
    const record = payload?.record;

    if (!record?.id) return ok("No record in payload — skipped.");

    // Already categorised (e.g. a weekly digest saves itself with category 'digest').
    // Don't overwrite it.
    if (record.category || record.enriched_at) return ok("Already categorised — skipped.");

    const content: string = (record.content ?? "").toString().trim();
    if (content.length < 20) return ok("Content too short — skipped.");

    const systemPrompt =
      "You label personal notes. Reply with ONLY a JSON object, no other text.";

    const prompt = `Read this note and return JSON with exactly these keys:
- "tags": an array of 3 to 5 short lowercase tags (1-3 words each)
- "category": exactly one of: ${CATEGORIES.join(", ")}
- "summary": one sentence, max 25 words

Note:
"""
${content.slice(0, 8000)}
"""`;

    // Call the gateway — with the Authorization header, or it gets a 401.
    const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({
        prompt,
        systemPrompt,
        maxTokens: 300,
        userId: record.user_id,   // bill this call to the thought's owner
        source: "enrich-thought",
      }),
    });

    if (!llmRes.ok) {
      console.error("call-llm returned", llmRes.status, await llmRes.text());
      return ok("Gateway error — skipped.");
    }

    const { text } = await llmRes.json();
    const parsed = extractJson(text ?? "");
    if (!parsed) {
      console.error("Could not parse AI reply:", text);
      return ok("Unparseable AI reply — skipped.");
    }

    // Clean up whatever the AI gave us.
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5)
      : [];
    const rawCategory = String(parsed.category ?? "").toLowerCase().trim();
    const category = CATEGORIES.includes(rawCategory) ? rawCategory : "reflection";
    const summary = String(parsed.summary ?? "").trim().slice(0, 300) || null;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { error } = await supabase
      .from("thoughts")
      .update({ tags, category, summary, enriched_at: new Date().toISOString() })
      .eq("id", record.id);

    if (error) {
      console.error("Update failed:", error);
      return ok("Database update failed.");
    }

    return ok(`Enriched thought ${record.id}`);
  } catch (err) {
    console.error("enrich-thought crashed:", err);
    return ok("Unexpected error — logged.");
  }
});