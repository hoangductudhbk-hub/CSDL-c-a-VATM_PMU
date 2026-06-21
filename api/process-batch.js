// api/process-batch.js
// OCR/extract PDF → Groq format markdown → lưu vào Firestore
// Hỗ trợ: PDF text-based (pdf-parse) + PDF scan (Gemini OCR)
//
// Request: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response: { ok, text, docId, batchIndex, fromPage, toPage, charCount }

import { createRequire } from 'module'
const require = createRequire(import.meta.url)

const getGroqKeys = () => [
  process.env.VITE_GROQ_API_KEY,
  process.env.VITE_GROQ_API_KEY_2,
  process.env.VITE_GROQ_API_KEY_3,
].filter(Boolean)

const getGeminiKeys = () => [
  process.env.VITE_GEMINI_API_KEY,
  process.env.VITE_GEMINI_API_KEY_2,
  process.env.VITE_GEMINI_API_KEY_3,
].filter(Boolean)

const getGhToken = () =>
  process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

// ── Groq: format text thô thành markdown ─────────────────────────
const callGroq = async (text, fileName, fromPage, toPage) => {
  const keys = getGroqKeys()
  if (!keys.length) return null

  const prompt = `Bạn là chuyên gia xử lý văn bản hành chính Việt Nam.
Dưới đây là nội dung text thô trích từ trang ${fromPage}–${toPage} của tài liệu "${fileName}".
Hãy làm sạch và định dạng lại thành Markdown rõ ràng:
- Giữ nguyên 100% nội dung, số liệu, tên, ngày tháng
- Thêm tiêu đề ## Trang ${fromPage}–${toPage} ở đầu
- Bảng biểu → Markdown table
- Xóa ký tự rác, khoảng trắng thừa
- Chỉ trả về Markdown, không giải thích thêm

TEXT THÔ:
---
${text.slice(0, 6000)}
---`

  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 2000,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
      if (!res.ok) { if (res.status === 429) continue; break }
      const data = await res.json()
      const result = data.choices?.[0]?.message?.content || ''
      if (result.length > 30) return result
    } catch { continue }
  }
  return null
}

// ── Gemini OCR (cho PDF scan) ─────────────────────────────────────
// Hỗ trợ cả 2 định dạng key, đồng bộ với src/hooks/useAI.js:
// - Key cũ "AIzaSy..." → gửi qua query param ?key=
// - Key mới "AQ...." (Authorization key, Google đang chuyển sang từ 6/2026)
//   → gửi qua header x-goog-api-key
const geminiUrl = (model, key) =>
  key.startsWith('AIzaSy')
    ? `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

const geminiHeaders = (key) => {
  const h = { 'Content-Type': 'application/json' }
  if (!key.startsWith('AIzaSy')) h['x-goog-api-key'] = key
  return h
}

const callGeminiOCR = async (base64Pdf, fileName, fromPage, toPage) => {
  const keys = getGeminiKeys()
  const models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
  for (const key of keys) {
    for (const model of models) {
      try {
        const res = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: geminiHeaders(key),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
                { text: `Trích xuất TOÀN BỘ nội dung trang ${fromPage}-${toPage} của file PDF này (file "${fileName}").
Giữ nguyên 100% câu chữ, số liệu, tên người, bảng biểu, điều khoản. Giữ cấu trúc tiêu đề/điều/khoản.
KHÔNG tóm tắt, KHÔNG bỏ thông tin. Chỉ trả về nội dung dạng Markdown thuần.` },
              ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 8192 },
          }),
        })
        if (res.status === 429) continue
        if (!res.ok) continue
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (text.length > 30) return text
      } catch { continue }
    }
  }
  return null
}

// ── Handler chính ────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { docId, fileUrl, fileName, fromPage, toPage, batchIndex } = req.body || {}
  if (!docId || !fileUrl || fromPage == null || toPage == null)
    return res.status(400).json({ error: 'Thiếu tham số: docId, fileUrl, fromPage, toPage' })

  const ghToken = getGhToken()

  // ── Tải PDF từ GitHub ────────────────────────────────────────
  let pdfBuffer
  try {
    const pdfRes = await fetch(fileUrl, {
      headers: {
        'User-Agent': 'VATM-PMU/1.0',
        ...(ghToken ? { Authorization: `token ${ghToken}` } : {}),
      }
    })
    if (!pdfRes.ok)
      return res.status(502).json({ error: `Không tải được PDF: HTTP ${pdfRes.status}` })

    const arrBuf = await pdfRes.arrayBuffer()
    if (arrBuf.byteLength > 25 * 1024 * 1024)
      return res.status(413).json({ error: 'File quá lớn (>25MB)' })

    pdfBuffer = Buffer.from(arrBuf)
  } catch (e) {
    return res.status(502).json({ error: 'Lỗi tải PDF: ' + e.message })
  }

  // ── Thử pdf-parse trước (text-based PDF) ────────────────────
  let extractedText = ''
  let isScan = false
  let totalPages = null
  try {
    const pdfParse = require('pdf-parse')
    const data = await pdfParse(pdfBuffer, { max: toPage })
    const rawText = data.text || ''
    totalPages = data.numpages || 1

    // Ước tính phần text từ trang fromPage đến toPage
    const charsPerPage = rawText.length / totalPages
    const startChar = Math.floor((fromPage - 1) * charsPerPage)
    const endChar = Math.floor(toPage * charsPerPage)
    extractedText = rawText.slice(startChar, endChar).trim()

    // PDF scan thì text rất ít hoặc toàn ký tự rác
    const hasVietnamese = /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i.test(extractedText)
    const avgCharsPerPage = extractedText.length / Math.max(toPage - fromPage + 1, 1)
    isScan = !hasVietnamese || avgCharsPerPage < 80

  } catch (e) {
    console.error('[process-batch] pdf-parse error:', e.message)
    isScan = true // Nếu pdf-parse lỗi, coi như scan
  }

  // ── Nếu có text tốt → Groq format ───────────────────────────
  if (!isScan && extractedText.length > 100) {
    const formatted = await callGroq(extractedText, fileName || 'document', fromPage, toPage)
    const finalText = formatted || `## Trang ${fromPage}–${toPage}\n\n${extractedText}`
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      text: finalText, charCount: finalText.length,
      method: 'pdf-parse+groq',
    })
  }

  // ── PDF scan → Gemini OCR (đã có key sẵn, không cần đăng ký mới) ─
  const geminiKeys = getGeminiKeys()
  if (geminiKeys.length) {
    const base64Pdf = pdfBuffer.toString('base64')
    const ocrText = await callGeminiOCR(base64Pdf, fileName || 'document', fromPage, toPage)
    if (ocrText) {
      return res.status(200).json({
        ok: true, docId,
        batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
        text: ocrText, charCount: ocrText.length,
        method: 'gemini-ocr',
      })
    }
  }

  // ── Không OCR được → trả text thô (dù ít) ──────────────────
  if (extractedText.length > 20) {
    const fallback = `## Trang ${fromPage}–${toPage}\n\n${extractedText}`
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      text: fallback, charCount: fallback.length,
      method: 'raw-text',
      warning: 'PDF scan — Gemini OCR không trả kết quả (kiểm tra key/quota). Dùng tạm text thô.',
    })
  }

  return res.status(422).json({
    error: 'PDF scan không OCR được — Gemini không trả kết quả. Kiểm tra VITE_GEMINI_API_KEY trên Vercel (đúng định dạng AIzaSy...) và quota.',
    isScan: true, batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
  })
}
