// api/groq-proxy.js — Server-side proxy cho Groq (text + vision).
// Key KHÔNG bao giờ gửi về browser — chỉ đọc từ process.env trên Vercel.
// Client gửi: { messages, maxTokens?, vision?: true }
// Server gọi Groq, trả về: { ok: true, text } hoặc { error }

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const TEXT_MODEL = 'llama-3.3-70b-versatile'
// ⚠️ DEPRECATED 27/6/2026, NGỪNG HOẠT ĐỘNG 17/7/2026 (email Groq).
// Model thay thế Groq đề xuất (GPT-OSS-120B/Qwen3.6-27B) KHÔNG đọc được ảnh —
// model vision thay thế (Qwen3-VL) chỉ dành Enterprise. Trước 17/7/2026 phải
// xác nhận lại: nếu Groq chưa có model vision free-tier mới, gỡ nhánh vision
// này khỏi groq-proxy, chỉ dùng Gemini Vision (useAI.js đã ưu tiên Gemini trước).
const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

const getGroqKeys = () => [
  process.env.VITE_GROQ_API_KEY,
  process.env.VITE_GROQ_API_KEY_2,
  process.env.VITE_GROQ_API_KEY_3,
].filter(Boolean)

// Mỗi key có timeout riêng 25s, thử tối đa 3 key nối tiếp → tệ nhất 75 giây,
// vượt xa mức 10s mặc định của Hobby nếu không khai báo riêng → dễ bị Vercel
// "giết" giữa lúc đang thử, ra lỗi 502 dù bản thân Groq/key không hề lỗi.
export const config = { maxDuration: 60 }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { messages, maxTokens = 1000, vision = false } = req.body || {}
  if (!messages?.length) return res.status(400).json({ error: 'Thiếu messages' })

  const keys = getGroqKeys()
  if (!keys.length) return res.status(500).json({ error: 'Server chưa cấu hình GROQ_API_KEY' })

  const model = vision ? VISION_MODEL : TEXT_MODEL

  for (const key of keys) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 25000)
      const r = await fetch(GROQ_URL, {
        signal: ctrl.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature: 0.1, messages }),
      })
      clearTimeout(timer)
      if (r.status === 429) continue
      if (!r.ok) {
        const err = await r.text()
        console.error(`[groq-proxy] HTTP ${r.status}: ${err.slice(0, 200)}`)
        continue
      }
      const data = await r.json()
      const choice = data.choices?.[0]
      const text = choice?.message?.content || ''
      const finishReason = choice?.finish_reason
      // 'stop' = hoàn thành bình thường. Các finish_reason khác ('length',
      // 'content_filter'...) có thể trả text không rỗng nhưng bị cắt cụt giữa
      // câu/giữa field JSON — không coi là thành công, thử key khác (cùng lỗi
      // đã gặp và sửa ở gemini-proxy.js, vì cả 2 đều chỉ check "text rỗng hay
      // không" mà bỏ qua finish reason).
      if (text && finishReason && finishReason !== 'stop') {
        console.warn(`[groq-proxy] Dừng bất thường (finish_reason=${finishReason}) — bỏ qua, thử key khác. Text nhận được (100 ký tự đầu): ${text.slice(0, 100)}`)
        continue
      }
      if (text) return res.status(200).json({ ok: true, text })
    } catch (e) {
      console.error(`[groq-proxy] lỗi:`, e.message)
      continue
    }
  }

  return res.status(502).json({ error: 'Tất cả Groq key đều thất bại' })
}