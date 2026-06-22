// api/ocr-page.js
// Nhận 1 ảnh base64 (trang PDF đã render từ browser) → Groq Vision → trả text
// Client tự render PDF bằng pdfjs (browser canvas), loại bỏ hoàn toàn mupdf trên server

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { imageBase64, fileName = '', pageLabel = '' } = req.body || {}
  if (!imageBase64) return res.status(400).json({ error: 'Thiếu imageBase64' })

  const keys = [
    process.env.VITE_GROQ_API_KEY,
    process.env.VITE_GROQ_API_KEY_2,
    process.env.VITE_GROQ_API_KEY_3,
  ].filter(Boolean)

  if (!keys.length) return res.status(500).json({ error: 'Chưa cấu hình VITE_GROQ_API_KEY' })

  const MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
  const prompt = `Bạn là chuyên gia OCR văn bản hành chính Việt Nam.
Đọc toàn bộ nội dung trong ảnh trang này và trả về dạng markdown.
File: "${fileName}", Trang: ${pageLabel}

Quy tắc:
- Giữ nguyên cấu trúc: tiêu đề, số điều/khoản, bảng biểu, chữ ký
- Bảng → markdown table
- Số liệu, ngày tháng, tên người/cơ quan: CHÉP CHÍNH XÁC
- KHÔNG thêm bình luận, KHÔNG thêm "Dưới đây là nội dung..."
- Chỉ trả nội dung văn bản`

  for (const key of keys) {
    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4096,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
              { type: 'text', text: prompt },
            ],
          }],
        }),
      })

      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 2000))
        continue
      }
      if (!resp.ok) {
        console.error('[ocr-page] Groq error', resp.status, await resp.text().catch(() => ''))
        continue
      }

      const data = await resp.json()
      const text = data.choices?.[0]?.message?.content || ''
      if (text.length < 10) continue // kết quả rỗng, thử key khác
      return res.json({ ok: true, text })
    } catch (e) {
      console.error('[ocr-page] fetch error:', e.message)
      continue
    }
  }

  return res.status(422).json({ error: 'OCR thất bại - hết key Groq hoặc ảnh không đọc được' })
}
