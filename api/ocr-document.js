// api/ocr-document.js
// Chuyển PDF → Markdown bằng 1 API call (không render từng trang)
//
// Thứ tự thử:
//   1. Mistral OCR (mistral-ocr-latest) — chất lượng cao nhất, cần key
//   2. OCR.space — miễn phí, không cần key (dùng public key "helloworld")
//
// Request: POST { fileUrl, fileName, docId }
// Response: { ok, markdown, pages, charCount, engine }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { fileUrl, fileName = '' } = req.body || {}
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })

  console.log('[ocr-document] Bắt đầu:', fileName, fileUrl.slice(-60))

  // ── 1. Thử Mistral OCR nếu có key ────────────────────────────────────────
  const mistralKey = process.env.VITE_MISTRAL_API_KEY
  if (mistralKey) {
    try {
      const resp = await fetch('https://api.mistral.ai/v1/ocr', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${mistralKey}`,
        },
        body: JSON.stringify({
          model: 'mistral-ocr-latest',
          document: { type: 'document_url', document_url: fileUrl },
          include_image_base64: false,
        }),
      })

      if (resp.ok) {
        const data = await resp.json()
        const pages = data.pages || []
        if (pages.length > 0) {
          const markdown = pages
            .map((p, i) => {
              const content = (p.markdown || '').trim()
              return content ? `## Trang ${i + 1}\n\n${content}` : ''
            })
            .filter(Boolean)
            .join('\n\n---\n\n')

          if (markdown.length > 200) {
            console.log('[ocr-document] Mistral OK:', pages.length, 'trang,', markdown.length, 'ký tự')
            return res.json({ ok: true, markdown, pages: pages.length, charCount: markdown.length, engine: 'mistral' })
          }
        }
      } else {
        console.warn('[ocr-document] Mistral lỗi:', resp.status)
      }
    } catch (e) {
      console.warn('[ocr-document] Mistral exception:', e.message)
    }
  }

  // ── 2. OCR.space — miễn phí, không cần đăng ký ───────────────────────────
  // Public key "helloworld": 500 req/ngày, hỗ trợ PDF URL trực tiếp
  // Engine 2: chính xác hơn cho tiếng Việt scan
  try {
    const ocrKey = process.env.OCRSPACE_API_KEY || 'helloworld'
    console.log('[ocr-document] Thử OCR.space...')

    const form = new URLSearchParams()
    form.append('apikey', ocrKey)
    form.append('url', fileUrl)
    form.append('language', 'vie')
    form.append('isTable', 'true')
    form.append('OCREngine', '2')
    form.append('detectOrientation', 'true')
    form.append('isSearchablePdfHideTextLayer', 'true') // bỏ qua text layer hỏng (watermark)

    const resp = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    if (resp.ok) {
      const data = await resp.json()

      if (data.IsErroredOnProcessing) {
        console.warn('[ocr-document] OCR.space lỗi:', data.ErrorMessage)
      } else {
        const pages = data.ParsedResults || []
        const parts = pages.map((p, i) => {
          const text = (p.ParsedText || '').trim()
          return text ? `## Trang ${i + 1}\n\n${text}` : ''
        }).filter(Boolean)

        if (parts.length > 0) {
          const markdown = parts.join('\n\n---\n\n')
          console.log('[ocr-document] OCR.space OK:', pages.length, 'trang,', markdown.length, 'ký tự')
          return res.json({ ok: true, markdown, pages: pages.length, charCount: markdown.length, engine: 'ocrspace' })
        }
      }
    } else {
      console.warn('[ocr-document] OCR.space HTTP:', resp.status)
    }
  } catch (e) {
    console.warn('[ocr-document] OCR.space exception:', e.message)
  }

  // ── 3. Cả 2 đều thất bại → báo client dùng Groq Vision page-by-page ──────
  console.error('[ocr-document] Tất cả engine thất bại, báo client fallback sang Groq Vision')
  return res.status(422).json({
    error: 'Cả Mistral và OCR.space đều không khả dụng. Pipeline sẽ dùng Groq Vision.',
    fallbackToGroq: true,
  })
}
