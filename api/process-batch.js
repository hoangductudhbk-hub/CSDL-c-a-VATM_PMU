// api/process-batch.js
// OCR/extract PDF → format markdown → lưu vào Firestore
// Hỗ trợ: PDF text-based (pdf-parse) + PDF scan (Gemini Vision OCR)
//
// Request: { docId, fileUrl, fileName, fromPage, toPage, batchIndex }
// Response: { ok, text, docId, batchIndex, fromPage, toPage, charCount }
//
// SỬA 22/6/2026: đổi model sang gemini-2.5-flash, thêm cắt trang đúng,
//   thêm kiểm tra isLikelyInvalid, phát hiện lỗi CMap/watermark.
// SỬA 1/7/2026: thêm lại Gemini Vision làm lớp OCR ưu tiên số 1 với 5 key
//   luân phiên (AIzaSy format hoạt động server-side). Key nào 429/lỗi tự
//   chuyển key tiếp → Groq Vision → OCR.space → Tesseract.

import { createRequire } from 'module'
import { PDFDocument } from 'pdf-lib'
const require = createRequire(import.meta.url)

let _mupdf = null
const getMupdf = async () => {
  if (_mupdf) return _mupdf
  try { _mupdf = await import('mupdf'); return _mupdf } catch { return null }
}
let _tesseract = null
const getTesseract = async () => {
  if (_tesseract) return _tesseract
  try { _tesseract = await import('tesseract.js'); return _tesseract } catch { return null }
}

// ── Lấy keys ─────────────────────────────────────────────────────
const getGeminiKeys = () => [
  process.env.VITE_GEMINI_API_KEY,
  process.env.VITE_GEMINI_API_KEY_2,
  process.env.VITE_GEMINI_API_KEY_3,
  process.env.VITE_GEMINI_API_KEY_4,
  process.env.VITE_GEMINI_API_KEY_5,
].filter(Boolean)

const getGroqKeys = () => [
  process.env.VITE_GROQ_API_KEY,
  process.env.VITE_GROQ_API_KEY_2,
  process.env.VITE_GROQ_API_KEY_3,
].filter(Boolean)

const getGhToken = () =>
  process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

// ── Helper URL/header cho Gemini (hỗ trợ cả AIzaSy và AQ. key) ───
const geminiUrl = (model, key) =>
  key.startsWith('AIzaSy')
    ? `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

const geminiHeaders = (key) => {
  const h = { 'Content-Type': 'application/json' }
  if (!key.startsWith('AIzaSy')) h['x-goog-api-key'] = key
  return h
}

// ── Render trang PDF thành ảnh PNG thuần (bỏ lớp text gốc) ───────
const renderPageToImage = async (pdfBuffer, pageIndex) => {
  const mu = await getMupdf()
  if (!mu) throw new Error('mupdf không khả dụng')
  const doc = mu.Document.openDocument(pdfBuffer, 'application/pdf')
  const page = doc.loadPage(pageIndex)
  const pixmap = page.toPixmap(mu.Matrix.scale(2, 2), mu.ColorSpace.DeviceRGB)
  return Buffer.from(pixmap.asPNG())
}

// ── Tesseract OCR — fallback cuối, chạy local không cần key ──────
const callTesseractOCR = async (imageBuffer) => {
  const tess = await getTesseract()
  if (!tess) return null
  const worker = await tess.createWorker('vie')
  try {
    const { data } = await worker.recognize(imageBuffer)
    return data.text
  } finally {
    await worker.terminate()
  }
}

// ── Kiểm tra chất lượng text ─────────────────────────────────────
const accentRatio = (text) => {
  const matches = text.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []
  return matches.length / Math.max(text.length, 1)
}

const hasLowContentDiversity = (text) => {
  if (text.length < 200) return false
  const zlib = require('zlib')
  const original = Buffer.byteLength(text, 'utf8')
  const compressed = zlib.deflateSync(text).length
  return (compressed / original) < 0.2
}

const REFUSAL_PATTERNS = /không có nội dung|không thấy nội dung|không tìm thấy nội dung|không có thông tin nào|vui lòng cung cấp|tôi không thể|xin lỗi[, ].{0,30}(không|chưa)|i (cannot|don't|do not|can't) (see|find|have)|please provide/i

const isLikelyInvalid = (text, pageCount) => {
  if (!text || text.trim().length < 20) return true
  if (REFUSAL_PATTERNS.test(text)) return true
  const avgCharsPerPage = text.length / Math.max(pageCount, 1)
  if (avgCharsPerPage < 50) return true
  return false
}

// ── Cắt đúng trang fromPage..toPage thành PDF con ─────────────────
const extractPageRange = async (pdfBuffer, fromPage, toPage) => {
  const srcDoc = await PDFDocument.load(pdfBuffer, { ignoreEncryption: true })
  const totalPages = srcDoc.getPageCount()
  const start = Math.max(0, fromPage - 1)
  const end = Math.min(totalPages, toPage)
  if (start >= end) throw new Error(`Phạm vi trang không hợp lệ: ${fromPage}-${toPage} (file có ${totalPages} trang)`)
  const indices = []
  for (let i = start; i < end; i++) indices.push(i)
  const newDoc = await PDFDocument.create()
  const copiedPages = await newDoc.copyPages(srcDoc, indices)
  copiedPages.forEach(p => newDoc.addPage(p))
  const bytes = await newDoc.save()
  return { buffer: Buffer.from(bytes), totalPages }
}

// ── Groq: format text thô thành markdown ─────────────────────────
const callGroq = async (text, fileName, fromPage, toPage) => {
  const keys = getGroqKeys()
  if (!keys.length) return null

  const prompt = `Bạn là chuyên gia xử lý văn bản hành chính Việt Nam.
