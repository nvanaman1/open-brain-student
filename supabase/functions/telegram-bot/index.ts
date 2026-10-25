// ─────────────────────────────────────────────────────────────
// Open Brain — Telegram bot (Supabase Edge Function)
//
// Telegram delivers every message sent to your bot to this function
// (that delivery is the "webhook"). The function then:
//   • /search word  or  ?word  → searches your thoughts
//   • /recent                  → lists your 5 newest thoughts
//   • anything else            → saves it as a new thought
//
// Secrets it reads (set in Supabase → Edge Functions → Secrets):
//   TELEGRAM_BOT_TOKEN        — from BotFather
//   OWNER_USER_ID             — your UID from Authentication → Users
//   TELEGRAM_ALLOWED_CHAT_ID  — your Telegram chat ID (the bot tells you this)
// Provided automatically by Supabase (do not add these yourself):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// ─────────────────────────────────────────────────────────────

import { createClient } from 'npm:@supabase/supabase-js@2'

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_ALLOWED_CHAT_ID') ?? ''
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

// The service role key is a master key: it skips the Level 2 security rule.
// That's why EVERY query below is manually limited to OWNER_USER_ID.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

// Always answer Telegram with 200 OK, even on errors.
// Otherwise Telegram assumes delivery failed and keeps re-sending the same message.
function ok() {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Telegram rejects messages over 4096 characters
    body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
  })
}

function preview(text: string, max = 220) {
  const clean = (text ?? '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? clean.slice(0, max) + '…' : clean
}

function formatRows(rows: { content: string; created_at: string }[]) {
  return rows
    .map((r, i) => {
      const date = r.created_at
        ? new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : ''
      return `${i + 1}. ${preview(r.content)}${date ? `  (${date})` : ''}`
    })
    .join('\n\n')
}

const HELP_TEXT = [
  '🧠 Open Brain',
  '',
  'Just type anything → I save it to your brain.',
  '/search word  (or  ?word) → find thoughts containing that word',
  '/recent → your 5 newest thoughts',
  '/help → this message',
].join('\n')

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return ok()

  let chatId: number | undefined

  try {
    const update = await req.json()
    const message = update.message ?? update.edited_message
    if (!message?.chat?.id) return ok() // not a chat message (e.g. a status update)

    chatId = message.chat.id as number

    // ── The lock: only your own chat is allowed in ──────────────
    if (!ALLOWED_CHAT_ID) {
      await reply(
        chatId,
        `Almost ready! Your chat ID is:\n\n${chatId}\n\n` +
          'Add it in Supabase → Edge Functions → Secrets with the name ' +
          'TELEGRAM_ALLOWED_CHAT_ID, then message me again.',
      )
      return ok()
    }
    if (String(chatId) !== ALLOWED_CHAT_ID.trim()) {
      return ok() // a stranger — ignore silently
    }

    if (!OWNER_USER_ID) {
      await reply(chatId, '⚠️ The OWNER_USER_ID secret is missing in Supabase.')
      return ok()
    }

    if (!message.text) {
      await reply(chatId, 'I can only save text messages for now.')
      return ok()
    }

    const text = String(message.text).trim()

    // ── /start or /help ─────────────────────────────────────────
    if (/^\/(start|help)(@\w+)?$/i.test(text)) {
      await reply(chatId, HELP_TEXT)
      return ok()
    }

    // ── /recent ─────────────────────────────────────────────────
    if (/^\/recent(@\w+)?$/i.test(text)) {
      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error
      await reply(
        chatId,
        data && data.length ? `🕑 Your latest thoughts:\n\n${formatRows(data)}` : 'Your brain is empty so far.',
      )
      return ok()
    }

    // ── /search word  or  ?word ─────────────────────────────────
    if (/^\/search(@\w+)?(\s|$)/i.test(text) || text.startsWith('?')) {
      const query = text.startsWith('?')
        ? text.slice(1).trim()
        : text.replace(/^\/search(@\w+)?/i, '').trim()

      if (!query) {
        await reply(chatId, 'What should I search for? Try:  /search marketing   or   ?marketing')
        return ok()
      }

      // Escape characters that have special meaning in a LIKE search
      const safe = query.replace(/[\\%_]/g, (m) => '\\' + m)

      const { data, error } = await admin
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .ilike('content', `%${safe}%`)
        .order('created_at', { ascending: false })
        .limit(5)
      if (error) throw error

      await reply(
        chatId,
        data && data.length
          ? `🔎 Results for "${query}":\n\n${formatRows(data)}`
          : `Nothing found for "${query}".`,
      )
      return ok()
    }

    // ── Anything else: save it as a thought ─────────────────────
    const { error } = await admin.from('thoughts').insert({
      user_id: OWNER_USER_ID, // without this the row would be saved with no owner, invisible to your app
      content: text,
      source: 'telegram',
      metadata: {
        telegram_message_id: message.message_id,
        telegram_chat_id: chatId,
      },
    })
    if (error) throw error

    await reply(chatId, '🧠 Saved to your brain.')
  } catch (err) {
    console.error('telegram-bot error:', err)
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
    if (chatId) {
      try {
        await reply(chatId, `⚠️ Something went wrong: ${msg}`)
      } catch (_) {
        // even the error reply failed — nothing more we can do
      }
    }
  }

  return ok()
})