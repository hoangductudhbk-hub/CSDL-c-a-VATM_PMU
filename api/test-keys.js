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

  // Thử 3 cách auth khác nhau với key đầu tiên
  const testKey = gemKeys[0]
  if (testKey) {
    const body = JSON.stringify({
      contents: [{ parts: [{ text: 'Say "OK".' }] }],
      generationConfig: { maxOutputTokens: 10 }
    })
    const methods = [
      { name: '?key= param',        url: `${GEMINI_BASE}?key=${testKey}`,  headers: { 'Content-Type': 'application/json' } },
      { name: 'x-goog-api-key hdr', url: GEMINI_BASE,                      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': testKey } },
      { name: 'Bearer token',        url: GEMINI_BASE,                      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${testKey}` } },
      // v1 thay vì v1beta
      { name: '?key= v1',            url: `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${testKey}`, headers: { 'Content-Type': 'application/json' } },
    ]
    for (const m of methods) {
      try {
        const t0 = Date.now()
        const r = await fetch(m.url, { method: 'POST', headers: m.headers, body })
        const ms = Date.now() - t0
        const txt = await r.text()
        let parsed
        try { parsed = JSON.parse(txt) } catch { parsed = txt.slice(0, 200) }
        const answer = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || null
        results.gemini.push({ method: m.name, status: r.status, ok: r.ok, answer, error: r.ok ? null : txt.slice(0, 200), ms })
      } catch(e) {
        results.gemini.push({ method: m.name, ok: false, error: e.message })
      }
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
