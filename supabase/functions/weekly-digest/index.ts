// weekly-digest — runs on a schedule (pg_cron, Sundays 8am UTC by default).
// Reads the last 7 days of thoughts, groups them by category, asks the AI
// (via the call-llm gateway) for a weekly summary, and saves that summary
// back into the thoughts table with category 'digest'.
//
// Never calls an AI provider directly — everything goes through call-llm.

import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MIN_THOUGHTS = 5;
const PER_THOUGHT_CHARS = 1500;   // trim very long captures (e.g. video transcripts)
const TOTAL_CHARS = 60000;        // keep the whole prompt a sensible size

type Thought = {
  id: string;
  user_id: string;
  content: string;
  category: string | null;
  summary: string | null;
  tags: string[] | null;
  created_at: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from("thoughts")
      .select("id, user_id, content, category, summary, tags, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: true });

    if (error) throw error;

    // Leave out previous digests so the digest doesn't summarise itself.
    const thoughts = ((data ?? []) as Thought[]).filter((t) => t.category !== "digest");

    // Group by owner (normally just you).
    const byUser = new Map<string, Thought[]>();
    for (const t of thoughts) {
      if (!byUser.has(t.user_id)) byUser.set(t.user_id, []);
      byUser.get(t.user_id)!.push(t);
    }

    const results: Array<{ userId: string; status: string }> = [];

    for (const [userId, list] of byUser) {
      if (list.length < MIN_THOUGHTS) {
        console.log(`User ${userId}: only ${list.length} thoughts this week — not enough for a digest.`);
        results.push({ userId, status: `skipped (${list.length} thoughts)` });
        continue;
      }

      // Group by category so the AI sees the shape of the week.
      const byCategory = new Map<string, Thought[]>();
      for (const t of list) {
        const c = t.category ?? "uncategorised";
        if (!byCategory.has(c)) byCategory.set(c, []);
        byCategory.get(c)!.push(t);
      }

      let body = "";
      for (const [category, items] of byCategory) {
        body += `\n## ${category} (${items.length})\n`;
        for (const t of items) {
          const day = t.created_at.slice(0, 10);
          const text = (t.summary && t.content.length > PER_THOUGHT_CHARS)
            ? `${t.summary}\n${t.content.slice(0, PER_THOUGHT_CHARS)}…`
            : t.content.slice(0, PER_THOUGHT_CHARS);
          body += `- [${day}] ${text.replace(/\s+/g, " ").trim()}\n`;
          if (body.length > TOTAL_CHARS) break;
        }
        if (body.length > TOTAL_CHARS) break;
      }

      const systemPrompt =
        "You write a short, warm, honest weekly review of someone's own notes, addressed to them as 'you'. Plain text, no markdown tables.";

      const prompt = `Here are the notes I captured in my personal knowledge base over the last 7 days, grouped by category.

${body}

Write my weekly digest with these sections:

WHAT YOU WERE LEARNING
A short paragraph, organised by subject rather than by category.

KEY THEMES
3 to 5 bullet points, each one line.

A QUESTION YOU SEEM TO BE EXPLORING
One question, followed by one sentence on why it seems to be on your mind.

Keep it under 350 words. Only use what's in the notes — don't invent facts.`;

      const llmRes = await fetch(`${SUPABASE_URL}/functions/v1/call-llm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({
          prompt,
          systemPrompt,
          maxTokens: 900,
          userId,
          source: "weekly-digest",
        }),
      });

      if (!llmRes.ok) {
        const errText = await llmRes.text();
        console.error(`call-llm failed for ${userId}:`, llmRes.status, errText);
        results.push({ userId, status: `gateway error ${llmRes.status}` });
        continue;
      }

      const { text } = await llmRes.json();
      const weekOf = new Date().toISOString().slice(0, 10);
      const content = `WEEKLY DIGEST — week ending ${weekOf} (${list.length} thoughts)\n\n${(text ?? "").trim()}`;

      const { error: insertError } = await supabase.from("thoughts").insert({
        user_id: userId,
        content,
        category: "digest",
        tags: ["digest", "weekly"],
        summary: `Weekly digest of ${list.length} thoughts, week ending ${weekOf}.`,
        enriched_at: new Date().toISOString(),
      });

      if (insertError) {
        console.error(`Saving digest failed for ${userId}:`, insertError);
        results.push({ userId, status: "save failed" });
        continue;
      }

      console.log(`Digest saved for ${userId} (${list.length} thoughts).`);
      results.push({ userId, status: `digest saved (${list.length} thoughts)` });
    }

    if (byUser.size === 0) console.log("No thoughts in the last 7 days.");
    return json({ ok: true, results });
  } catch (err) {
    console.error("weekly-digest crashed:", err);
    return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 500);
  }
});