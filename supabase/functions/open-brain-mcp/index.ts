// ============================================================
// Open Brain MCP Server
// A small program that lets MCP-compatible AIs (like Claude
// Desktop) search, list, and add thoughts in your brain.
// ============================================================

import { createClient } from "npm:@supabase/supabase-js@2";

// ---- Settings read from Supabase ----
// MCP_ACCESS_KEY is the password you created in Step 2.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are given to this
// function automatically by Supabase. You never set them yourself.
const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// ---- CORS headers ----
// These tell browsers and other clients that it's OK to call this server.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, content-type, mcp-session-id, mcp-protocol-version",
};

// Helper: send back a JSON response
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ---- The tool menu ----
// This is what Claude sees when it asks "what tools do you have?"
// Each tool has a name, a description (Claude reads this to decide
// when to use it), and the inputs it accepts.
const TOOLS = [
  {
    name: "search_thoughts",
    description:
      "Search the user's personal knowledge brain for thoughts containing a word or phrase. Returns up to 10 matches, newest first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Word or phrase to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recently saved thoughts in the user's brain.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "How many thoughts to return (default 10, max 50)",
        },
      },
    },
  },
  {
    name: "add_thought",
    description: "Save a new thought to the user's brain.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text of the thought to save" },
      },
      required: ["content"],
    },
  },
];

// ---- What each tool actually does ----
// Each one talks to your thoughts table and returns the result as text.
async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === "search_thoughts") {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("A search query is required.");
    const { data, error } = await supabase
      .from("thoughts")
      .select("id, content, created_at")
      .ilike("content", `%${query}%`) // case-insensitive "contains"
      .order("created_at", { ascending: false })
      .limit(10);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return `No thoughts found matching "${query}".`;
    return JSON.stringify(data, null, 2);
  }

  if (name === "list_recent") {
    const limit = Math.min(Math.max(Number(args.limit) || 10, 1), 50);
    const { data, error } = await supabase
      .from("thoughts")
      .select("id, content, created_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return "The brain has no thoughts yet.";
    return JSON.stringify(data, null, 2);
  }

  if (name === "add_thought") {
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("Content is required to save a thought.");
    const { data, error } = await supabase
      .from("thoughts")
  .insert({ content, user_id: Deno.env.get("OWNER_USER_ID") })
      .select("id, content, created_at")
      .single();
    if (error) throw new Error(error.message);
    return `Saved:\n${JSON.stringify(data, null, 2)}`;
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ---- Handle one JSON-RPC message ----
// "id" links a request to its answer. Messages with no id are
// "notifications" — the client is just informing us, no reply needed.
type RpcMessage = { jsonrpc: string; id?: string | number | null; method: string; params?: any };

async function handleMessage(msg: RpcMessage): Promise<unknown | null> {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    // Claude says hello when it first connects; we introduce ourselves.
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "open-brain", version: "1.0.0" },
        },
      };

    // A simple "are you there?" check.
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    // Claude asks for the tool menu.
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    // Claude asks us to run a tool.
    case "tools/call": {
      try {
        const text = await runTool(params?.name, params?.arguments ?? {});
        return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
      } catch (err) {
        // Tool errors go back to Claude as readable text so it can explain them.
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
            isError: true,
          },
        };
      }
    }

    default:
      if (isNotification) return null; // e.g. "notifications/initialized"
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ---- The front door ----
// Every request to this function comes through here.
Deno.serve(async (req) => {
  // Browsers sometimes send a "pre-check" OPTIONS request first.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Password check: the request must carry "Bearer <your MCP_ACCESS_KEY>".
  const auth = req.headers.get("Authorization") ?? "";
  if (!MCP_ACCESS_KEY || auth !== `Bearer ${MCP_ACCESS_KEY}`) {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
      401,
    );
  }

  // MCP messages arrive as POST requests only.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Read the message body.
  let body: RpcMessage | RpcMessage[];
  try {
    body = await req.json();
  } catch {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      400,
    );
  }

  // Sometimes several messages arrive together in a list.
  if (Array.isArray(body)) {
    const replies = (await Promise.all(body.map(handleMessage))).filter((r) => r !== null);
    return replies.length
      ? json(replies)
      : new Response(null, { status: 202, headers: corsHeaders });
  }

  // A single message.
  const reply = await handleMessage(body);
  return reply === null
    ? new Response(null, { status: 202, headers: corsHeaders }) // notification: "got it"
    : json(reply);
});