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

  // ── 2. OCR.space — tải file server-side, gửi base64 ─────────────────────────
  // GitHub raw URL bị chặn từ OCR.space CDN → tải file về server (có auth token),
  // gửi base64 thay URL. Free key "helloworld" giới hạn 1MB; paid key ~5MB.
  try {
    const ocrKey = process.env.OCRSPACE_API_KEY || 'helloworld'
    console.log('[ocr-document] Thử OCR.space (download + base64)...')

    // Tải PDF từ GitHub với auth token
    const ghToken = process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''
    const fileResp = await fetch(fileUrl, {
      headers: {
        'User-Agent': 'VATM-PMU/1.0',
        ...(ghToken ? { Authorization: `token ${ghToken}` } : {}),
      },
    })
    if (!fileResp.ok) throw new Error(`Không tải được file: ${fileResp.status}`)
    const fileBuf = Buffer.from(await fileResp.arrayBuffer())
    console.log('[ocr-document] File size:', (fileBuf.length / 1024 / 1024).toFixed(1), 'MB')

    // helloworld: 1MB; paid key: 5MB
    const maxBytes = ocrKey === 'helloworld' ? 1 * 1024 * 1024 : 4.5 * 1024 * 1024
    if (fileBuf.length > maxBytes) {
      console.warn('[ocr-document] File quá lớn cho OCR.space key này → bỏ qua')
      throw new Error('file_too_large')
    }

    const base64File = fileBuf.toString('base64')
    const form = new URLSearchParams()
    form.append('apikey', ocrKey)
    form.append('base64Image', `data:application/pdf;base64,${base64File}`)
    form.append('filetype', 'PDF')
    form.append('language', 'vie')
    form.append('isTable', 'true')
    form.append('OCREngine', '2')
    form.append('detectOrientation', 'true')
    form.append('isSearchablePdfHideTextLayer', 'true')

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
