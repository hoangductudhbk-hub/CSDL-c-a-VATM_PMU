// api/process-batch.js
// OCR tài liệu PDF (cả scan và text) bằng Mistral OCR API.
// Mistral nhận PDF base64, trả về text markdown chất lượng cao.
//
// Request body: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response:     { ok, text, docId, batchIndex, fromPage, toPage, charCount }

const getMistralKey = () => process.env.VITE_MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || ''
const getGhToken   = () => process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

// ── Gọi Mistral OCR ───────────────────────────────────────────────────
// Mistral OCR API nhận PDF dưới dạng base64 data URL
const callMistralOCR = async (base64Pdf, fileName, fromPage, toPage, apiKey) => {
  try {
    // Dùng Mistral vision model với PDF inline
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'mistral-ocr-latest',
        messages: [{
          role: 'user',
          content: [
            {
              type: 'document_url',
              document_url: `data:application/pdf;base64,${base64Pdf}`,
            },
            {
              type: 'text',
              text: `Trích xuất toàn bộ nội dung từ trang ${fromPage} đến trang ${toPage} của tài liệu "${fileName}".
Yêu cầu:
- Giữ nguyên 100% câu chữ, số liệu, tên người, ngày tháng, ký hiệu
- Chuyển bảng biểu sang Markdown table
- Giữ nguyên cấu trúc: tiêu đề, điều, khoản, mục
- Bắt đầu bằng: ## Trang ${fromPage}–${toPage}
- Chỉ trả về Markdown, không tóm tắt, không giải thích thêm`,
            }
          ]
        }],
      })
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[process-batch] Mistral OCR HTTP ${res.status}: ${err.slice(0, 400)}`)
      return null
    }

    const data = await res.json()
    const text = data.choices?.[0]?.message?.content || ''
    return text.length > 30 ? text : null

  } catch(e) {
    console.error('[process-batch] Mistral OCR exception:', e.message)
    return null
  }
}

// ── Handler chính ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { docId, fileUrl, fileName, fromPage, toPage, batchIndex } = req.body || {}

  if (!docId)   return res.status(400).json({ error: 'Thiếu docId' })
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })
  if (fromPage == null || toPage == null) return res.status(400).json({ error: 'Thiếu fromPage/toPage' })

  const mistralKey = getMistralKey()
  if (!mistralKey) {
    return res.status(500).json({
      error: 'Chưa có VITE_MISTRAL_API_KEY. Vào Vercel → Environment Variables để thêm.',
      hint: 'Lấy key miễn phí tại https://console.mistral.ai/api-keys'
    })
  }

  // ── Tải PDF từ GitHub ─────────────────────────────────────────────
  const ghToken = getGhToken()
  let pdfBase64

  try {
    const pdfRes = await fetch(fileUrl, {
      headers: {
        'User-Agent': 'VATM-PMU/1.0',
        ...(ghToken ? { Authorization: `token ${ghToken}` } : {}),
      }
    })
    if (!pdfRes.ok) {
      return res.status(502).json({ error: `Không tải được PDF từ GitHub: HTTP ${pdfRes.status}` })
    }
    const buf = await pdfRes.arrayBuffer()
    const MAX_MB = 20
    if (buf.byteLength > MAX_MB * 1024 * 1024) {
      return res.status(413).json({
        error: `File quá lớn (${(buf.byteLength/1024/1024).toFixed(1)}MB > ${MAX_MB}MB).`,
        fallback: true,
      })
    }
    pdfBase64 = Buffer.from(buf).toString('base64')
  } catch(e) {
    return res.status(502).json({ error: 'Lỗi khi tải PDF: ' + e.message })
  }

  // ── Gọi Mistral OCR ───────────────────────────────────────────────
  const text = await callMistralOCR(pdfBase64, fileName || 'document', fromPage, toPage, mistralKey)

  if (!text) {
    return res.status(502).json({
      error: 'Mistral OCR thất bại',
      hint: 'Kiểm tra VITE_MISTRAL_API_KEY tại /api/test-keys',
      batchIndex: batchIndex ?? 0, fromPage, toPage,
    })
  }

  return res.status(200).json({
    ok: true, docId,
    batchIndex: batchIndex ?? 0, fromPage, toPage,
    text, charCount: text.length,
    keyUsed: 'mistral-ocr',
  })
}
