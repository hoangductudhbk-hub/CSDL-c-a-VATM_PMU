// api/openrouter-proxy.js — Proxy cho OpenRouter (Vision/text), key luôn ở server.
// Dùng làm phương án dự phòng Vision ĐỘC LẬP — chạy qua hạ tầng riêng của
// OpenRouter, không bị ảnh hưởng nếu Groq/Gemini lỗi route hoặc hết quota.
// Model: Llama 4 Maverick bản :free — hỗ trợ ảnh + text, KHÔNG liên quan đến
// việc Groq khai tử bản họ tự host (đây là model chạy trên hạ tầng OpenRouter).
//
// Client gửi: { messages, maxTokens? } — giống format groq-proxy.js (OpenAI-compatible)

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const MODEL = 'meta-llama/llama-4-maverick:free'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { messages, maxTokens = 1000 } = req.body || {}
  if (!messages?.length) return res.status(400).json({ error: 'Thiếu messages' })

  const key = process.env.VITE_OPENROUTER_API_KEY
  if (!key) return res.status(500).json({ error: 'Server chưa cấu hình VITE_OPENROUTER_API_KEY' })

  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 25000)
    const r = await fetch(OPENROUTER_URL, {
      signal: ctrl.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.1, messages }),
    })
    clearTimeout(timer)

    if (r.status === 429) return res.status(502).json({ error: 'OpenRouter hết quota hôm nay' })
    if (!r.ok) {
      const err = await r.text()
      console.error(`[openrouter-proxy] HTTP ${r.status}: ${err.slice(0, 300)}`)
      return res.status(502).json({ error: `OpenRouter lỗi ${r.status}` })
    }

    const data = await r.json()
    const text = data.choices?.[0]?.message?.content || ''
    if (text) return res.status(200).json({ ok: true, text })
    return res.status(502).json({ error: 'OpenRouter không trả về nội dung' })
  } catch (e) {
    console.error('[openrouter-proxy] lỗi:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
