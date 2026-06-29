// src/hooks/useProcessPipeline.js
// Pipeline: fileUrl → extract text/OCR → AI analysis → Firestore
//
// OCR chain (PDF scan, khi lớp text PDF không đọc được/có watermark/lỗi CMap):
//   1. AI Vision — Gemini trước, Groq sau, OpenRouter (Llama 4 Maverick) thứ 3,
//      OCR.space (OCR thuần, không phải AI) thứ 4 — đọc theo lô nhiều trang/lệnh
//      gọi (riêng OCR.space xử lý từng trang lẻ trong lô)
//   2. Tesseract.js (chạy trong browser, KHÔNG cần API key, dự phòng cuối cùng)
//
// AI chain (phân tích/format markdown):
//   1. Groq (nếu có key hợp lệ)
//   2. Gemini proxy (nếu key hợp lệ trên Vercel)
//   3. Basic formatter (tự động format text thành markdown, KHÔNG cần AI)
//
// → Pipeline KHÔNG bao giờ fail hoàn toàn kể cả khi mọi API đều lỗi
// ⚠️ Đã bỏ Mistral OCR (27/6/2026) — không dùng api/ocr-document.js trong pipeline này nữa.

import { useState } from 'react'
import { createWorker } from 'tesseract.js'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

// ─── Load pdf.js từ CDN ────────────────────────────────────────────────────
const loadPdfJs = () => new Promise((res, rej) => {
  if (window.pdfjsLib) { res(window.pdfjsLib); return }
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    res(window.pdfjsLib)
  }
  s.onerror = () => rej(new Error('Không load được pdf.js'))
  document.head.appendChild(s)
})

const loadScript = (src, check) => new Promise((res, rej) => {
  if (check()) { res(); return }
  const s = document.createElement('script')
  s.src = src; s.onload = res; s.onerror = rej
  document.head.appendChild(s)
})

// ─── Extract text layer từ PDF (text-based PDF) ───────────────────────────
const extractPdfText = async (buf) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  let text = ''
  const maxPages = Math.min(pdf.numPages, 50)
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map(it => it.str).join(' ') + '\n'
  }
  return { text: text.trim(), totalPages: pdf.numPages }
}

// ─── Render trang PDF thành canvas ────────────────────────────────────────
const renderPageToCanvas = async (page, scale = 2.0) => {
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  return canvas
}

// Giảm chất lượng JPEG (0.85→0.7) để giảm dung lượng base64 — văn bản scan độ
// phân giải cao (như file 36MB/125 trang) dễ làm 1 lô 4 ảnh vượt giới hạn 4.5MB
// request body của Vercel, gây 502 Bad Gateway ở MỌI lần gọi (đã xác nhận thực tế).
const canvasToBase64 = (canvas) => canvas.toDataURL('image/jpeg', 0.7).split(',')[1]

// Phát hiện lớp text bị lỗi bảng mã (CMap hỏng) — chữ hiển thị đúng khi xem/in
// nhưng dữ liệu text ẩn bên dưới bị trỏ sai ký tự (mất dấu tiếng Việt có hệ thống).
// Văn bản hành chính VN thật ~16-19% ký tự có dấu, văn bản lỗi CMap ~4-5% (đã verify
// dữ liệu thật). Khác với kiểm tra "avgChars"/watermark, đây bắt được trường hợp
// text ĐỦ DÀI nhưng SAI KÝ TỰ — loại lỗi không bị 2 kiểm tra kia phát hiện.
const accentRatio = (text) => {
  const matches = text.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []
  return matches.length / Math.max(text.length, 1)
}

const PAGES_PER_VISION_BATCH = 4 // gộp tối đa 4 trang/lệnh gọi (Groq Vision giới hạn cứng 5 ảnh/request)