Dưới đây là nội dung text thô trích từ trang ${fromPage}–${toPage} của tài liệu "${fileName}".
Hãy làm sạch và định dạng lại thành Markdown rõ ràng:
- Giữ nguyên 100% nội dung, số liệu, tên, ngày tháng — không suy diễn, không thêm thông tin không có trong text thô
- Thêm tiêu đề ## Trang ${fromPage}–${toPage} ở đầu
- Bảng biểu → Markdown table
- Xóa ký tự rác, khoảng trắng thừa
- Nếu có dòng/cụm lặp lại nhiều lần không mang thông tin — chỉ giữ lại 1 lần đầu
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

// ── OCR prompt dùng chung cho cả Gemini và Groq Vision ───────────
const OCR_PROMPT = (fileName, pageLabel) =>
  `Đây là ảnh ${pageLabel} của tài liệu "${fileName}".
Trích xuất TOÀN BỘ nội dung văn bản nhìn thấy trong ảnh.
- Giữ nguyên 100% câu chữ, số liệu, tên, ngày tháng
- Bảng biểu → Markdown table
- Tiêu đề → ## ###
- Chữ ký/dấu mộc: ghi *(Đã ký)* / *(Có dấu)*
- Header/footer lặp lại: bỏ qua
- Chỉ trả về Markdown thuần, không giải thích`

// ── Gemini Vision OCR — ưu tiên số 1, 5 key luân phiên ───────────
// Key nào 429/lỗi → tự chuyển key tiếp theo → hết tất cả → trả null
const GEMINI_VISION_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite']

const callGeminiVisionOCR = async (imageBuffer, fileName, pageLabel) => {
  const keys = getGeminiKeys()
  if (!keys.length) return null
  const base64Img = imageBuffer.toString('base64')

  for (const model of GEMINI_VISION_MODELS) {
    for (const key of keys) {
      try {
        const r = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: geminiHeaders(key),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'image/png', data: base64Img } },
                { text: OCR_PROMPT(fileName, pageLabel) },
              ]
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 4096 },
          }),
        })
        if (r.status === 429) {
          console.warn(`[process-batch] Gemini Vision ${model} key hết quota, thử key khác`)
          continue
        }
        if (!r.ok) {
          console.error(`[process-batch] Gemini Vision ${model} HTTP ${r.status}`)
          continue
        }
        const data = await r.json()
        const candidate = data.candidates?.[0]
        const text = candidate?.content?.parts?.[0]?.text || ''
        const finishReason = candidate?.finishReason
        if (text && finishReason && finishReason !== 'STOP') {
          console.warn(`[process-batch] Gemini Vision ${model} finishReason=${finishReason} — thử key khác`)
          continue
        }
        if (!isLikelyInvalid(text, 1)) return { text, model: `gemini-vision:${model}` }
      } catch (e) {
        console.error(`[process-batch] Gemini Vision lỗi:`, e.message)
        continue
      }
    }
  }
  return null
}

// ── Groq Vision OCR — ưu tiên số 2 ──────────────────────────────
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

