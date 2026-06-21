// api/test-keys.js — kiểm tra Groq + Mistral + GitHub token
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const results = { groq: [], mistral: [], github: null, env: {} }

  results.env = {
    VITE_GROQ_API_KEY:    process.env.VITE_GROQ_API_KEY    ? process.env.VITE_GROQ_API_KEY.slice(0,16)+'...'    : 'MISSING',
    VITE_GROQ_API_KEY_2:  process.env.VITE_GROQ_API_KEY_2  ? process.env.VITE_GROQ_API_KEY_2.slice(0,16)+'...'  : 'MISSING',
    VITE_MISTRAL_API_KEY: process.env.VITE_MISTRAL_API_KEY ? process.env.VITE_MISTRAL_API_KEY.slice(0,16)+'...' : 'MISSING',
    VITE_GH_TOKEN:        process.env.VITE_GH_TOKEN        ? process.env.VITE_GH_TOKEN.slice(0,12)+'...'        : 'MISSING',
  }

  // Test Groq
  const groqKeys = [process.env.VITE_GROQ_API_KEY, process.env.VITE_GROQ_API_KEY_2].filter(Boolean)
  for (const key of groqKeys) {
    try {
      const t0 = Date.now()
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role:'user', content:'Say OK' }], max_tokens: 5 })
      })
      const d = await r.json()
      results.groq.push({ key: key.slice(0,16)+'...', ok: r.ok, status: r.status, response: d.choices?.[0]?.message?.content || d.error?.message, ms: Date.now()-t0 })
    } catch(e) { results.groq.push({ key: key.slice(0,16)+'...', ok: false, error: e.message }) }
  }

  // Test Mistral
  const mistralKey = process.env.VITE_MISTRAL_API_KEY
  if (mistralKey) {
    try {
      const t0 = Date.now()
      const r = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${mistralKey}` },
        body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role:'user', content:'Say OK' }], max_tokens: 5 })
      })
      const d = await r.json()
      results.mistral.push({ ok: r.ok, status: r.status, response: d.choices?.[0]?.message?.content || d.message, ms: Date.now()-t0 })
    } catch(e) { results.mistral.push({ ok: false, error: e.message }) }
  } else {
    results.mistral.push({ ok: false, error: 'VITE_MISTRAL_API_KEY chưa set trong Vercel' })
  }

  // Test GitHub
  try {
    const r = await fetch('https://api.github.com/repos/hoangductudhbk-hub/VATM-PMU', {
      headers: { Authorization: `token ${process.env.VITE_GH_TOKEN}`, 'User-Agent': 'VATM-PMU/1.0' }
    })
    const d = await r.json()
    results.github = { ok: r.ok, status: r.status, repo: d.full_name || d.message, private: d.private }
  } catch(e) { results.github = { ok: false, error: e.message } }

  return res.status(200).json(results)
}
