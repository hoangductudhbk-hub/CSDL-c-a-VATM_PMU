// api/process-batch.js
// Xử lý 1 lô trang PDF qua Gemini OCR. Client gọi lặp lại cho từng lô.
// Ưu điểm so với client-side: API key ẩn, resumable khi mạng yếu/gián đoạn.
//
// Request body: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response:     { ok, text, docId, batchIndex, fromPage, toPage, charCount }
//               { error, fallback:true } → client tự xử lý (file quá lớn)

// ── Fetch với retry khi 429 ─────────────────────────────────────────
const fetchWithRetry = async (url, opts, retries = 3, baseDelay = 2000) => {
  for (let i = 0; i < retries; i++) {
    const res = await fetch(url, opts)
    if (res.status !== 429) return res
    if (i < retries - 1) await new Promise(r => setTimeout(r, baseDelay * (i + 1)))
  }
  // Trả về response cuối (429) để caller xử lý
  return fetch(url, opts)
}

// ── Lấy Gemini keys từ env (không dùng VITE_ ở server) ─────────────
// Hỗ trợ cả 2 naming: VITE_GEMINI_API_KEY (Vercel đặt chung) và GEMINI_API_KEY (thuần server)
const getGeminiKeys = () =>
  [
    process.env.VITE_GEMINI_API_KEY,
    process.env.VITE_GEMINI_API_KEY_2,
    process.env.VITE_GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
  ].filter(Boolean)

const getGhToken = () => process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

// ── Gọi Gemini với PDF inline ────────────────────────────────────────
const callGemini = async (base64Pdf, prompt, keys) => {
  const GEMINI_URL = (key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`

  for (const key of keys) {
    try {
      const res = await fetchWithRetry(
        GEMINI_URL(key),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
                { text: prompt }
              ]
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 8192 }
          })
        },
        2 // chỉ retry 2 lần per key rồi thử key tiếp
      )

      if (!res.ok) {
        const body = await res.text()
        console.error(`[process-batch] Gemini key ${key.slice(0, 12)}... HTTP ${res.status}: ${body.slice(0, 300)}`)
        continue
      }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (text.length > 30) return { text, keyUsed: key.slice(0, 12) + '...' }

    } catch (e) {
      console.error(`[process-batch] Gemini exception:`, e.message)
      continue
    }
  }
  return null
}

// ── Handler chính ────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { docId, fileUrl, fileName, fromPage, toPage, batchIndex } = req.body || {}

  // Validate
  if (!docId) return res.status(400).json({ error: 'Thiếu docId' })
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })
  if (fromPage == null || toPage == null) return res.status(400).json({ error: 'Thiếu fromPage/toPage' })

  const gemKeys = getGeminiKeys()
  if (!gemKeys.length) {
    return res.status(500).json({
      error: 'Server chưa có GEMINI_API_KEY. Set trên Vercel → Environment Variables.',
    })
  }

  // ── Bước 1: Tải PDF từ GitHub ──────────────────────────────────
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
      return res.status(502).json({
        error: `Không tải được PDF từ GitHub: HTTP ${pdfRes.status}`,
        hint: ghToken ? 'Token có thể hết hạn' : 'Thiếu GH_TOKEN trên server',
      })
    }

    const buf = await pdfRes.arrayBuffer()

    // Giới hạn Gemini inline: 20MB. Để an toàn dùng 15MB
    const MAX_MB = 15
    if (buf.byteLength > MAX_MB * 1024 * 1024) {
      return res.status(413).json({
        error: `File quá lớn (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_MB}MB). Dùng client-side fallback.`,
        fallback: true,
        fileSizeMB: (buf.byteLength / 1024 / 1024).toFixed(1),
      })
    }

    pdfBase64 = Buffer.from(buf).toString('base64')
  } catch (e) {
    return res.status(502).json({ error: 'Lỗi khi tải PDF: ' + e.message })
  }

  // ── Bước 2: Gọi Gemini OCR ───────────────────────────────────────
  const prompt = `Trích xuất toàn bộ nội dung từ trang ${fromPage} đến trang ${toPage} của tài liệu: "${fileName || 'document'}".

Yêu cầu bắt buộc:
- Giữ nguyên 100% câu chữ, số liệu, tên người, ngày tháng, ký hiệu văn bản
- Chuyển bảng biểu sang Markdown table (| cột | cột |)
- Giữ nguyên heading (# ## ###), điều khoản (Điều 1, Khoản 2...)
- Bắt đầu output bằng dòng: ## Trang ${fromPage}–${toPage}
- CHỈ trả về Markdown thuần túy, KHÔNG tóm tắt, KHÔNG giải thích thêm`

  const result = await callGemini(pdfBase64, prompt, gemKeys)

  if (!result) {
    return res.status(502).json({
      error: 'Tất cả Gemini keys đều thất bại (rate limit hoặc key sai format)',
      hint: 'Key phải bắt đầu bằng AIzaSy... từ aistudio.google.com',
      batchIndex: batchIndex ?? 0,
      fromPage,
      toPage,
    })
  }

  // ── Thành công ───────────────────────────────────────────────────
  return res.status(200).json({
    ok: true,
    docId,
    batchIndex: batchIndex ?? 0,
    fromPage,
    toPage,
    text: result.text,
    charCount: result.text.length,
    keyUsed: result.keyUsed, // debug: biết key nào đang chạy
  })
}