const callGroqVisionOCR = async (imageBuffer, fileName, pageLabel) => {
  const keys = getGroqKeys()
  const base64Img = imageBuffer.toString('base64')
  for (const key of keys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: GROQ_VISION_MODEL,
          max_tokens: 4096,
          temperature: 0,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/png;base64,${base64Img}` } },
              { type: 'text', text: OCR_PROMPT(fileName, pageLabel) },
            ],
          }],
        }),
      })
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2000)); continue }
      if (!res.ok) continue
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content || ''
      if (!isLikelyInvalid(text, 1)) return { text, model: GROQ_VISION_MODEL }
    } catch (e) {
      console.error('[process-batch] Groq Vision lỗi:', e.message)
      continue
    }
  }
  return null
}

// ── OCR.space — fallback số 3 ─────────────────────────────────────
const callOcrSpace = async (imageBuffer, pageLabel) => {
  const apiKey = process.env.OCRSPACE_API_KEY
  if (!apiKey) return null
  if (imageBuffer.length > 900 * 1024) return null
  try {
    const base64 = imageBuffer.toString('base64')
    const body = new URLSearchParams({
      apikey: apiKey,
      base64Image: `data:image/png;base64,${base64}`,
      filetype: 'PNG',
      language: 'vie',
      OCREngine: '2',
      isCreateSearchablePdf: 'false',
    })
    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return null
    const data = await res.json()
    if (data.IsErroredOnProcessing) return null
    const text = (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n').trim()
    if (isLikelyInvalid(text, 1)) return null
    return { text, model: 'ocr.space' }
  } catch { return null }
}

// ── OCR 1 trang: Gemini Vision → Groq Vision → OCR.space → Tesseract
const ocrOnePage = async (imageBuffer, fileName, pageLabel) => {
  const gemini = await callGeminiVisionOCR(imageBuffer, fileName, pageLabel)
  if (gemini) return gemini

  const groq = await callGroqVisionOCR(imageBuffer, fileName, pageLabel)
  if (groq) return groq

  const ocrspace = await callOcrSpace(imageBuffer, pageLabel)
  if (ocrspace) return ocrspace

  const tesseract = await callTesseractOCR(imageBuffer)
  if (tesseract && tesseract.trim().length > 20) return { text: tesseract, model: 'tesseract' }

  return null
}

// ── Handler chính ─────────────────────────────────────────────────
export const config = { maxDuration: 60 }

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

  // ── Tải PDF từ GitHub ─────────────────────────────────────────
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

  // ── Thử pdf-parse trước (text-based PDF) ──────────────────────
  let extractedText = ''
  let isScan = false
  let corruptedText = false
  let totalPages = null
  try {
    const pdfParse = require('pdf-parse')
    const data = await pdfParse(pdfBuffer, { max: toPage })
    const rawText = data.text || ''
    totalPages = data.numpages || 1

    const pagesActuallyExtracted = Math.min(toPage, totalPages)
    const charsPerPage = rawText.length / pagesActuallyExtracted
    const startChar = Math.floor((fromPage - 1) * charsPerPage)
    const endChar = Math.floor(toPage * charsPerPage)
    extractedText = rawText.slice(startChar, endChar).trim()

    const hasVietnamese = /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i.test(extractedText)
    const avgCharsPerPage = extractedText.length / Math.max(toPage - fromPage + 1, 1)
    const lowDiversity = hasLowContentDiversity(extractedText)
    const lowAccentRatio = accentRatio(extractedText) < 0.08
    const noUsableText = !hasVietnamese || avgCharsPerPage < 80
    corruptedText = !noUsableText && (lowDiversity || lowAccentRatio)
    isScan = noUsableText || corruptedText
  } catch (e) {
    console.error('[process-batch] pdf-parse error:', e.message)
    isScan = true
  }

  // ── Nếu có text tốt → Groq format ────────────────────────────
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

  // ── Lớp text bị hỏng (watermark lặp / lỗi CMap) → render ảnh ─
  if (corruptedText) {
    try {
      const texts = []
      for (let p = fromPage; p <= toPage; p++) {
        const img = await renderPageToImage(pdfBuffer, p - 1)
        const r = await ocrOnePage(img, fileName || 'document', `trang ${p}`)
        texts.push(`## Trang ${p}\n\n${r ? r.text : '[không đọc được]'}`)
      }
      return res.status(200).json({
        ok: true, docId,
        batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
        text: texts.join('\n\n'), charCount: texts.join('\n\n').length,
        method: 'render-image-ocr',
      })
    } catch (e) {
      console.error('[process-batch] Lỗi render ảnh + OCR:', e.message)
    }
  }

  // ── PDF scan thật → render từng trang → OCR ───────────────────
  try {
    const { totalPages: realTotalPages } = await extractPageRange(pdfBuffer, fromPage, toPage)
    if (realTotalPages) totalPages = realTotalPages

    const texts = []
    for (let p = fromPage; p <= toPage; p++) {
      const img = await renderPageToImage(pdfBuffer, p - 1)
      const r = await ocrOnePage(img, fileName || 'document', `trang ${p}`)
      texts.push(`## Trang ${p}\n\n${r ? r.text : '[không đọc được]'}`)
    }
    const finalText = texts.join('\n\n')
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      text: finalText, charCount: finalText.length,
      method: 'gemini-vision-ocr',
    })
  } catch (e) {
    console.error('[process-batch] Lỗi scan PDF OCR:', e.message)
    return res.status(422).json({
      error: 'Không OCR được trang này: ' + e.message,
      isScan: true, batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
    })
  }
}
