// api/gemini-proxy.js — Cổng trung gian DUY NHẤT cho mọi lệnh gọi Gemini.
// Lý do tồn tại: Google chặn key dạng "AQ." gọi trực tiếp từ trình duyệt
// (CORS/bảo mật) — bắt buộc phải gọi từ server.
//
// SỬA 22/6/2026: đổi sang gemini-2.5-flash / gemini-2.5-flash-lite.
// SỬA 1/7/2026: thêm KEY_4 và KEY_5 — luân phiên 5 key từ 5 Gmail khác nhau,
// tổng quota ~7500 req/ngày. Key nào 429/lỗi tự chuyển key tiếp theo.

const getGeminiKeys = () => [
  process.env.VITE_GEMINI_API_KEY,
  process.env.VITE_GEMINI_API_KEY_2,
  process.env.VITE_GEMINI_API_KEY_3,
  process.env.VITE_GEMINI_API_KEY_4,
  process.env.VITE_GEMINI_API_KEY_5,
].filter(Boolean)

export const config = { maxDuration: 60 }

const geminiUrl = (model, key) =>
  key.startsWith('AIzaSy')
    ? `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

const geminiHeaders = (key) => {
  const h = { 'Content-Type': 'application/json' }
  if (!key.startsWith('AIzaSy')) h['x-goog-api-key'] = key
  return h
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { prompt, parts, maxTokens = 1500 } = req.body || {}
  if (!prompt && !parts) return res.status(400).json({ error: 'Thiếu prompt hoặc parts' })

  const contentParts = parts || [{ text: prompt }]
  const keys = getGeminiKeys()
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']

  if (!keys.length) {
    return res.status(500).json({ error: 'Server chưa cấu hình VITE_GEMINI_API_KEY' })
  }

  for (const model of models) {
    for (const key of keys) {
      try {
        const r = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: geminiHeaders(key),
          body: JSON.stringify({
            contents: [{ parts: contentParts }],
            generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
          }),
        })
        if (r.status === 429) continue
        if (!r.ok) {
          const errText = await r.text()
          console.error(`[gemini-proxy] ${model} HTTP ${r.status}: ${errText.slice(0, 300)}`)
          continue
        }
        const data = await r.json()
        const candidate = data.candidates?.[0]
        const text = candidate?.content?.parts?.[0]?.text || ''
        const finishReason = candidate?.finishReason
        if (text && finishReason && finishReason !== 'STOP') {
          console.warn(`[gemini-proxy] ${model} finishReason=${finishReason} — thử key/model khác`)
          continue
        }
        if (text) return res.status(200).json({ ok: true, text })
      } catch (e) {
        console.error(`[gemini-proxy] lỗi ${model}:`, e.message)
        continue
      }
    }
  }

  return res.status(502).json({ error: 'Tất cả key/model Gemini đều thất bại. Xem log Vercel.' })
}