// ─── Đọc 1 LÔ nhiều trang (ảnh base64[]) bằng AI Vision trong 1 lệnh gọi ──
// Gộp nhiều trang/lệnh gọi để giảm số lượt cần dùng — quan trọng với văn bản
// nhiều trang (vd 100+ trang), tránh dùng hết quota AI Vision chỉ cho 1 văn bản.
const ocrBatchWithVision = async (b64Images, pageNumbers, providerState) => {
  const prompt = `Đọc toàn bộ nội dung trong ${b64Images.length} ảnh sau — đây là các trang ${pageNumbers.join(', ')} của 1 văn bản tiếng Việt (có thể là văn bản hành chính, hợp đồng, hoặc biên bản).

Với MỖI ảnh, trả về nội dung theo đúng cấu trúc:
## Trang {số trang}
{nội dung đầy đủ của trang đó}

Quy tắc cho từng trang:
- Giữ nguyên cấu trúc: tiêu đề, số điều/khoản, MỤC CON đánh số (1.1, 1.2... hoặc a, b, c...), bảng biểu, chữ ký — không gộp các mục con thành 1 đoạn liền
- Bảng → markdown table, ghi ĐẦY ĐỦ TỪNG DÒNG, không tóm lược dù bảng dài
- Số liệu, ngày tháng, tên người/cơ quan: CHÉP CHÍNH XÁC từng chữ, không suy đoán
- KHÔNG thêm bình luận ngoài nội dung trang, KHÔNG thêm "Dưới đây là nội dung..."
- PHẢI có đủ "## Trang N" cho TẤT CẢ ${b64Images.length} trang, đúng thứ tự: ${pageNumbers.join(', ')}`

  // 1) Gemini Vision trước — BỎ QUA nếu vừa fail liên tục ở các lô trước trong
  // LƯỢT CHẠY NÀY (đỡ tốn thời gian/lượt gọi thử lại 1 nhà cung cấp chắc chắn
  // đang không hoạt động). Lượt "Phân tích lại"/"Tiếp tục" SAU sẽ thử lại từ đầu.
  if ((providerState?.gemini || 0) < 2) {
    try {
      const parts = [{ text: prompt }]
      b64Images.forEach(b64 => parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } }))
      const res = await fetch('/api/gemini-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts, maxTokens: 10000 }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.text && data.text.trim().length > 20) { if (providerState) providerState.gemini = 0; return data.text }
      }
      if (providerState) providerState.gemini = (providerState.gemini || 0) + 1
    } catch { if (providerState) providerState.gemini = (providerState.gemini || 0) + 1 }
  }

  // 2) Groq Vision sau (Llama 4 Scout — tối đa 5 ảnh/lệnh gọi; ⚠️ Groq deprecate
  // 27/6/2026, ngừng hẳn 17/7/2026 — xem ghi chú trong api/groq-proxy.js)
  if ((providerState?.groq || 0) < 2) {
    try {
      const content = [{ type: 'text', text: prompt }]
      b64Images.forEach(b64 => content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
      const res = await fetch('/api/groq-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vision: true, maxTokens: 10000, messages: [{ role: 'user', content }] }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.text && data.text.trim().length > 20) { if (providerState) providerState.groq = 0; return data.text }
      }
      if (providerState) providerState.groq = (providerState.groq || 0) + 1
    } catch { if (providerState) providerState.groq = (providerState.groq || 0) + 1 }
  }

  // 3) OpenRouter Vision (Llama 4 Maverick :free) — hạ tầng RIÊNG của OpenRouter,
  // không liên quan đến việc Groq khai tử bản họ tự host. Đây là lớp dự phòng
  // độc lập thứ 3, chỉ chạy khi cả Gemini và Groq đều thất bại cho lô trang này.
  if ((providerState?.openrouter || 0) < 2) {
    try {
      const content = [{ type: 'text', text: prompt }]
      b64Images.forEach(b64 => content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }))
      const res = await fetch('/api/openrouter-proxy', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maxTokens: 10000, messages: [{ role: 'user', content }] }),
      })
      if (res.ok) {
        const data = await res.json()
        if (data.text && data.text.trim().length > 20) { if (providerState) providerState.openrouter = 0; return data.text }
      }
      if (providerState) providerState.openrouter = (providerState.openrouter || 0) + 1
    } catch { if (providerState) providerState.openrouter = (providerState.openrouter || 0) + 1 }
  }

  // 4) OCR.space (OCR thuần, không phải AI) — phương án cuối trước Tesseract.
  // Khác 3 lớp trên: chỉ nhận 1 ảnh/lần nên phải xử lý riêng từng trang trong lô,
  // và chỉ trả text thô (không hiểu cấu trúc bảng tốt như AI Vision thật). Không
  // áp dụng bỏ-qua-khi-fail-liên-tục vì OCR.space giới hạn theo IP cố định 500/ngày,
  // không có khái niệm "tạm thời quá tải" như rate-limit AI.
  try {
    const pageTexts = await Promise.all(b64Images.map(async (b64, idx) => {
      try {
        const res = await fetch('/api/ocrspace-proxy', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: b64 }),
        })
        if (res.ok) {
          const data = await res.json()
          if (data.text) return `## Trang ${pageNumbers[idx]}\n${data.text}`
        }
      } catch {}
      return null
    }))
    const validPages = pageTexts.filter(Boolean)
    if (validPages.length > 0) return validPages.join('\n\n')
  } catch {}

  return null
}

