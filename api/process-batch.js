// api/process-batch.js
// Trích xuất text từ PDF bằng pdf-parse (text-based PDF) + Groq format markdown.
// Không dùng Gemini Vision (AQ. keys không tương thích với generativelanguage.googleapis.com).
//
// Request body: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response:     { ok, text, docId, batchIndex, fromPage, toPage, charCount }

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const getGroqKeys = () =>
  [
    process.env.VITE_GROQ_API_KEY,
    process.env.VITE_GROQ_API_KEY_2,
    process.env.VITE_GROQ_API_KEY_3,
    process.env.GROQ_API_KEY,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3,
  ].filter(Boolean)

const getGhToken = () => process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

// ── Gọi Groq để format text thành markdown sạch ──────────────────────
const callGroq = async (text, fileName, fromPage, toPage, keys) => {
  const prompt = `Bạn nhận được text thô trích xuất từ trang ${fromPage}–${toPage} của văn bản "${fileName}".
Nhiệm vụ: format lại thành Markdown sạch, giữ nguyên 100% nội dung.
- Bắt đầu bằng: ## Trang ${fromPage}–${toPage}
- Giữ nguyên câu chữ, số liệu, tên người, ngày tháng
- Chuyển bảng biểu sang Markdown table nếu nhận ra cấu trúc bảng
- KHÔNG tóm tắt, KHÔNG thêm thông tin
- Chỉ trả về Markdown thuần

TEXT THÔ:
${text.slice(0, 12000)}`

  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 4096,
          temperature: 0,
        })
      })
      if (!res.ok) {
        const err = await res.text()
        console.error(`[process-batch] Groq ${key.slice(0,12)} HTTP ${res.status}: ${err.slice(0,200)}`)
        if (res.status === 429) await new Promise(r => setTimeout(r, 2000))
        continue
      }
      const data = await res.json()
      const result = data.choices?.[0]?.message?.content || ''
      if (result.length > 50) return result
    } catch(e) {
      console.error(`[process-batch] Groq exception:`, e.message)
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

  const groqKeys = getGroqKeys()
  if (!groqKeys.length) {
    return res.status(500).json({ error: 'Server chưa có GROQ_API_KEY.' })
  }

  // ── Bước 1: Tải PDF từ GitHub ──────────────────────────────────────
  const ghToken = getGhToken()
  let pdfBuffer

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
    pdfBuffer = Buffer.from(buf)
  } catch(e) {
    return res.status(502).json({ error: 'Lỗi khi tải PDF: ' + e.message })
  }

  // ── Bước 2: Extract text bằng pdf-parse ──────────────────────────
  let extractedText = ''
  try {
    const pdfParse = require('pdf-parse')
    const data = await pdfParse(pdfBuffer, {
      // Chỉ parse trang fromPage → toPage
      max: toPage,
    })
    // pdf-parse trả về toàn bộ text, ước tính phần thuộc trang fromPage-toPage
    const allText = data.text || ''
    const totalPages = data.numpages || 1
    const charsPerPage = allText.length / totalPages
    const startChar = Math.floor((fromPage - 1) * charsPerPage)
    const endChar   = Math.floor(toPage * charsPerPage)
    extractedText = allText.slice(startChar, endChar).trim()
  } catch(e) {
    console.error('[process-batch] pdf-parse lỗi:', e.message)
    return res.status(502).json({ error: 'Không đọc được text từ PDF (có thể là PDF scan/ảnh): ' + e.message })
  }

  if (extractedText.length < 50) {
    return res.status(502).json({
      error: `PDF trang ${fromPage}–${toPage} không có text (PDF scan/ảnh). Cần Gemini Vision để OCR.`,
      hint: 'Tài liệu này là PDF scan — text extraction không khả dụng.',
      batchIndex: batchIndex ?? 0, fromPage, toPage,
    })
  }

  // ── Bước 3: Groq format thành markdown ──────────────────────────
  const markdownText = await callGroq(extractedText, fileName || 'document', fromPage, toPage, groqKeys)

  if (!markdownText) {
    // Groq fail → trả về raw text (vẫn có ích)
    console.warn('[process-batch] Groq fail, trả raw text')
    const rawMd = `## Trang ${fromPage}–${toPage}\n\n${extractedText}`
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage,
      text: rawMd, charCount: rawMd.length,
      keyUsed: 'raw-text',
    })
  }

  return res.status(200).json({
    ok: true, docId,
    batchIndex: batchIndex ?? 0, fromPage, toPage,
    text: markdownText, charCount: markdownText.length,
    keyUsed: 'groq',
  })
}
