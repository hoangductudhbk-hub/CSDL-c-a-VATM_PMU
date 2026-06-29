// api/gemini-proxy.js — Cổng trung gian DUY NHẤT cho mọi lệnh gọi Gemini.
// Lý do tồn tại: Google chặn key dạng "AQ." (Authorization key) gọi trực tiếp
// từ trình duyệt (CORS/bảo mật) — bắt buộc phải gọi từ server. File này nhận
// yêu cầu từ client, gọi Gemini ở server, trả kết quả về — không expose key
// ra trình duyệt nữa (đúng khuyến nghị bảo mật chính thức của Google).
//
// SỬA 22/6/2026: gemini-2.0-flash và gemini-2.0-flash-lite đã bị Google khai
// tử 1/6/2026 — mọi request qua model cũ đều lỗi từ đó tới nay. Đổi sang
// gemini-2.5-flash / gemini-2.5-flash-lite.

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
        // STOP = model viết xong bình thường. Các finishReason khác (RECITATION
        // — Google tự chặn khi output "chép" quá giống văn bản huấn luyện, rất
        // dễ gặp với các cụm cố định trong văn bản hành chính; SAFETY; MAX_TOKENS...)
        // vẫn có thể có "text" không rỗng nhưng bị CẮT CỤT giữa câu/giữa field
        // JSON — đã gặp thực tế gây lỗi "Unterminated string" ở client. Không
        // được coi đây là thành công dù text không rỗng — thử key/model khác.
        if (text && finishReason && finishReason !== 'STOP') {
          console.warn(`[gemini-proxy] ${model} dừng bất thường (finishReason=${finishReason}) — bỏ qua, thử key/model khác. Text nhận được (100 ký tự đầu): ${text.slice(0, 100)}`)
          continue
        }
        if (text) return res.status(200).json({ ok: true, text })
      } catch (e) {
        console.error(`[gemini-proxy] lỗi ${model}:`, e.message)
        continue
      }
    }
  }

  return res.status(502).json({ error: 'Tất cả key/model Gemini đều thất bại. Xem log Vercel để biết lỗi cụ thể.' })
}