// ─── OCR bằng AI Vision (Gemini→Groq), đọc theo LÔ nhiều trang/lệnh gọi ──
// Nhờ gộp lô, có thể nâng giới hạn trang lên nhiều mà vẫn tiết kiệm quota
// (125 trang ÷ 4 trang/lô ≈ 32 lệnh gọi, thay vì 125 lệnh nếu đọc từng trang).
const ocrWithAIVision = async (buf, onStatus, docId, resumeState = null) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  const totalPgs = Math.min(pdf.numPages, 150) // trần an toàn, đủ cho hầu hết văn bản thực tế

  // Đo nhanh dung lượng ảnh trang đầu để CHỌN SỐ TRANG/LÔ AN TOÀN — văn bản scan độ
  // phân giải cao (vd file 36MB/125 trang) tạo ảnh nặng hơn nhiều so với văn bản
  // thường, dễ làm 1 lô vượt giới hạn 4.5MB request body của Vercel → gây 502 Bad
  // Gateway ở MỌI lô (đã xác nhận xảy ra thực tế, không phải lỗi ngẫu nhiên).
  const SAFE_BATCH_BYTES = 3 * 1024 * 1024 // để dư margin so với trần 4.5MB của Vercel
  let dynamicBatchSize = PAGES_PER_VISION_BATCH
  try {
    const samplePage = await pdf.getPage(1)
    const sampleCanvas = await renderPageToCanvas(samplePage, 1.5)
    const estPageBytes = canvasToBase64(sampleCanvas).length * 0.75 // base64 → byte thật
    dynamicBatchSize = Math.max(1, Math.min(PAGES_PER_VISION_BATCH, Math.floor(SAFE_BATCH_BYTES / Math.max(estPageBytes, 80000))))
    if (dynamicBatchSize < PAGES_PER_VISION_BATCH) {
      onStatus?.(`📏 Trang scan nặng (~${(estPageBytes/1024).toFixed(0)}KB/trang) — dùng lô ${dynamicBatchSize} trang để tránh vượt giới hạn server...`)
    }
  } catch { /* đo lỗi → dùng mặc định */ }

  const batches = []
  for (let i = 1; i <= totalPgs; i += dynamicBatchSize) {
    const end = Math.min(i + dynamicBatchSize - 1, totalPgs)
    batches.push(Array.from({ length: end - i + 1 }, (_, k) => i + k))
  }

  // Nếu có tiến độ cũ khớp đúng văn bản này (cùng tổng số lô) → tiếp tục từ lô bị
  // dừng, KHÔNG đọc lại từ đầu — tránh tốn token/thời gian gấp đôi cho file dài
  // khi bị dừng giữa đường (mất mạng, đóng tab, lỗi 502/504 từ proxy AI...).
  let startBatch = 0, allText = '', failedPages = 0
  if (resumeState && resumeState.totalBatches === batches.length && resumeState.completedBatches < batches.length) {
    startBatch = resumeState.completedBatches
    allText = resumeState.partialText || ''
    failedPages = resumeState.failedPages || 0
    onStatus?.(`⏩ Tiếp tục từ lô ${startBatch + 1}/${batches.length} (đã đọc xong ${startBatch} lô trước đó, không đọc lại)...`)
  } else {
    onStatus?.(`👁️ AI Vision đọc văn bản (${totalPgs} trang, ${batches.length} lượt gọi)...`)
  }

  // Theo dõi nhà cung cấp nào đang fail liên tục TRONG LƯỢT CHẠY NÀY — nếu 1 nhà
  // cung cấp fail 2 lần liên tiếp (vd hết quota), bỏ qua nó cho các lô còn lại
  // thay vì cứ thử lại vô ích mỗi lô. Lượt "Phân tích lại"/"Tiếp tục" SAU sẽ reset
  // lại, thử từ đầu (quota có thể đã hồi).
  const providerState = { gemini: 0, groq: 0, openrouter: 0 }
  const labelOf = { gemini: 'Gemini', groq: 'Groq', openrouter: 'OpenRouter' }

  for (let b = startBatch; b < batches.length; b++) {
    const pageNums = batches[b]
    const skipped = Object.entries(providerState).filter(([,v]) => v >= 2).map(([k]) => labelOf[k])
    const skipNotice = skipped.length ? ` (đang bỏ qua: ${skipped.join(', ')})` : ''
    onStatus?.(`👁️ AI Vision đọc trang ${pageNums[0]}-${pageNums[pageNums.length - 1]}/${totalPgs} (lô ${b + 1}/${batches.length})${skipNotice}...`)
    try {
      const images = []
      for (const pNum of pageNums) {
        const page = await pdf.getPage(pNum)
        const canvas = await renderPageToCanvas(page, 1.5)
        images.push(canvasToBase64(canvas))
      }
      const text = await ocrBatchWithVision(images, pageNums, providerState)
      if (text) { allText += text + '\n\n' } else { failedPages += pageNums.length }
    } catch (e) {
      console.warn(`[AI Vision] lô trang ${pageNums.join(',')} lỗi:`, e.message)
      failedPages += pageNums.length
    }

    // Lưu tiến độ NGAY sau MỖI lô — nếu bị dừng giữa đường, lần "Phân tích tiếp"
    // sau sẽ đọc tiếp từ đây, không mất công các lô đã đọc xong.
    if (docId) {
      try {
        await setDoc(doc(db, 'documentMarkdown', docId), {
          ocrProgress: {
            completedBatches: b + 1, totalBatches: batches.length,
            partialText: allText.slice(0, 150000), failedPages,
          },
        }, { merge: true })
      } catch (e) { console.warn('[AI Vision] lưu tiến độ lỗi:', e.message) }
    }
  }
  return { text: allText.trim(), failedCount: failedPages, totalPgs }
}

