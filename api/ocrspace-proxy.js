// api/ocrspace-proxy.js — Proxy cho OCR.space (OCR thuần, không phải AI hiểu nội dung).
// Dùng làm lớp dự phòng THỨ 4 cho từng trang (sau Gemini/Groq/OpenRouter Vision,
// trước Tesseract) — miễn phí, giới hạn 500 request/ngày THEO IP (không theo key,
// nên nhiều key không giúp tăng hạn mức — xem ghi chú đã thảo luận).
//
// Khác với Gemini/Groq/OpenRouter: OCR.space chỉ trả TEXT THÔ, không hiểu/tổng hợp
// nội dung — chỉ nên dùng khi cả 3 lớp AI Vision đều thất bại, vì chất lượng đọc
// bảng/cấu trúc kém hơn nhiều so với AI Vision thực sự.
//
// Client gửi: { imageBase64 } (1 ảnh JPEG/lần — API OCR.space chỉ nhận 1 ảnh/request)

const OCR_SPACE_URL = 'https://api.ocr.space/parse/image'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { imageBase64 } = req.body || {}
  if (!imageBase64) return res.status(400).json({ error: 'Thiếu imageBase64' })

  const ocrKey = process.env.OCRSPACE_API_KEY
  if (!ocrKey) return res.status(500).json({ error: 'Server chưa cấu hình OCRSPACE_API_KEY' })

  try {
    const form = new URLSearchParams()
    form.append('apikey', ocrKey)
    form.append('base64Image', `data:image/jpeg;base64,${imageBase64}`)
    form.append('filetype', 'JPG')
    form.append('language', 'vie')
    form.append('isTable', 'true')
    form.append('OCREngine', '2')
    form.append('detectOrientation', 'true')

    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    const resp = await fetch(OCR_SPACE_URL, {
      signal: ctrl.signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    clearTimeout(timer)

    if (!resp.ok) return res.status(502).json({ error: `OCR.space lỗi HTTP ${resp.status}` })
    const data = await resp.json()

    if (data.IsErroredOnProcessing) {
      return res.status(502).json({ error: data.ErrorMessage?.join?.(', ') || 'OCR.space xử lý lỗi' })
    }

    const text = (data.ParsedResults || []).map(p => p.ParsedText || '').join('\n').trim()
    if (!text) return res.status(502).json({ error: 'OCR.space không đọc được nội dung' })

    return res.status(200).json({ ok: true, text })
  } catch (e) {
    console.error('[ocrspace-proxy] lỗi:', e.message)
    return res.status(502).json({ error: e.message })
  }
}
