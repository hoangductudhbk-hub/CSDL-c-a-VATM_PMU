// api/test-keys.js — kiểm tra Gemini keys + GitHub token, không cần PDF
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const results = { gemini: [], github: null, env: {} }

  // Kiểm tra env vars có tồn tại không
  results.env = {
    VITE_GEMINI_API_KEY:   process.env.VITE_GEMINI_API_KEY   ? process.env.VITE_GEMINI_API_KEY.slice(0,15)+'...' : 'MISSING',
    VITE_GEMINI_API_KEY_2: process.env.VITE_GEMINI_API_KEY_2 ? process.env.VITE_GEMINI_API_KEY_2.slice(0,15)+'...' : 'MISSING',
    VITE_GEMINI_API_KEY_3: process.env.VITE_GEMINI_API_KEY_3 ? process.env.VITE_GEMINI_API_KEY_3.slice(0,15)+'...' : 'MISSING',
    VITE_GH_TOKEN:         process.env.VITE_GH_TOKEN         ? process.env.VITE_GH_TOKEN.slice(0,12)+'...'  : 'MISSING',
    VITE_GH_OWNER:         process.env.VITE_GH_OWNER         || 'MISSING',
    VITE_GH_REPO:          process.env.VITE_GH_REPO          || 'MISSING',
  }

  // Test từng Gemini key với text prompt đơn giản (không cần PDF)
  const gemKeys = [
    process.env.VITE_GEMINI_API_KEY,
    process.env.VITE_GEMINI_API_KEY_2,
    process.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)

  const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent'

  for (const key of gemKeys) {
    const isOld = key.startsWith('AIzaSy')
    const url = isOld ? `${GEMINI_BASE}?key=${key}` : GEMINI_BASE
    const headers = { 'Content-Type': 'application/json' }
    if (!isOld) headers['x-goog-api-key'] = key

    try {
      const t0 = Date.now()
      const r = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say "OK" in one word.' }] }],
          generationConfig: { maxOutputTokens: 10 }
        })
      })
      const ms = Date.now() - t0
      if (r.ok) {
        const data = await r.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '?'
        results.gemini.push({ key: key.slice(0,15)+'...', status: r.status, ok: true, response: text.trim(), ms })
      } else {
        const body = await r.text()
        results.gemini.push({ key: key.slice(0,15)+'...', status: r.status, ok: false, error: body.slice(0,300), ms })
      }
    } catch(e) {
      results.gemini.push({ key: key.slice(0,15)+'...', ok: false, error: e.message })
    }
  }

  // Test GitHub token — list repo
  const ghToken = process.env.VITE_GH_TOKEN
  const owner   = process.env.VITE_GH_OWNER || 'hoangductudhbk-hub'
  const repo    = process.env.VITE_GH_REPO  || 'VATM-PMU'
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: {
        Authorization: `token ${ghToken}`,
        'User-Agent': 'VATM-PMU/1.0'
      }
    })
    const data = await r.json()
    results.github = { status: r.status, ok: r.ok, repo: data.full_name || data.message }
  } catch(e) {
    results.github = { ok: false, error: e.message }
  }

  return res.status(200).json(results)
}
