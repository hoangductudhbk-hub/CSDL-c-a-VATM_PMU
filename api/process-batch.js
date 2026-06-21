// api/process-batch.js
// OCR/extract PDF → Groq format markdown → lưu vào Firestore
// Hỗ trợ: PDF text-based (pdf-parse) + PDF scan (Gemini OCR)
//
// Request: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response: { ok, text, docId, batchIndex, fromPage, toPage, charCount }
//
// SỬA 22/6/2026 — 3 lỗi gốc tìm thấy khi soát lại dữ liệu thật trong Firestore:
// 1. gemini-2.0-flash / gemini-2.0-flash-lite đã bị Google khai tử 1/6/2026.
//    Mọi lệnh gọi Gemini OCR đều lỗi từ đó tới nay, không ai biết vì lỗi bị
//    nuốt âm thầm (continue) rồi rơi xuống nhánh "text thô" — nhìn ngoài cứ
//    tưởng là rate-limit. -> đổi sang gemini-2.5-flash / gemini-2.5-flash-lite.
// 2. callGeminiOCR cũ gửi NGUYÊN file PDF cho mỗi lô (8-10 trang), kèm câu
//    chữ "trích xuất trang X-Y" — chỉ là hướng dẫn bằng lời, không phải file
//    đã cắt đúng. Gemini có thể trả lời đúng là "không có nội dung ở phạm vi
//    này" nếu hiểu sai/lố phạm vi. -> dùng pdf-lib cắt đúng fromPage..toPage
//    thành 1 PDF con trước khi gửi, Gemini chỉ thấy đúng phần cần đọc.
// 3. Điều kiện nhận kết quả cũ chỉ là `text.length > 30` — câu Gemini từ
//    chối ("không có nội dung nào...") cũng dài hơn 30 ký tự nên được nhận
//    làm nội dung hợp lệ luôn. -> thêm cổng kiểm tra (isLikelyInvalid) trước
//    khi chấp nhận, không lưu lời từ chối làm markdown chính thức.

import { createRequire } from 'module'
import { PDFDocument } from 'pdf-lib'
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

// ── Cắt đúng trang fromPage..toPage thành 1 PDF con ───────────────
// Lý do tồn tại: gửi nguyên file PDF mỗi lô vừa lãng phí (1 file 125 trang
// chia 13 lô = tải lên Gemini 13 lần), vừa làm Gemini phải tự đoán phạm vi
// trang chỉ qua câu chữ trong prompt — dễ đoán nhầm/đoán lố. Cắt đúng trang
// trước thì Gemini chỉ thấy đúng phần cần đọc, không phải tự đoán.
const extractPageRange = async (pdfBuffer, fromPage, toPage) => {
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
  const totalPages = srcDoc.getPageCount()
  const start = Math.max(0, fromPage - 1)
  const end = Math.min(totalPages, toPage) // toPage là 1-indexed, inclusive
  if (start >= end) throw new Error(`Phạm vi trang không hợp lệ: ${fromPage}-${toPage} (file có ${totalPages} trang)`)

  const indices = []
  for (let i = start; i < end; i++) indices.push(i)

  const newDoc = await PDFDocument.create()
  const copiedPages = await newDoc.copyPages(srcDoc, indices)
  copiedPages.forEach(p => newDoc.addPage(p))
  const bytes = await newDoc.save()
  return { buffer: Buffer.from(bytes), totalPages }
}