// ─── OCR bằng Tesseract.js (chạy trong browser, không cần API) ───────────
const ocrWithTesseract = async (buf, onStatus, docId, resumeState = null) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  // Tesseract rất chậm (có thể hàng giờ cho văn bản 100+ trang) — giới hạn 60 trang
  // làm phương án CUỐI CÙNG, vì nếu đã rơi đến đây nghĩa là cả 3 lớp AI Vision đều
  // thất bại, không nên buộc người dùng chờ quá lâu cho 1 phương án chất lượng thấp.
  const totalPgs = Math.min(pdf.numPages, 60)

  let startPage = 1, allText = ''
  if (resumeState && resumeState.engine === 'tesseract' && resumeState.lastPage < totalPgs) {
    startPage = resumeState.lastPage + 1
    allText = resumeState.partialText || ''
    onStatus?.(`⏩ Tesseract tiếp tục từ trang ${startPage}/${totalPgs}...`)
  } else {
    onStatus?.(`🔤 Khởi động Tesseract OCR (${totalPgs} trang)...`)
  }

  // Tạo worker Tesseract với tiếng Việt + tiếng Anh
  const worker = await createWorker(['vie', 'eng'], 1, {
    logger: m => {
      if (m.status === 'recognizing text' && onStatus) {
        const pct = Math.round((m.progress || 0) * 100)
        if (pct % 20 === 0) onStatus(`🔤 Đang nhận dạng... ${pct}%`)
      }
    },
  })

  for (let i = startPage; i <= totalPgs; i++) {
    onStatus?.(`🔤 Tesseract OCR trang ${i}/${totalPgs}...`)
    try {
      const page = await pdf.getPage(i)
      const canvas = await renderPageToCanvas(page, 2.0)
      const { data: { text } } = await worker.recognize(canvas)
      allText += (text || '') + '\n'
    } catch (e) {
      console.warn(`[Tesseract] trang ${i} lỗi:`, e.message)
    }

    // Lưu tiến độ sau MỖI trang — cùng nguyên tắc với AI Vision, tránh mất công
    // nếu bị dừng giữa đường (Tesseract chạy lâu, rủi ro gián đoạn cao hơn).
    if (docId) {
      try {
        await setDoc(doc(db, 'documentMarkdown', docId), {
          ocrProgress: { engine: 'tesseract', lastPage: i, totalPages: totalPgs, partialText: allText.slice(0, 150000) },
        }, { merge: true })
      } catch (e) { console.warn('[Tesseract] lưu tiến độ lỗi:', e.message) }
    }
  }

  await worker.terminate()
  return allText.trim()
}

// ─── Extract text từ DOCX (mammoth, có fallback đọc XML thô khi mammoth lỗi) ─
// mammoth hay crash (lỗi "reading 'children'") với file .docx có cấu trúc
// phức tạp (bảng, hình vẽ/đường kẻ chèn trong header...) vì nó cố hiểu CẤU
// TRÚC để chuyển sang HTML. Fallback: bóc trực tiếp text thô trong các thẻ
// <w:t> của XML gốc — không cần hiểu cấu trúc, chỉ cần đủ chữ cho AI đọc.
const extractDocxText = async (buf) => {
  await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    () => window.mammoth
  )
  try {
    const text = (await window.mammoth.extractRawText({ arrayBuffer: buf.slice(0) })).value
    if (text && text.trim().length > 20) return text
    throw new Error('mammoth trả về rỗng')
  } catch (e) {
    console.warn('[extractDocxText] mammoth lỗi, dùng fallback đọc XML thô:', e.message)
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => window.JSZip)
    const zip = await window.JSZip.loadAsync(buf.slice(0))
    const docFile = zip.file('word/document.xml')
    if (!docFile) throw new Error('Không tìm thấy word/document.xml — có thể không phải file .docx hợp lệ')
    const xml = await docFile.async('string')
    const text = (xml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [])
      .map(m => m.replace(/<[^>]+>/g, ''))
      .join(' ')
    if (!text.trim()) throw new Error('Không trích được text nào từ XML')
    return text
  }
}

