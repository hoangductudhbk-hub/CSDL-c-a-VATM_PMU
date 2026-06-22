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

// mupdf và tesseract dùng WASM — load động để tránh crash toàn function nếu WASM lỗi
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

// ── Render trang PDF thành ảnh, BỎ HOÀN TOÀN lớp text gốc ─────────
// Lý do tồn tại: lỗi CMap/watermark nằm ở LỚP TEXT — nếu vẫn gửi PDF gốc
// (kèm lớp text hỏng) cho Gemini qua inline_data, Gemini có thể tự lấy lớp
// text nhúng sẵn cho rẻ và kế thừa lại lỗi (đã xác minh: AI vision không tự
// động tránh được lỗi này nếu input vẫn là PDF có text layer). Render ra
// ẢNH THUẦN (PNG) thì không còn lớp text nào để bất kỳ ai/cái gì đọc nhầm —
// chỉ còn pixel, buộc phải đọc bằng OCR/vision thật.
const renderPageToImage = async (pdfBuffer, pageIndex) => {
  const mu = await getMupdf()
  if (!mu) throw new Error('mupdf không khả dụng trong môi trường này')
  const doc = mu.Document.openDocument(pdfBuffer, 'application/pdf')
  const page = doc.loadPage(pageIndex)
  const pixmap = page.toPixmap(mu.Matrix.scale(2, 2), mu.ColorSpace.DeviceRGB)
  return Buffer.from(pixmap.asPNG())
}

// ── OCR bằng Tesseract.js — miễn phí tuyệt đối, không cần Google/Groq ──
// Lý do tồn tại: khi Gemini bị chặn (như đợt key AQ. hiện tại) vẫn cần 1
// đường OCR luôn hoạt động được, không phụ thuộc tài khoản/key bên ngoài.
// Đã verify bằng dữ liệu thật: đọc đúng "BỘ XÂY DỰNG", "CỘNG HÒA XÃ HỘI CHỦ
// NGHĨA VIỆT NAM"... trên đúng trang bị lỗi CMap của file 3482.
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

const getGroqKeys = () => [
  process.env.VITE_GROQ_API_KEY,
  process.env.VITE_GROQ_API_KEY_2,
  process.env.VITE_GROQ_API_KEY_3,
].filter(Boolean)

// Gemini keys bị xóa — AQ. format không dùng được (401 "Expected OAuth 2 access token")

const getGhToken = () =>
  process.env.VITE_GH_TOKEN || process.env.GH_TOKEN || ''

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
- Nếu có dòng/cụm lặp lại nhiều lần không mang thông tin (watermark, header/footer hệ thống tải về...) — chỉ giữ lại 1 lần đầu, không lặp lại toàn bộ trong kết quả
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

// ── Phát hiện lỗi bảng mã (broken CMap) — khác hẳn lỗi watermark ──
// Lý do tồn tại: file 3482 trang 1-2 có lớp text ĐỦ DÀI (vượt ngưỡng 80
// ký tự/trang, qua được mọi check khác) nhưng là RÁC do PDF có bảng ánh xạ
// ký tự (ToUnicode CMap) bị hỏng — chữ hiển thị đúng khi xem/in, nhưng dữ
// liệu text ẩn bên dưới (dùng để copy/trích xuất) trỏ sai sang số/ký hiệu
// khác (VD: "ĐỊNH" bị trích thành "D1NH", "DỰNG" thành "DI)G"). Không sửa
// được bằng cách đổi OCR — ĐÃ TEST: ngay cả AI đọc qua vision cũng kế thừa
// lỗi này nếu nó ưu tiên dùng lớp text nhúng sẵn. Tín hiệu đáng tin duy
// nhất: tỷ lệ ký tự CÓ DẤU trên tổng ký tự bất thường thấp. Đã verify bằng
// dữ liệu thật: văn bản hành chính VN thật ~16-19%, văn bản lỗi CMap ~4.68%.
const accentRatio = (text) => {
  const matches = text.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []
  return matches.length / Math.max(text.length, 1)
}

