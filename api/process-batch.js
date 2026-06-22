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
import * as mupdf from 'mupdf'
import { createWorker } from 'tesseract.js'
const require = createRequire(import.meta.url)

// ── Render trang PDF thành ảnh, BỎ HOÀN TOÀN lớp text gốc ─────────
// Lý do tồn tại: lỗi CMap/watermark nằm ở LỚP TEXT — nếu vẫn gửi PDF gốc
// (kèm lớp text hỏng) cho Gemini qua inline_data, Gemini có thể tự lấy lớp
// text nhúng sẵn cho rẻ và kế thừa lại lỗi (đã xác minh: AI vision không tự
// động tránh được lỗi này nếu input vẫn là PDF có text layer). Render ra
// ẢNH THUẦN (PNG) thì không còn lớp text nào để bất kỳ ai/cái gì đọc nhầm —
// chỉ còn pixel, buộc phải đọc bằng OCR/vision thật.
const renderPageToImage = (pdfBuffer, pageIndex) => {
  const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf')
  const page = doc.loadPage(pageIndex)
  const pixmap = page.toPixmap(mupdf.Matrix.scale(2, 2), mupdf.ColorSpace.DeviceRGB)
  return Buffer.from(pixmap.asPNG())
}

// ── OCR bằng Tesseract.js — miễn phí tuyệt đối, không cần Google/Groq ──
// Lý do tồn tại: khi Gemini bị chặn (như đợt key AQ. hiện tại) vẫn cần 1
// đường OCR luôn hoạt động được, không phụ thuộc tài khoản/key bên ngoài.
// Đã verify bằng dữ liệu thật: đọc đúng "BỘ XÂY DỰNG", "CỘNG HÒA XÃ HỘI CHỦ
// NGHĨA VIỆT NAM"... trên đúng trang bị lỗi CMap của file 3482.
const callTesseractOCR = async (imageBuffer) => {
  const worker = await createWorker('vie')
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
                { text: `Bạn là công cụ chuyển đổi PDF sang Markdown chuyên dụng — KHÔNG phải trợ lý tư vấn, KHÔNG tóm tắt, KHÔNG bình luận, chỉ chuyển đổi định dạng.

Đây là ${pageCount} trang trích từ tài liệu "${fileName}" (tương ứng trang ${fromPage}-${toPage} của bản gốc).

NGUYÊN TẮC:
- Trung thực tuyệt đối: không bỏ sót câu/đoạn nào, không diễn giải lại, không tóm tắt thay nội dung đầy đủ
- Giữ đúng ngôn ngữ gốc (tiếng Việt có dấu/tiếng Anh), không dịch
- Đọc đúng thứ tự tự nhiên; nếu bố cục nhiều cột, đọc lần lượt theo logic nội dung, không theo vị trí pixel
- KHÔNG tự suy diễn đoạn không đọc được (mờ/rách/mất nét) — đánh dấu [không đọc được] tại đúng vị trí, không đoán
- Số liệu, đơn vị kỹ thuật (kV, kVA, %, TCVN, IEC...): giữ chính xác 100%, không làm tròn, không đổi đơn vị
- Chữ ký/dấu mộc: ghi chú *(Đã ký)*, *(Có dấu)* — KHÔNG transcribe lại watermark/dấu chìm/dấu mộc lặp lại nhiều lần
- Header/footer lặp lại không mang thông tin (số trang, watermark hệ thống tải về...): bỏ qua, không lặp lại trong kết quả
- Bảng biểu → Markdown table; tiêu đề → #/##/### đúng cấp bậc; danh sách giữ đúng -, 1. 2. 3. như bản gốc
- Văn bản hành chính (số/ký hiệu, ngày, người ký, cơ quan): giữ đúng format chuẩn

Chỉ trả về nội dung Markdown thuần. Không bọc code block, không lời chào/giới thiệu/nhận xét trước hoặc sau nội dung.` },
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

// ── OCR.space — nhà cung cấp OCR thứ 2, ĐỘC LẬP với Google ────────
// Lý do tồn tại: Gemini đang bị chặn ở cấp tài khoản Google (key chỉ ra
// được dạng AQ., không sửa được từ phía mình). OCR.space có API free thật
// (không phải web giả lập), không liên quan gì tới Google — khi Gemini sống
// lại thì vẫn còn nhà cung cấp dự phòng này, không còn phụ thuộc 1 nguồn duy
// nhất. Giới hạn free tier: 1MB/request — nếu lô trang quá lớn, bỏ qua sạch
// (không cố gửi thiếu dữ liệu), rơi xuống nhánh fallback bên dưới.
const callOcrSpace = async (pageBuffer, fromPage, toPage) => {
  const apiKey = process.env.OCRSPACE_API_KEY
  if (!apiKey) return null
  const pageCount = toPage - fromPage + 1
  if (pageBuffer.length > 900 * 1024) {
    console.error(`[process-batch] Lô trang ${fromPage}-${toPage} (${Math.round(pageBuffer.length / 1024)}KB) vượt giới hạn free tier OCR.space (~900KB) — bỏ qua, không thử.`)
    return null
  }
  try {
    const base64 = pageBuffer.toString('base64')
    const body = new URLSearchParams({
      apikey: apiKey,
      base64Image: `data:application/pdf;base64,${base64}`,
      filetype: 'PDF',
      language: 'vie',
      OCREngine: '2',
      isCreateSearchablePdf: 'false',
    })
    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) { console.error('[process-batch] OCR.space HTTP', res.status); return null }
    const data = await res.json()
    if (data.IsErroredOnProcessing) {
      console.error('[process-batch] OCR.space báo lỗi xử lý:', data.ErrorMessage || JSON.stringify(data).slice(0, 200))
      return null
    }
    const text = (data.ParsedResults || []).map(r => r.ParsedText || '').join('\n').trim()
    if (isLikelyInvalid(text, pageCount)) {
      console.error(`[process-batch] OCR.space trả nội dung không hợp lệ cho trang ${fromPage}-${toPage}`)
      return null
    }
    return { text, model: 'ocr.space' }
  } catch (e) {
    console.error('[process-batch] lỗi gọi OCR.space:', e.message)
    return null
  }
}

