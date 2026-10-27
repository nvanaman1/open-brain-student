// call-llm — the LLM gateway.
//
// To switch providers, change LLM_PROVIDER in Supabase secrets.
// Add the new provider's API key. No other code changes needed.
//
//   LLM_PROVIDER = anthropic | openai | google
//   LLM_MODEL    = the model name for that provider
//   Keys:  ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY
//
// Optional, for cost tracking (USD per 1 million tokens, from your
// provider's pricing page). If unset, cost is logged as 0 but token
// counts are still recorded:
//   LLM_PRICE_INPUT_PER_MTOK, LLM_PRICE_OUTPUT_PER_MTOK

import { createClient } from "jsr:@supabase/supabase-js@2";

type LlmResult = { text: string; promptTokens: number; completionTokens: number };

const JSON_HEADERS = { "Content-Type": "application/json" };

function requireEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`Missing secret: ${name}`);
  return v;
}

// ---------- Providers ----------

async function callAnthropic(model: string, prompt: string, system: string | undefined, maxTokens: number): Promise<LlmResult> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": requireEnv("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Anthropic error ${res.status}: ${JSON.stringify(data)}`);
  const text = (data.content ?? [])
    .filter((b: { type: string }) => b.type === "text")
    .map((b: { text: string }) => b.text)
    .join("");
  return {
    text,
    promptTokens: data.usage?.input_tokens ?? 0,
    completionTokens: data.usage?.output_tokens ?? 0,
  };
}

async function callOpenAI(model: string, prompt: string, system: string | undefined, maxTokens: number): Promise<LlmResult> {
  const messages = [
    ...(system ? [{ role: "system", content: system }] : []),
    { role: "user", content: prompt },
  ];
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${requireEnv("OPENAI_API_KEY")}`,
    },
    body: JSON.stringify({ model, messages, max_completion_tokens: maxTokens }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${JSON.stringify(data)}`);
  return {
    text: data.choices?.[0]?.message?.content ?? "",
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
  };
}

async function callGoogle(model: string, prompt: string, system: string | undefined, maxTokens: number): Promise<LlmResult> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": requireEnv("GOOGLE_API_KEY"),
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Google error ${res.status}: ${JSON.stringify(data)}`);
  const text = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p: { text?: string }) => p.text ?? "")
    .join("");
  return {
    text,
    promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

// ---------- Usage receipt (must never break the real call) ----------

function logUsage(row: {
  userId?: string; source?: string; model: string;
  promptTokens: number; completionTokens: number;
}) {
  const task = (async () => {
    try {
      if (!row.userId) return; // nobody to bill — skip quietly
      const inPrice = Number(Deno.env.get("LLM_PRICE_INPUT_PER_MTOK") ?? 0) || 0;
      const outPrice = Number(Deno.env.get("LLM_PRICE_OUTPUT_PER_MTOK") ?? 0) || 0;
      const cost = (row.promptTokens * inPrice + row.completionTokens * outPrice) / 1_000_000;

      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      await supabase.from("llm_usage").insert({
        user_id: row.userId,
        kind: "chat",
        model: row.model,
        source: row.source ?? null,
        prompt_tokens: row.promptTokens,
        completion_tokens: row.completionTokens,
        cost_usd: cost,
      });
    } catch (_err) {
      // Swallow everything. The AI already answered; a missing receipt is a shrug.
    }
  })();

  // Keep the function alive long enough to finish logging, without
  // making the caller wait for it.
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(task);
}

// ---------- Entry point ----------

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: JSON_HEADERS });
  }

  try {
    const body = await req.json();
    const { prompt, systemPrompt, model: modelOverride, maxTokens, userId, source } = body ?? {};

    if (!prompt || typeof prompt !== "string") {
      return new Response(JSON.stringify({ error: "Missing 'prompt'" }), { status: 400, headers: JSON_HEADERS });
    }

    const provider = (Deno.env.get("LLM_PROVIDER") ?? "anthropic").toLowerCase();
    const model = modelOverride ?? requireEnv("LLM_MODEL");
    const max = Number(maxTokens) > 0 ? Number(maxTokens) : 1024;

    let result: LlmResult;
    switch (provider) {
      case "anthropic": result = await callAnthropic(model, prompt, systemPrompt, max); break;
      case "openai":    result = await callOpenAI(model, prompt, systemPrompt, max); break;
      case "google":    result = await callGoogle(model, prompt, systemPrompt, max); break;
      default: throw new Error(`Unknown LLM_PROVIDER: ${provider}`);
    }

    logUsage({ userId, source, model, promptTokens: result.promptTokens, completionTokens: result.completionTokens });

    return new Response(JSON.stringify({ text: result.text }), { status: 200, headers: JSON_HEADERS });
  } catch (err) {
    console.error("call-llm failed:", err);
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: JSON_HEADERS },
    );
  }
});