// ── Phát hiện watermark/nội dung lặp lại đánh lừa classifier ──────
// Lý do tồn tại: file 5379 có watermark "Da.phongnv VATM Thông tin tải về..."
// lặp đi lặp lại đủ nhiều để vượt ngưỡng avgCharsPerPage, khiến code tưởng
// "có chữ tốt rồi" và KHÔNG gọi OCR. Không hardcode theo đúng câu watermark
// đó (không tổng quát) — đo độ LẶP LẠI bằng tỷ lệ nén zlib: nội dung lặp
// nhiều nén được rất gọn (tỷ lệ thấp), văn bản hành chính thật có từ vựng
// đa dạng nén kém hơn nhiều (tỷ lệ cao hơn).
// ĐÃ TEST bằng dữ liệu thật (file 5379, đúng lô trang 17-22 gây lỗi gốc):
// phiên bản đầu dùng cửa sổ trượt cố định 60 ký tự đã SAI — watermark lặp
// theo chu kỳ ~85 ký tự, không chia hết cho 60, mỗi cửa sổ rơi vào "pha"
// khác nhau của chu kỳ lặp nên tưởng là không lặp (ratio=1.00, bỏ lọt đúng
// lô lỗi). Tỷ lệ nén không phụ thuộc chu kỳ lặp dài bao nhiêu, đã verify
// bắt đúng lô 17-22 (tỷ lệ nén 0.17) trong khi không báo nhầm cho nội dung
// thật đa dạng từ vựng.
const hasLowContentDiversity = (text) => {
  if (text.length < 200) return false
  const zlib = require('zlib')
  const original = Buffer.byteLength(text, 'utf8')
  const compressed = zlib.deflateSync(text).length
  return (compressed / original) < 0.2
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

// Gemini bị xóa hoàn toàn — AQ. key không dùng được, dùng Groq Vision thay thế

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

// ── Groq Vision OCR — đọc ảnh PNG của từng trang PDF ──────────────
// Dùng cho cả scan PDF và text PDF bị lỗi CMap/watermark.
// mupdf render trang → PNG buffer → base64 → Groq Vision.
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
const OCR_PROMPT = (fileName, pageLabel) =>
  `Đây là ảnh ${pageLabel} của tài liệu "${fileName}".
Trích xuất TOÀN BỘ nội dung văn bản nhìn thấy trong ảnh.
- Giữ nguyên 100% câu chữ, số liệu, tên, ngày tháng
- Bảng biểu → Markdown table
- Tiêu đề → ## ###
- Chữ ký/dấu mộc: ghi *(Đã ký)* / *(Có dấu)*
- Header/footer lặp lại: bỏ qua
- Chỉ trả về Markdown thuần, không giải thích`

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

// ── OCR.space — fallback khi Groq Vision không dùng được ───────────
// Nhận PNG buffer (không phải PDF) vì ta đã render ảnh rồi.
// Giới hạn free tier: 1MB/request.
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

// ── OCR 1 trang: Groq Vision → OCR.space → Tesseract ──────────────
const ocrOnePage = async (imageBuffer, fileName, pageLabel) => {
  const groq = await callGroqVisionOCR(imageBuffer, fileName, pageLabel)
  if (groq) return groq
  const ocrspace = await callOcrSpace(imageBuffer, pageLabel)
  if (ocrspace) return ocrspace
  const tesseract = await callTesseractOCR(imageBuffer)
  if (tesseract && tesseract.trim().length > 20) return { text: tesseract, model: 'tesseract' }
  return null
}

        })
        if (res.status === 429) continue
        if (!res.ok) continue
        const data = await res.json()
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
        if (!isLikelyInvalid(text, 1)) return { text, model }
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
  let corruptedText = false // CÓ lớp text dài nhưng là rác (watermark lặp/lỗi CMap) — khác "scan thật"
  let totalPages = null
  try {
    const pdfParse = require('pdf-parse')
    const data = await pdfParse(pdfBuffer, { max: toPage })
    const rawText = data.text || ''
    totalPages = data.numpages || 1

    // Ước tính phần text từ trang fromPage đến toPage
    // SỬA 22/6/2026: pdf-parse({max:N}) chỉ trích xuất text từ trang 1..N,
    // nhưng data.numpages luôn trả tổng số trang THẬT của cả file (không bị
    // giới hạn bởi max). Code cũ chia rawText.length / totalPages (tổng số
    // trang cả file) — với file dài (vd 44 trang) mà chỉ trích 1-2 trang đầu,
    // phép chia này sai gấp hàng chục lần, cắt mất gần hết nội dung thật.
    // Phải chia theo SỐ TRANG THẬT ĐÃ TRÍCH (min(toPage, totalPages)).
    const pagesActuallyExtracted = Math.min(toPage, totalPages)
    const charsPerPage = rawText.length / pagesActuallyExtracted
    const startChar = Math.floor((fromPage - 1) * charsPerPage)
    const endChar = Math.floor(toPage * charsPerPage)
    extractedText = rawText.slice(startChar, endChar).trim()

    // PDF scan thì text rất ít hoặc toàn ký tự rác
    const hasVietnamese = /[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/i.test(extractedText)
    const avgCharsPerPage = extractedText.length / Math.max(toPage - fromPage + 1, 1)
    const lowDiversity = hasLowContentDiversity(extractedText)
    const lowAccentRatio = accentRatio(extractedText) < 0.08
    // 2 loại nguyên nhân khác nhau — cần OCR khác nhau:
    // - "no-text": không có lớp text dùng được (scan thật) -> gửi PDF cho Gemini OCR bình thường
    // - "corrupted-text": CÓ lớp text dài nhưng là rác (watermark lặp / lỗi CMap)
    //   -> phải render ảnh bỏ lớp text trước, không thì AI có thể đọc nhầm lại lớp text hỏng
    const noUsableText = !hasVietnamese || avgCharsPerPage < 80
    corruptedText = !noUsableText && (lowDiversity || lowAccentRatio)
    isScan = noUsableText || corruptedText

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

  // ── Lớp text bị hỏng (watermark lặp / lỗi CMap) → render ảnh trước ──
  // Render từng trang ra PNG (bỏ hẳn lớp text), gửi ảnh cho Groq Vision.
  // Fallback: OCR.space → Tesseract (qua ocrOnePage).
  if (corruptedText) {
    try {
      const texts = []
      for (let p = fromPage; p <= toPage; p++) {
        const img = await renderPageToImage(pdfBuffer, p - 1) // mupdf 0-indexed
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
      // Rơi xuống nhánh scan PDF bên dưới
    }
  }

  // ── PDF scan thật (không có lớp text) → render từng trang → Groq Vision ─
  try {
    const { totalPages: realTotalPages } = await extractPageRange(pdfBuffer, fromPage, toPage)
    if (realTotalPages) totalPages = realTotalPages

    const texts = []
    for (let p = fromPage; p <= toPage; p++) {
      const img = renderPageToImage(pdfBuffer, p - 1)
      const r = await ocrOnePage(img, fileName || 'document', `trang ${p}`)
      texts.push(`## Trang ${p}\n\n${r ? r.text : '[không đọc được]'}`)
    }
    const finalText = texts.join('\n\n')
    return res.status(200).json({
      ok: true, docId,
      batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
      text: finalText, charCount: finalText.length,
      method: 'groq-vision-ocr',
    })
  } catch (e) {
    console.error('[process-batch] Lỗi scan PDF OCR:', e.message)
    return res.status(422).json({
      error: 'Không OCR được trang này: ' + e.message,
      isScan: true, batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
    })
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
      warning: 'PDF scan/font lỗi — OCR không trả được nội dung hợp lệ. Đây là text thô (có thể sai/méo), CẦN người kiểm tra lại.',
    })
  }

  return res.status(422).json({
    error: 'Không đọc được nội dung trang này — pdf-parse không có text, Groq Vision OCR cũng thất bại.',
    isScan: true, needsReview: true,
    batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
  })
}
