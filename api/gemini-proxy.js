// api/gemini-proxy.js — Cổng trung gian DUY NHẤT cho mọi lệnh gọi Gemini.
// Lý do tồn tại: Google chặn key dạng "AQ." (Authorization key) gọi trực tiếp
// từ trình duyệt (CORS/bảo mật) — bắt buộc phải gọi từ server. File này nhận
// yêu cầu từ client, gọi Gemini ở server, trả kết quả về — không expose key
// ra trình duyệt nữa (đúng khuyến nghị bảo mật chính thức của Google).

const getGeminiKeys = () => [
  process.env.VITE_GEMINI_API_KEY,
  process.env.VITE_GEMINI_API_KEY_2,
  process.env.VITE_GEMINI_API_KEY_3,
].filter(Boolean)

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

  // Client gửi: { prompt } (text thuần) HOẶC { parts } (mảng part — dùng khi cần gửi PDF/ảnh)
  const { prompt, parts, maxTokens = 1500 } = req.body || {}
  if (!prompt && !parts) return res.status(400).json({ error: 'Thiếu prompt hoặc parts' })

  const contentParts = parts || [{ text: prompt }]
  const keys = getGeminiKeys()
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']

  if (!keys.length) {
    return res.status(500).json({ error: 'Server chưa cấu hình VITE_GEMINI_API_KEY' })
  }

  for (const key of keys) {
    for (const model of models) {
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
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (text) return res.status(200).json({ ok: true, text })
      } catch (e) {
        console.error(`[gemini-proxy] lỗi ${model}:`, e.message)
        continue
      }
    }
  }

  return res.status(502).json({ error: 'Tất cả key/model Gemini đều thất bại. Xem log Vercel để biết lỗi cụ thể.' })
}
