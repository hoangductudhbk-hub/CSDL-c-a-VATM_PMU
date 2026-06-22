// api/ocr-document.js
// Dùng Mistral OCR (mistral-ocr-latest) để chuyển PDF → Markdown trong 1 API call
// Ưu điểm: gửi URL GitHub → nhận markdown đầy đủ, không render trang, không mupdf
//
// Request: POST { fileUrl, fileName, docId }
// Response: { ok, markdown, pages, charCount }

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { fileUrl, fileName = '', docId = '' } = req.body || {}
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })

  const mistralKey = process.env.VITE_MISTRAL_API_KEY
  if (!mistralKey) return res.status(500).json({ error: 'VITE_MISTRAL_API_KEY chưa cấu hình' })

  console.log('[ocr-document] Bắt đầu OCR:', fileName, fileUrl.slice(-50))

  try {
    // Mistral OCR nhận URL public trực tiếp (GitHub raw URL là public HTTPS)
    const resp = await fetch('https://api.mistral.ai/v1/ocr', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${mistralKey}`,
      },
      body: JSON.stringify({
        model: 'mistral-ocr-latest',
        document: {
          type: 'document_url',
          document_url: fileUrl,
        },
        include_image_base64: false,
      }),
    })

    if (!resp.ok) {
      const errText = await resp.text()
      console.error('[ocr-document] Mistral error', resp.status, errText)
      return res.status(resp.status).json({
        error: `Mistral OCR lỗi ${resp.status}: ${errText.slice(0, 200)}`,
      })
    }

    const data = await resp.json()

    // Ghép markdown từ tất cả các trang
    const pages = data.pages || []
    if (!pages.length) {
      return res.status(422).json({ error: 'Mistral OCR trả về 0 trang' })
    }

    const markdown = pages
      .map((p, i) => {
        const content = (p.markdown || '').trim()
        return content ? `## Trang ${i + 1}\n\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n---\n\n')

    console.log('[ocr-document] Xong:', pages.length, 'trang,', markdown.length, 'ký tự')

    return res.json({
      ok: true,
      markdown,
      pages: pages.length,
      charCount: markdown.length,
    })

  } catch (e) {
    console.error('[ocr-document] Lỗi:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
