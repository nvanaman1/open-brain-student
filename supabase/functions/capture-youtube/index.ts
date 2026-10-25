// ============================================================================
// CAPTURE-YOUTUBE — paste a YouTube link, the spoken transcript gets saved.
//
// WHY THIS FILE IS COMPLICATED — worth reading before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a data centre — which is exactly what a Supabase edge function is. Code
// that works on your laptop fails once deployed. That is not a bug in your
// code; it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA    — a service built for this. Fetches from home internet
//                    connections, so it gets real transcripts. Free tier
//                    covers ~100 videos/month. Skipped if you have no key.
//   2. INNERTUBE   — YouTube's own internal app API. We identify as the iPhone
//                    and Android apps, which YouTube often serves properly
//                    even from a data centre. No key needed.
//   3. DESCRIPTION — if no captions exist anywhere, fall back to the title and
//                    description so you still capture something. Clearly
//                    labelled, so you know it is not what was actually said.
//
// For now we save the transcript as-is. Summarising needs an AI key, which
// comes in Level 5 — that level's enrichment step will summarise these later.
// ============================================================================

import { createClient } from 'npm:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? ''
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? '' // optional

const MAX_SAVED_CHARS = 50_000

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

// Turn things like &amp; &#39; back into real characters
const ENTITIES: Record<string, string> = {
  nbsp: ' ', quot: '"', apos: "'", lt: '<', gt: '>',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
  iexcl: '¡', iquest: '¿', ntilde: 'ñ', aacute: 'á', eacute: 'é', iacute: 'í',
  oacute: 'ó', uacute: 'ú', uuml: 'ü',
}
function decodeEntities(s: string): string {
  return s
    .replace(/&([a-zA-Z]+);/g, (m, name) => (name === 'amp' ? m : ENTITIES[name] ?? m))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
}

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: string
}

// Pull the 11-character video id out of any YouTube link shape
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.trim().match(p)
    if (m) return m[1]
  }
  return null
}

// The title, via YouTube's oEmbed — no key needed, almost always works
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) },
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return data.title as string
    }
  } catch { /* fall through */ }
  return `Video ${videoId}`
}

// ── ROUTE 1 — Supadata ─────────────────────────────────────────────────────
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null
  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) },
    )
    if (!res.ok) {
      // 402 almost always means the free monthly quota is used up
      console.log(`[youtube] Supadata HTTP ${res.status} — trying next route`)
      return null
    }
    const data = await res.json()
    const segments: Array<{ text?: string }> = Array.isArray(data?.content) ? data.content : []
    const transcript = (segments.length
      ? segments.map((s) => s.text ?? '').join(' ')
      : typeof data?.content === 'string' ? data.content : '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ── ROUTE 2 (and 3) — Innertube, YouTube's internal app API ───────────────
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// caption list even from a data centre, where the normal web page gives nothing.
// deno-lint-ignore no-explicit-any
type Json = any

async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: { clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US' },
    },
  ]

  let best: Json = null

  for (const client of clients) {
    try {
      const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
        body: JSON.stringify({ context: { client: client.context }, videoId }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }
      const result: Json = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      if (Array.isArray(tracks) && tracks.length > 0) {
        best = result
        break
      }
      // Keep the first response — even without captions it carries the description
      if (!best) best = result
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks: Json[] = best?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    if (tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        tracks.find((t) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t) => t.languageCode === 'en') ??
        tracks.find((t) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })
      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
          .map((m) => decodeEntities(m[1]))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = best?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = Array.isArray(details?.keywords) ? details.keywords.join(', ') : ''
    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : ''].filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }
    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    // Who is asking? Read from their login token — never from the request body.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) return jsonResponse({ ok: false, error: 'Not signed in' }, 401)

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A YouTube link is required' }, 400)
    }

    const videoId = extractVideoId(url)
    if (!videoId) {
      return jsonResponse({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order — first success wins
    const result = (await fromSupadata(videoUrl)) ?? (await fromInnertube(videoId))
    if (!result) {
      return jsonResponse({
        ok: false,
        error: 'Could not read anything from that video. It may be private, age-restricted, or region-locked.',
      }, 422)
    }

    const label = result.hasTranscript
      ? 'Transcript'
      : 'Description only — no transcript was available for this video'
    const content =
      `📹 ${title}\n${videoUrl}\n\n(${label})\n\n${result.content.slice(0, MAX_SAVED_CHARS)}`

    // Write with the admin (service role) client — so user_id MUST be set by us
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    const { data: thought, error: insertError } = await admin
      .from('thoughts')
      .insert({
        user_id: user.id,
        content,
        source: 'youtube',
        metadata: {
          title,
          video_id: videoId,
          video_url: videoUrl,
          has_transcript: result.hasTranscript,
          fetched_via: result.source,
        },
      })
      .select('id')
      .single()
    if (insertError) throw insertError

    // Also keep the full transcript in thought_sources, if that table exists.
    // Non-fatal: the thought above is already saved either way.
    try {
      const { error: srcError } = await admin.from('thought_sources').insert({
        thought_id: thought.id,
        user_id: user.id,
        source_text: result.content,
        source_kind: result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
        char_count: result.content.length,
        truncated: false,
      })
      if (srcError) console.log('[youtube] thought_sources skipped:', srcError.message)
    } catch (e) {
      console.log('[youtube] thought_sources skipped:', String(e))
    }

    return jsonResponse({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      preview: content.slice(0, 240) + '…',
    })
  } catch (err) {
    console.error('[youtube] Failed:', err)
    const msg = err instanceof Error ? err.message : (err as { message?: string })?.message ?? String(err)
    return jsonResponse({ ok: false, error: msg }, 500)
  }
})