// Tập ký tự tiếng Việt CHUẨN (không dùng range Unicode tràn lan kiểu À-ỹ vì nó
// vô tình bao trùm cả các khối Hangul/CJK/ký hiệu khác — gây nhận nhầm rác nhị
// phân thành "chữ thật").
const VN_LETTERS = 'A-Za-zĂăÂâĐđÊêÔôƠơƯưÀàẢảÃãÁáẠạẰằẲẳẴẵẶặẨẩẪẫẦầẤấẬậÈèẺẻẼẽÉéẸẹỀềỂểỄễẾếỆệÌìỈỉĨĩÍíỊịÒòỎỏÕõÓóỌọỒồỔổỖỗỐốỘộỜờỞởỠỡỚớỢợÙùỦủŨũÚúỤụỪừỬửỮữỨứỰựỲỳỶỷỸỹÝýỴỵ'
// File .doc CŨ chứa nhiều cấu trúc nhị phân (FIB) trước phần text thật — tìm
// cụm 3 "từ" liên tiếp (chữ + khoảng trắng) đầu tiên để cắt bỏ phần rác đầu.
const findRealTextStart = (s) => {
  const re = new RegExp(`[${VN_LETTERS}]{2,}[ \\t]+[${VN_LETTERS}]{2,}[ \\t]+[${VN_LETTERS}]{2,}`)
  const m = s.match(re)
  return m ? m.index : 0
}
// ─── Extract text từ .doc CŨ (nhị phân OLE/Compound File — mammoth/JSZip
// không đọc được vì không phải zip). Tận dụng XLSX.CFB — module đọc container
// OLE có sẵn TRONG thư viện xlsx.full.min.js (vốn đã tải để đọc Excel, không
// cần thêm thư viện nào) — lấy stream "WordDocument" rồi giải mã UTF-16LE,
// đúng encoding Word dùng để lưu phần lớn text thô. Đã test thực tế với file
// .doc thật, ra đúng toàn văn tiếng Việt có dấu. ──────────────────────────────
const extractLegacyDocText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', () => window.XLSX)
  const cfb = window.XLSX.CFB.read(new Uint8Array(buf.slice(0)), { type: 'array' })
  const idx = cfb.FullPaths.findIndex(p => /WordDocument$/.test(p))
  if (idx === -1) throw new Error('Không tìm thấy nội dung WordDocument trong file .doc')
  const raw = cfb.FileIndex[idx].content
  const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw)
  const decoded = new TextDecoder('utf-16le').decode(bytes)
  const cleaned = decoded.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
  const text = cleaned.slice(findRealTextStart(cleaned)).replace(/\r/g, '\n').trim()
  if (!text) throw new Error('Không trích được text từ file .doc')
  return text
}
// Dispatcher: chọn đúng cách đọc theo phần mở rộng, nhưng vẫn thử cách còn lại
// nếu lỗi — phòng trường hợp file bị đặt nhầm đuôi.
const extractWordText = async (buf, ext) => {
  const primary = ext === 'doc' ? extractLegacyDocText : extractDocxText
  const fallback = ext === 'doc' ? extractDocxText : extractLegacyDocText
  try { return await primary(buf) }
  catch (e1) {
    console.warn(`[extractWordText] Đọc theo đuôi .${ext} lỗi, thử cách còn lại:`, e1.message)
    try { return await fallback(buf) }
    catch (e2) {
      console.warn('[extractWordText] Cách dự phòng cũng lỗi:', e2.message)
      throw new Error('Không đọc được nội dung file Word này — file có thể bị lỗi hoặc hỏng.')
    }
  }
}

// ─── Extract text từ XLSX ──────────────────────────────────────────────────
const extractXlsxText = async (buf) => {
  await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
    () => window.XLSX
  )
  const wb = window.XLSX.read(buf, { type: 'array' })
  let text = ''
  wb.SheetNames.forEach(name => {
    text += `[${name}]\n` + window.XLSX.utils.sheet_to_txt(wb.Sheets[name]) + '\n'
  })
  return text
}