// ── Gemini OCR (cho PDF scan) ─────────────────────────────────────
// Hỗ trợ cả 2 định dạng key:
// - Key cũ "AIzaSy..." → gửi qua query param ?key=
// - Key mới "AQ...." (Authorization key) → gửi qua header x-goog-api-key
const geminiUrl = (model, key) =>
  key.startsWith('AIzaSy')
    ? `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

const geminiHeaders = (key) => {
  const h = { 'Content-Type': 'application/json' }
  if (!key.startsWith('AIzaSy')) h['x-goog-api-key'] = key
  return h
}

// gemini-2.0-flash / gemini-2.0-flash-lite đã bị Google khai tử 1/6/2026.
// Dùng gemini-2.5-flash / gemini-2.5-flash-lite (free tier vẫn có).
const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']

// ── Cổng kiểm tra chất lượng — chặn rác trước khi cho phép lưu ────
// Không tin tuyệt đối vào bất cứ thứ Gemini trả về. Kiểm tra rẻ, không cần
// gọi AI thêm lần nào: regex câu từ chối/hội thoại + mật độ chữ quá thấp.
const REFUSAL_PATTERNS = /không có nội dung|không thấy nội dung|không tìm thấy nội dung|không có thông tin nào|vui lòng cung cấp|tôi không thể|xin lỗi[, ].{0,30}(không|chưa)|i (cannot|don't|do not|can't) (see|find|have)|please provide/i

const isLikelyInvalid = (text, pageCount) => {
  if (!text || text.trim().length < 20) return true
  if (REFUSAL_PATTERNS.test(text)) return true
  const avgCharsPerPage = text.length / Math.max(pageCount, 1)
  if (avgCharsPerPage < 50) return true // văn bản hành chính thật luôn nhiều hơn mức này
  return false
}

const callGeminiOCR = async (pageBuffer, fileName, fromPage, toPage) => {
  const keys = getGeminiKeys()
  const pageCount = toPage - fromPage + 1
  const base64Pdf = pageBuffer.toString('base64')

  for (const key of keys) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: geminiHeaders(key),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'application/pdf', data: base64Pdf } },
                { text: `Đây là ${pageCount} trang trích từ tài liệu "${fileName}" (tương ứng trang ${fromPage}-${toPage} của bản gốc).
Trích xuất TOÀN BỘ nội dung các trang này.
Giữ nguyên 100% câu chữ, số liệu, tên người, bảng biểu, điều khoản. Giữ cấu trúc tiêu đề/điều/khoản.
KHÔNG tóm tắt, KHÔNG bỏ thông tin. Chỉ trả về nội dung dạng Markdown thuần — không bình luận, không giải thích.` },
              ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 8192 },
          }),
        })
        if (res.status === 429) continue
        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          console.error(`[process-batch] Gemini ${model} HTTP ${res.status}: ${errText.slice(0, 300)}`)
          continue
        }
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (!isLikelyInvalid(text, pageCount)) return { text, model }
        console.error(`[process-batch] Gemini ${model} trả nội dung không hợp lệ (rỗng/từ chối/quá ngắn) cho trang ${fromPage}-${toPage}: "${text.slice(0, 150)}"`)
      } catch (e) {
        console.error(`[process-batch] lỗi gọi Gemini ${model}:`, e.message)
        continue
      }
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

  // ── PDF scan → cắt đúng trang rồi gửi Gemini OCR ─────────────
  const geminiKeys = getGeminiKeys()
  if (geminiKeys.length) {
    try {
      const { buffer: pageBuffer, totalPages: realTotalPages } = await extractPageRange(pdfBuffer, fromPage, toPage)
      if (realTotalPages) totalPages = realTotalPages

      const ocrResult = await callGeminiOCR(pageBuffer, fileName || 'document', fromPage, toPage)
      if (ocrResult) {
        return res.status(200).json({
          ok: true, docId,
          batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
          text: ocrResult.text, charCount: ocrResult.text.length,
          method: 'gemini-ocr', model: ocrResult.model,
        })
      }
    } catch (e) {
      // Lỗi cắt trang (file hỏng, mã hoá...) — báo rõ, không âm thầm gửi nguyên file
      console.error('[process-batch] Lỗi cắt trang PDF:', e.message)
      return res.status(422).json({
        error: 'Không cắt được trang PDF để OCR: ' + e.message,
        isScan: true, batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      })
    }
  }

  // ── Không OCR được hoặc Gemini chỉ trả nội dung không hợp lệ ─
  // Đánh dấu needsReview=true — KHÔNG để client/Firestore coi đây là dữ liệu
  // đã đọc xong đáng tin. Trước đây nhánh này lưu thẳng text thô (có thể là
  // chữ méo font cũ) làm nội dung chính thức, không ai biết tới khi tự kiểm.
  if (extractedText.length > 20) {
    const fallback = `## Trang ${fromPage}–${toPage}\n\n${extractedText}`
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      text: fallback, charCount: fallback.length,
      method: 'raw-text',
      needsReview: true,
      warning: 'PDF scan/font lỗi — Gemini OCR không trả được nội dung hợp lệ. Đây là text thô (có thể sai/méo), CẦN người kiểm tra lại, không nên coi là đã đọc xong.',
    })
  }

  return res.status(422).json({
    error: 'Không đọc được nội dung trang này — pdf-parse không có text, Gemini OCR không trả kết quả hợp lệ. Kiểm tra VITE_GEMINI_API_KEY trên Vercel và log Vercel Functions để xem lỗi cụ thể.',
    isScan: true, needsReview: true,
    batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
  })
}
