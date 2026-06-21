// api/process-batch.js
// Xử lý 1 lô trang PDF qua Gemini OCR (dùng @google/generative-ai SDK).
// SDK xử lý đúng auth cho cả key format cũ (AIzaSy) và mới (AQ.).
//
// Request body: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response:     { ok, text, docId, batchIndex, fromPage, toPage, charCount }

import { GoogleGenerativeAI } from '@google/generative-ai'

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

// ── Gọi Gemini qua SDK (hỗ trợ AQ. và AIzaSy format) ────────────────
const callGeminiSDK = async (base64Pdf, prompt, keys) => {
  for (const key of keys) {
    try {
      const genAI = new GoogleGenerativeAI(key)
      const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { temperature: 0, maxOutputTokens: 8192 },
      })

      const result = await model.generateContent([
        { inlineData: { mimeType: 'application/pdf', data: base64Pdf } },
        prompt,
      ])

      const text = result.response.text() || ''
      if (text.length > 30) {
        return { text, keyUsed: key.slice(0, 12) + '...' }
      }
      console.warn(`[process-batch] Key ${key.slice(0,12)} trả về text quá ngắn: ${text.length} chars`)

    } catch (e) {
      console.error(`[process-batch] SDK lỗi key ${key.slice(0,12)}...:`, e.message)
      // 429 → chờ rồi thử key tiếp
      if (e.message?.includes('429') || e.message?.includes('RESOURCE_EXHAUSTED')) {
        await new Promise(r => setTimeout(r, 3000))
      }
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

  if (!docId)   return res.status(400).json({ error: 'Thiếu docId' })
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })
  if (fromPage == null || toPage == null) return res.status(400).json({ error: 'Thiếu fromPage/toPage' })

  const gemKeys = getGeminiKeys()
  if (!gemKeys.length) {
    return res.status(500).json({ error: 'Server chưa có GEMINI_API_KEY. Set trên Vercel → Environment Variables.' })
  }

  // ── Bước 1: Tải PDF từ GitHub ──────────────────────────────────────
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

    const MAX_MB = 15
    if (buf.byteLength > MAX_MB * 1024 * 1024) {
      return res.status(413).json({
        error: `File quá lớn (${(buf.byteLength / 1024 / 1024).toFixed(1)}MB > ${MAX_MB}MB).`,
        fallback: true,
        fileSizeMB: (buf.byteLength / 1024 / 1024).toFixed(1),
      })
    }

    pdfBase64 = Buffer.from(buf).toString('base64')
  } catch (e) {
    return res.status(502).json({ error: 'Lỗi khi tải PDF: ' + e.message })
  }

  // ── Bước 2: Gọi Gemini OCR qua SDK ──────────────────────────────────
  const prompt = `Trích xuất toàn bộ nội dung từ trang ${fromPage} đến trang ${toPage} của tài liệu: "${fileName || 'document'}".

Yêu cầu bắt buộc:
- Giữ nguyên 100% câu chữ, số liệu, tên người, ngày tháng, ký hiệu văn bản
- Chuyển bảng biểu sang Markdown table (| cột | cột |)
- Giữ nguyên heading (# ## ###), điều khoản (Điều 1, Khoản 2...)
- Bắt đầu output bằng dòng: ## Trang ${fromPage}–${toPage}
- CHỈ trả về Markdown thuần túy, KHÔNG tóm tắt, KHÔNG giải thích thêm`

  const result = await callGeminiSDK(pdfBase64, prompt, gemKeys)

  if (!result) {
    return res.status(502).json({
      error: 'Tất cả Gemini keys đều thất bại (rate limit hoặc key không hợp lệ)',
      hint: 'Kiểm tra /api/test-keys để debug',
      batchIndex: batchIndex ?? 0,
      fromPage,
      toPage,
    })
  }

  return res.status(200).json({
    ok: true,
    docId,
    batchIndex: batchIndex ?? 0,
    fromPage,
    toPage,
    text: result.text,
    charCount: result.text.length,
    keyUsed: result.keyUsed,
  })
}