// ─── Basic markdown formatter (KHÔNG dùng AI) ─────────────────────────────
// Dùng khi Groq + Gemini đều không khả dụng
const formatAsMarkdown = (text, fileName) => {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)

  // Tìm số ký hiệu văn bản (pattern VN)
  const docId = lines.find(l => /^\d{1,5}\/[\w-]+/.test(l) || /số[\s:]+\d/i.test(l)) || ''

  // Tìm ngày tháng
  const dateMatch = text.match(/ngày\s+\d{1,2}\s+tháng\s+\d{1,2}\s+năm\s+\d{4}/i)
    || text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/)
  const dateStr = dateMatch ? dateMatch[0] : ''

  // Tóm tắt: 10 dòng đầu có nội dung
  const summary = lines.slice(0, 10).join('\n')

  // Phần thân
  const bodyLines = lines.slice(0, 80)

  // Tìm số tiền
  const moneyMatches = text.match(/[\d,.]+\s*(?:đồng|triệu|tỷ|VND|vnđ)/gi) || []
  const moneyStr = [...new Set(moneyMatches)].slice(0, 5).join(', ')

  // Từ khóa: lấy các từ xuất hiện nhiều
  const words = text.toLowerCase().match(/[a-zàáâãèéêìíòóôõùúưăđ]{4,}/g) || []
  const freq = {}
  words.forEach(w => { freq[w] = (freq[w] || 0) + 1 })
  const keywords = Object.entries(freq)
    .filter(([w]) => !['được', 'trong', 'theo', 'việc', 'này', 'từng', 'thực'].includes(w))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w)

  return `# ${fileName}

## Tổng quan
${summary}

## Thông tin chính
- **Ký hiệu:** ${docId || 'Xem nội dung'}
- **Ngày:** ${dateStr || 'Xem nội dung'}
- **File:** ${fileName}

## Nội dung văn bản
${bodyLines.join('\n')}

## Tài chính
${moneyStr || 'Không có số liệu tài chính được nhận dạng'}

## Từ khóa
${keywords.join(', ')}

---
*Trích xuất tự động bằng Tesseract.js + formatter (không dùng AI)*`
}

// ─── Prompt cho AI ─────────────────────────────────────────────────────────
const buildPrompt = (text, fileName) =>
  `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đây là nội dung văn bản: "${fileName}"

Hãy tổng hợp thành bộ nhớ hoàn chỉnh dạng Markdown với các mục:
## Tổng quan
(tóm tắt 5-10 câu bao quát toàn bộ)

## Thông tin chính
- Số ký hiệu, ngày ban hành, cơ quan ban hành
- Đối tượng áp dụng

## Nội dung quan trọng
(các điểm chính, số liệu cụ thể. QUAN TRỌNG: nếu văn bản có các đề mục/khoản đánh số con (vd 1.1, 1.2... hoặc Tổ trưởng/Tổ phó/Thành viên riêng từng vai trò), PHẢI ghi lại MỖI mục con thành 1 dòng/gạch đầu dòng RIÊNG, không gộp chung vào "nhiệm vụ chung" — đặc biệt khi có 1 mục con áp dụng riêng cho 1 vai trò/đối tượng cụ thể khác với phần chung, ví dụ "Tổ trưởng có trách nhiệm..." khác với nhiệm vụ chung của cả Tổ. Đây là lỗi hay gặp nhất: gộp nhầm mục riêng vào mục chung làm mất thông tin.)

## Nhân sự liên quan
(họ tên, chức vụ nếu có)

## Tài chính & Kỹ thuật
(số tiền, thông số kỹ thuật nếu có — NẾU văn bản có BẢNG thông số/yêu cầu kỹ thuật, PHẢI ghi lại ĐẦY ĐỦ TỪNG DÒNG trong bảng, không tóm lược, không bỏ sót dòng nào dù bảng dài hay có nhiều mục (I, II, III...). Đây là phần hay bị thiếu nhất, cần đặc biệt cẩn thận.)

## Thời hạn & Yêu cầu
(deadline, điều kiện nếu có)

## Từ khóa
(5-15 từ khóa đặc trưng)

NỘI DUNG VĂN BẢN:
${text.slice(0, 100000)}`

