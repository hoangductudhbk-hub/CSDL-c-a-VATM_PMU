// api/test-keys.js — kiểm tra Groq + Gemini + Mistral + GitHub token
//
// SỬA 22/6/2026: thêm test Gemini. Trước đây file này KHÔNG test Gemini —
// đó là lý do gemini-2.0-flash/-lite chết từ 1/6/2026 mà 3 tuần sau mới phát
// hiện (qua việc đọc sai văn bản), không phải qua cảnh báo trực tiếp.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const results = { groq: [], gemini: [], mistral: [], openrouter: [], github: null, env: {} }

  results.env = {
    VITE_GROQ_API_KEY:    process.env.VITE_GROQ_API_KEY    ? process.env.VITE_GROQ_API_KEY.slice(0,16)+'...'    : 'MISSING',
    VITE_GROQ_API_KEY_2:  process.env.VITE_GROQ_API_KEY_2  ? process.env.VITE_GROQ_API_KEY_2.slice(0,16)+'...'  : 'MISSING',
    VITE_GEMINI_API_KEY:  process.env.VITE_GEMINI_API_KEY  ? process.env.VITE_GEMINI_API_KEY.slice(0,16)+'...'  : 'MISSING',
    VITE_GEMINI_API_KEY_2:process.env.VITE_GEMINI_API_KEY_2? process.env.VITE_GEMINI_API_KEY_2.slice(0,16)+'...': 'MISSING',
    VITE_MISTRAL_API_KEY: process.env.VITE_MISTRAL_API_KEY ? process.env.VITE_MISTRAL_API_KEY.slice(0,16)+'...' : 'MISSING',
    VITE_OPENROUTER_API_KEY: process.env.VITE_OPENROUTER_API_KEY ? process.env.VITE_OPENROUTER_API_KEY.slice(0,16)+'...' : 'MISSING',
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

  // Test Gemini — cả 2 model đang dùng trong process-batch.js/gemini-proxy.js,
  // để nếu Google khai tử model lần nữa thì biết NGAY ở đây, không phải đợi
  // phát hiện qua việc đọc sai văn bản như lần gemini-2.0-flash vừa qua.
  const geminiKeys = [process.env.VITE_GEMINI_API_KEY, process.env.VITE_GEMINI_API_KEY_2, process.env.VITE_GEMINI_API_KEY_3].filter(Boolean)
  const geminiModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']
  for (const key of geminiKeys) {
    for (const model of geminiModels) {
      try {
        const t0 = Date.now()
        const url = key.startsWith('AIzaSy')
          ? `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`
          : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
        const headers = { 'Content-Type': 'application/json' }
        if (!key.startsWith('AIzaSy')) headers['x-goog-api-key'] = key
        const r = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ contents: [{ parts: [{ text: 'Say OK' }] }], generationConfig: { maxOutputTokens: 5 } })
        })
        const d = await r.json()
        const text = d.candidates?.[0]?.content?.parts?.[0]?.text || d.error?.message
        results.gemini.push({ key: key.slice(0,16)+'...', model, ok: r.ok, status: r.status, response: text, ms: Date.now()-t0 })
      } catch(e) {
        results.gemini.push({ key: key.slice(0,16)+'...', model, ok: false, error: e.message })
      }
    }
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

  // Test OpenRouter (Llama 4 Maverick :free — lớp dự phòng Vision độc lập thứ 3)
  const orKey = process.env.VITE_OPENROUTER_API_KEY
  if (orKey) {
    try {
      const t0 = Date.now()
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${orKey}` },
        body: JSON.stringify({ model: 'meta-llama/llama-4-maverick:free', messages: [{ role:'user', content:'Say OK' }], max_tokens: 5 })
      })
      const d = await r.json()
      results.openrouter.push({ ok: r.ok, status: r.status, response: d.choices?.[0]?.message?.content || d.error?.message, ms: Date.now()-t0 })
    } catch(e) { results.openrouter.push({ ok: false, error: e.message }) }
  } else {
    results.openrouter.push({ ok: false, error: 'VITE_OPENROUTER_API_KEY chưa set trong Vercel' })
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