// ── Gemini đọc ẢNH đã render (không phải PDF) — dùng cho lỗi CMap ─
// Khác callGeminiOCR ở trên: gửi PNG thuần, không có lớp text nào trong
// ảnh để Gemini lấy nhầm — buộc phải đọc bằng vision thật.
const callGeminiVisionImage = async (imageBuffer, fileName, pageLabel) => {
  const keys = getGeminiKeys()
  const base64Img = imageBuffer.toString('base64')
  for (const key of keys) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(geminiUrl(model, key), {
          method: 'POST',
          headers: geminiHeaders(key),
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'image/png', data: base64Img } },
                { text: `Đây là ảnh chụp ${pageLabel} của tài liệu "${fileName}". Đọc và trích xuất TOÀN BỘ nội dung nhìn thấy trong ảnh. Giữ nguyên 100% câu chữ, số liệu. Chỉ trả về Markdown thuần, không giải thích.` },
              ],
            }],
            generationConfig: { temperature: 0, maxOutputTokens: 4096 },
          }),
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
  // Không gửi PDF gốc cho Gemini ở đây — nó có lớp text hỏng, AI có thể
  // lấy nhầm lớp đó. Render từng trang ra ảnh PNG (bỏ hẳn lớp text), gửi
  // ảnh cho Gemini vision; nếu Gemini không khả dụng, tự OCR bằng
  // tesseract.js — miễn phí, không phụ thuộc Google.
  if (corruptedText) {
    try {
      const pages = []
      for (let p = fromPage; p <= toPage; p++) pages.push(p)
      const texts = []
      for (const p of pages) {
        const img = renderPageToImage(pdfBuffer, p - 1) // mupdf 0-indexed
        const pageLabel = `trang ${p}`
        let pageText = null
        if (getGeminiKeys().length) {
          const r = await callGeminiVisionImage(img, fileName || 'document', pageLabel)
          if (r) pageText = r.text
        }
        if (!pageText) pageText = await callTesseractOCR(img) // fallback miễn phí
        texts.push(`## Trang ${p}\n\n${pageText || '[không đọc được]'}`)
      }
      const finalText = texts.join('\n\n')
      return res.status(200).json({
        ok: true, docId,
        batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
        text: finalText, charCount: finalText.length,
        method: 'render-image-ocr',
      })
    } catch (e) {
      console.error('[process-batch] Lỗi render ảnh + OCR:', e.message)
      // Rơi xuống nhánh OCR PDF thường phía dưới như phương án dự phòng
    }
  }

  // ── PDF scan thật (không có lớp text) → cắt đúng trang rồi gửi OCR ─
  try {
    const { buffer: pageBuffer, totalPages: realTotalPages } = await extractPageRange(pdfBuffer, fromPage, toPage)
    if (realTotalPages) totalPages = realTotalPages

    const geminiKeys = getGeminiKeys()
    const ocrResult = (geminiKeys.length ? await callGeminiOCR(pageBuffer, fileName || 'document', fromPage, toPage) : null)
      || await callOcrSpace(pageBuffer, fromPage, toPage)

    if (ocrResult) {
      return res.status(200).json({
        ok: true, docId,
        batchIndex: batchIndex ?? 0, fromPage, toPage, totalPages,
        text: ocrResult.text, charCount: ocrResult.text.length,
        method: 'ocr', model: ocrResult.model,
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