// ─── AI phân tích: Groq proxy → Gemini proxy (key luôn ở server) ──────────
const analyzeWithAI = async (text, fileName) => {
  const prompt = buildPrompt(text, fileName)

  // 1. Groq qua /api/groq-proxy — key ở server
  try {
    const res = await fetch('/api/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], maxTokens: 6000 }),
    })
    if (res.ok) {
      const data = await res.json()
      const result = data.text || ''
      if (result.length > 100) return { markdown: result, source: 'groq' }
    }
  } catch { /* fallthrough */ }

  // 2. Gemini proxy server-side
  try {
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens: 6000 }),
    })
    if (res.ok) {
      const data = await res.json()
      const result = data.text || ''
      if (result.length > 100) return { markdown: result, source: 'gemini' }
    }
  } catch {}

  // 3. Basic formatter — KHÔNG dùng AI, luôn thành công
  return { markdown: formatAsMarkdown(text, fileName), source: 'local' }
}

// ─── Hook chính ────────────────────────────────────────────────────────────
export function useProcessPipeline() {
  const [status,   setStatus]   = useState('')
  const [progress, setProgress] = useState(0)

  const startPipeline = async ({ docId, fileUrl, fileName, onStatus, forceRestart = false }) => {
    const report = (msg, pct) => {
      setStatus(msg)
      if (pct !== undefined) setProgress(pct)
      if (onStatus) onStatus(msg)
    }

    try {
      // Kiểm tra đã có markdown chưa — nếu có nghĩa là đã phân tích xong hoàn toàn.
      // Nếu chưa xong nhưng có tiến độ OCR cũ (ocrProgress) → giữ lại để TIẾP TỤC,
      // không đọc lại từ đầu (trừ khi forceRestart=true, tức người dùng bấm "Phân tích lại").
      let existingOcrProgress = null
      if (!forceRestart) {
        const snap = await getDoc(doc(db, 'documentMarkdown', docId))
        if (snap.exists()) {
          if (snap.data().markdown) {
            report('✅ Đã có dữ liệu phân tích')
            return
          }
          existingOcrProgress = snap.data().ocrProgress || null
        }
      }

      // ── 1. Fetch file ──────────────────────────────────────────
      report('📥 Đang tải file...', 5)
      let buf
      try {
        const res = await fetch(fileUrl)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        buf = await res.arrayBuffer()
      } catch (e) {
        throw new Error(`Không tải được file: ${e.message}`)
      }

      const ext = (fileName || '').split('.').pop().toLowerCase()
      const now = serverTimestamp()
      let rawText = ''
      let totalPages = 1
      let isScan = false
      let ocrSource = 'text'

      // ── Đường tắt: .md và .csv ────────────────────────────────
      if (['md', 'csv'].includes(ext)) {
        report(`📋 File ${ext.toUpperCase()} — lưu thẳng vào bộ nhớ...`, 50)
        rawText = new TextDecoder('utf-8').decode(buf)
        if (!rawText.trim()) throw new Error('File rỗng.')

        let markdown = rawText
        if (ext === 'csv') {
          const lines = rawText.trim().split('\n').filter(Boolean)
          if (lines.length > 0) {
            const cols = lines[0].split(',').length
            const sep = Array(cols).fill('---').join(' | ')
            markdown = `# ${fileName}\n\n` +
              lines.slice(0, 1).map(l => `| ${l.replace(/,/g, ' | ')} |`).join('\n') + '\n' +
              `| ${sep} |\n` +
              lines.slice(1).map(l => `| ${l.replace(/,/g, ' | ')} |`).join('\n')
          }
        }

        report('💾 Đang lưu...', 85)
        await setDoc(doc(db, 'documentMarkdown', docId), {
          markdown, rawText: rawText.slice(0, 100000),
          fileName: fileName || '', totalPages: 1,
          charCount: markdown.length, isScan: false,
          source: ext, updatedAt: now,
        })
        await setDoc(doc(db, 'documentMemory', docId), {
          summary: rawText.slice(0, 500),
          hasFullMarkdown: true, fileName: fileName || '',
          source: ext, analyzedAt: now,
        })
        setProgress(100)
        report(`✅ Đã lưu ${ext.toUpperCase()} vào bộ nhớ!`, 100)
        return
      }

      // ── 2. Extract text / OCR ──────────────────────────────────
      if (ext === 'pdf') {
        report('📄 Đang đọc nội dung PDF...', 10)

        // A. pdf.js extract text layer (nhanh, miễn phí — thử trước nếu PDF có lớp text)
        report('📄 Đọc text layer PDF...', 15)
        const { text, totalPages: tp } = await extractPdfText(buf.slice(0))
        rawText = text
        totalPages = tp

        const avgChars = rawText.length / Math.max(totalPages, 1)
        const hasWatermark = /tải\s+về\s+từ\s+(?:hệ\s+thống|vatm)|thông\s+tin\s+tải\s+về|phòng\s*nghiệp\s*vụ|da\.phongnv/i.test(rawText)
        const ratio = accentRatio(rawText)
        const isCorrupted = ratio < 0.08
        isScan = avgChars < 80 || hasWatermark || isCorrupted

        if (isScan) {
          // B. AI Vision đọc theo lô nhiều trang (Gemini → Groq) — ưu tiên trước Tesseract vì
          // chất lượng đọc số liệu/ngày tháng/tên cơ quan chính xác hơn nhiều.
          const reason = isCorrupted
            ? `PDF lỗi bảng mã CMap (chỉ ${(ratio * 100).toFixed(1)}% ký tự có dấu, văn bản thật ~16-19%)`
            : hasWatermark ? 'PDF watermark VATM' : `PDF scan (${totalPages} trang)`
          report(`👁️ ${reason} — AI Vision đọc văn bản...`, 25)
          const { text: visionText, failedCount, totalPgs } = await ocrWithAIVision(buf.slice(0), report, docId, existingOcrProgress)

          if (visionText.length > 100 && failedCount < totalPgs / 2) {
            rawText = visionText
            ocrSource = 'ai-vision'
            report(`✅ AI Vision đọc xong: ${(rawText.length / 1000).toFixed(0)}K ký tự` + (failedCount ? ` (${failedCount} trang phải dùng Tesseract dự phòng)` : ''), 55)
          } else {
            // C. AI Vision thất bại phần lớn → Tesseract OCR toàn bộ file (luôn thành công, chất lượng thấp hơn)
            report(`🔤 AI Vision không đọc được — chuyển sang Tesseract OCR...`, 25)
            rawText = await ocrWithTesseract(buf.slice(0), report, docId, existingOcrProgress)
            ocrSource = 'tesseract'
            report(`✅ Tesseract OCR xong: ${(rawText.length / 1000).toFixed(0)}K ký tự`, 55)
          }
        } else {
          ocrSource = 'pdfjs'
          report(`✅ Đọc text xong: ${totalPages} trang`, 50)
        }

      } else if (['doc', 'docx'].includes(ext)) {
        report('📄 Đọc Word...', 20)
        rawText = await extractWordText(buf, ext)
        ocrSource = 'docx'
      } else if (['xls', 'xlsx'].includes(ext)) {
        report('📊 Đọc XLSX...', 20)
        rawText = await extractXlsxText(buf)
        ocrSource = 'xlsx'
      } else if (ext === 'txt') {
        rawText = new TextDecoder('utf-8').decode(buf)
        ocrSource = 'txt'
      } else {
        throw new Error(`Định dạng .${ext} chưa hỗ trợ phân tích`)
      }

      if (!rawText || rawText.trim().length < 30) {
        throw new Error('Không đọc được nội dung. File có thể bị bảo vệ hoặc trống.')
      }

      // ── 3. AI tổng hợp → markdown ─────────────────────────────
      report('🧠 Phân tích nội dung...', 60)
      const { markdown, source: aiSource } = await analyzeWithAI(rawText, fileName || 'văn bản')

      if (aiSource === 'local') {
        report('📝 Định dạng tự động (Groq/Gemini không khả dụng)...', 80)
      } else {
        report(`✅ AI (${aiSource}) phân tích xong`, 80)
      }

      // ── 4. Lưu vào Firestore ───────────────────────────────────
      report('💾 Đang lưu kết quả...', 85)
      await setDoc(doc(db, 'documentMarkdown', docId), {
        markdown,
        rawText: rawText.slice(0, 100000),
        fileName: fileName || '',
        totalPages,
        charCount: markdown.length,
        isScan,
        ocrSource,
        aiSource,
        updatedAt: now,
      })

      const summaryMatch = markdown.match(/## Tổng quan\n([\s\S]*?)(?=\n##|$)/)
      const summary = summaryMatch ? summaryMatch[1].trim() : markdown.slice(0, 500)
      await setDoc(doc(db, 'documentMemory', docId), {
        summary,
        hasFullMarkdown: true,
        fileName: fileName || '',
        ocrSource,
        aiSource,
        analyzedAt: now,
      })

      setProgress(100)
      const sourceLabel = aiSource === 'local'
        ? '(Tesseract OCR + formatter tự động)'
        : `(OCR: ${ocrSource}, AI: ${aiSource})`
      report(`✅ Phân tích xong! ${sourceLabel}`, 100)

    } catch (e) {
      const msg = `❌ ${e.message}`
      setStatus(msg)
      if (onStatus) onStatus(msg)
      throw e
    }
  }

  const reset = () => { setStatus(''); setProgress(0) }

  return { startPipeline, status, progress, reset }
}