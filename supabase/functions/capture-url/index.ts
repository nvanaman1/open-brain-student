// ============================================================================
// CAPTURE-URL — paste a link, the readable text of the page gets saved.
//
// WHY THIS RUNS ON THE SERVER: a web page in your browser is not allowed to
// fetch pages from other websites (that rule is called CORS). A server has no
// such limit. So your app hands the link to this function, and this function
// does the fetching.
//
// For now we save the page's text as-is. Summarising needs an AI key, which
// comes in Level 5 — that level's enrichment step will summarise these later.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

// All three are handed to edge functions automatically by Supabase.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''

const MAX_BYTES = 3_000_000 // don't try to swallow a giant page
const MAX_SAVED_CHARS = 50_000 // keep one thought a sensible size

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// Turn things like &amp; &rsquo; &#233; back into real characters
const ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
  iexcl: '¡', iquest: '¿', ntilde: 'ñ', Ntilde: 'Ñ',
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : ENTITIES[name] ?? m))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&') // last, so "&amp;lt;" stays "&lt;"
}

// Strip a web page down to its readable words
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i) ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : 'Untitled page'

  // If the page marks up its main article, use just that part
  const articleMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
  const body = articleMatch ? articleMatch[1] : html

  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)>/gi, '\n') // keep paragraph breaks
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ') // every other tag goes

  const cleaned = decodeEntities(text)
    .replace(/[ \t\u00a0]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim()

  return { title, text: cleaned }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request body,
    // or anyone could write into anyone else's brain.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A url is required' }, 400)
    }

    let parsed: URL
    try {
      parsed = new URL(url.trim())
    } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse bots
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may need a login or block automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'That page is too large to process' }, 413)
    }

    const { title, text } = htmlToText(raw)
    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself with ' +
          'JavaScript after loading, which a server cannot see. Copy the text in by hand instead.',
      }, 422)
    }

    const saved = text.slice(0, MAX_SAVED_CHARS)
    const content = `🔗 ${title}\n${parsed.hostname}\n\n${saved}`

    // Write with the admin (service role) client — so user_id MUST be set by us
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'url',
        metadata: { title, url: parsed.toString(), hostname: parsed.hostname, char_count: text.length },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Also keep the full text in thought_sources, if that table exists.
    // Non-fatal: the thought above is already saved either way.
    try {
      const { error: srcError } = await admin.from('thought_sources').insert({
        thought_id: thought.id,
        user_id: user.id,
        source_text: text,
        source_kind: 'web',
        char_count: text.length,
        truncated: false,
      })
      if (srcError) console.log('[url] thought_sources skipped:', srcError.message)
    } catch (e) {
      console.log('[url] thought_sources skipped:', String(e))
    }

    return jsonResponse({
      ok: true,
      title,
      hostname: parsed.hostname,
      char_count: text.length,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[url] Failed:', err)
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
    return jsonResponse({
      ok: false,
      error: msg.toLowerCase().includes('timeout') ? 'That page took too long to respond.' : msg,
    }, 500)
  }
})