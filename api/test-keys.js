// api/test-keys.js — kiểm tra Gemini keys (SDK) + GitHub token
import { GoogleGenerativeAI } from '@google/generative-ai'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const results = { gemini_sdk: [], github: null, env: {} }

  results.env = {
    VITE_GEMINI_API_KEY:   process.env.VITE_GEMINI_API_KEY   ? process.env.VITE_GEMINI_API_KEY.slice(0,15)+'...'   : 'MISSING',
    VITE_GEMINI_API_KEY_2: process.env.VITE_GEMINI_API_KEY_2 ? process.env.VITE_GEMINI_API_KEY_2.slice(0,15)+'...' : 'MISSING',
    VITE_GEMINI_API_KEY_3: process.env.VITE_GEMINI_API_KEY_3 ? process.env.VITE_GEMINI_API_KEY_3.slice(0,15)+'...' : 'MISSING',
    VITE_GH_TOKEN:         process.env.VITE_GH_TOKEN         ? process.env.VITE_GH_TOKEN.slice(0,12)+'...'         : 'MISSING',
  }

  // Test từng key với @google/generative-ai SDK
  const gemKeys = [
    process.env.VITE_GEMINI_API_KEY,
    process.env.VITE_GEMINI_API_KEY_2,
    process.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)

  for (const key of gemKeys) {
    try {
      const t0 = Date.now()
      const genAI = new GoogleGenerativeAI(key)
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' })
      const result = await model.generateContent('Say "OK" in one word.')
      const text = result.response.text()
      results.gemini_sdk.push({ key: key.slice(0,15)+'...', ok: true, response: text.trim(), ms: Date.now()-t0 })
    } catch(e) {
      results.gemini_sdk.push({ key: key.slice(0,15)+'...', ok: false, error: e.message.slice(0,300) })
    }
  }

  // Test GitHub token
  const ghToken = process.env.VITE_GH_TOKEN
  try {
    const r = await fetch('https://api.github.com/repos/hoangductudhbk-hub/VATM-PMU', {
      headers: { Authorization: `token ${ghToken}`, 'User-Agent': 'VATM-PMU/1.0' }
    })
    const d = await r.json()
    results.github = { status: r.status, ok: r.ok, repo: d.full_name || d.message }
  } catch(e) {
    results.github = { ok: false, error: e.message }
  }

  return res.status(200).json(results)
}
