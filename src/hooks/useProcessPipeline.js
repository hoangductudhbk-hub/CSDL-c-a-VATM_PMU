// src/hooks/useProcessPipeline.js
// Pipeline: fileUrl → extract text/OCR → AI analysis → Firestore
//
// OCR chain (PDF scan, khi lớp text PDF không đọc được/có watermark):
//   1. AI Vision — Gemini trước, Groq sau (đọc từng trang, chất lượng cao)
//   2. Tesseract.js (chạy trong browser, KHÔNG cần API key, dự phòng cuối — luôn thành công)
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

const canvasToBase64 = (canvas) => canvas.toDataURL('image/jpeg', 0.85).split(',')[1]

// ─── Đọc 1 trang (ảnh base64) bằng AI Vision — Gemini trước, Groq sau ─────
const ocrPageWithVision = async (b64) => {
  const prompt = `Đọc toàn bộ nội dung trong ảnh trang văn bản tiếng Việt này, trả về dạng văn bản thuần.
Quy tắc:
- Giữ nguyên cấu trúc: tiêu đề, số điều/khoản, bảng biểu, chữ ký
- Bảng → markdown table
- Số liệu, ngày tháng, tên người/cơ quan: CHÉP CHÍNH XÁC từng chữ, không suy đoán
- KHÔNG thêm bình luận, KHÔNG thêm "Dưới đây là nội dung..."
- Chỉ trả về nội dung văn bản`

  // 1) Gemini Vision trước (không bị giới hạn deprecation như Groq Vision hiện tại)
  try {
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }],
        maxTokens: 4096,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.text && data.text.trim().length > 20) return data.text
    }
  } catch {}

  // 2) Groq Vision sau (Llama 4 Scout — ⚠️ Groq deprecate 27/6/2026, ngừng 17/7/2026)
  try {
    const res = await fetch('/api/groq-proxy', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        vision: true, maxTokens: 4096,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } },
          { type: 'text', text: prompt },
        ]}],
      }),
    })
    if (res.ok) {
      const data = await res.json()
      if (data.text && data.text.trim().length > 20) return data.text
    }
  } catch {}

  return null
}

// ─── OCR bằng AI Vision (Gemini→Groq), đọc từng trang — ưu tiên trước Tesseract ──
const ocrWithAIVision = async (buf, onStatus) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  const totalPgs = Math.min(pdf.numPages, 30) // giới hạn an toàn, tránh tốn quota cho file quá dài

  onStatus?.(`👁️ AI Vision đọc văn bản (${totalPgs} trang)...`)

  let allText = ''
  let failedCount = 0
  for (let i = 1; i <= totalPgs; i++) {
    onStatus?.(`👁️ AI Vision đọc trang ${i}/${totalPgs}...`)
    try {
      const page = await pdf.getPage(i)
      const canvas = await renderPageToCanvas(page, 1.5)
      const text = await ocrPageWithVision(canvasToBase64(canvas))
      if (text) { allText += text + '\n\n' } else { failedCount++ }
    } catch (e) {
      console.warn(`[AI Vision] trang ${i} lỗi:`, e.message)
      failedCount++
    }
  }
  return { text: allText.trim(), failedCount, totalPgs }
}

// ─── OCR bằng Tesseract.js (chạy trong browser, không cần API) ───────────
const ocrWithTesseract = async (buf, onStatus) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  const totalPgs = pdf.numPages

  onStatus?.(`🔤 Khởi động Tesseract OCR (${totalPgs} trang)...`)

  // Tạo worker Tesseract với tiếng Việt + tiếng Anh
  const worker = await createWorker(['vie', 'eng'], 1, {
    logger: m => {
      if (m.status === 'recognizing text' && onStatus) {
        const pct = Math.round((m.progress || 0) * 100)
        if (pct % 20 === 0) onStatus(`🔤 Đang nhận dạng... ${pct}%`)
      }
    },
  })

  let allText = ''
  for (let i = 1; i <= totalPgs; i++) {
    onStatus?.(`🔤 Tesseract OCR trang ${i}/${totalPgs}...`)
    try {
      const page = await pdf.getPage(i)
      const canvas = await renderPageToCanvas(page, 2.0)
      const { data: { text } } = await worker.recognize(canvas)
      allText += (text || '') + '\n'
    } catch (e) {
      console.warn(`[Tesseract] trang ${i} lỗi:`, e.message)
    }
  }

  await worker.terminate()
  return allText.trim()
}

// ─── Extract text từ DOCX ──────────────────────────────────────────────────
const extractDocxText = async (buf) => {
  await loadScript(
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',
    () => window.mammoth
  )
  return (await window.mammoth.extractRawText({ arrayBuffer: buf })).value
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
(các điểm chính, số liệu cụ thể)

## Nhân sự liên quan
(họ tên, chức vụ nếu có)

## Tài chính & Kỹ thuật
(số tiền, thông số kỹ thuật nếu có)

## Thời hạn & Yêu cầu
(deadline, điều kiện nếu có)

## Từ khóa
(5-15 từ khóa đặc trưng)

NỘI DUNG VĂN BẢN:
${text.slice(0, 14000)}`

// ─── AI phân tích: Groq proxy → Gemini proxy (key luôn ở server) ──────────
const analyzeWithAI = async (text, fileName) => {
  const prompt = buildPrompt(text, fileName)

  // 1. Groq qua /api/groq-proxy — key ở server
  try {
    const res = await fetch('/api/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }], maxTokens: 3000 }),
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
      body: JSON.stringify({ prompt, maxTokens: 3000 }),
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
      // Kiểm tra đã có markdown chưa
      if (!forceRestart) {
        const snap = await getDoc(doc(db, 'documentMarkdown', docId))
        if (snap.exists() && snap.data().markdown) {
          report('✅ Đã có dữ liệu phân tích')
          return
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
          markdown, rawText: rawText.slice(0, 50000),
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
        isScan = avgChars < 80 || hasWatermark

        if (isScan) {
          // B. AI Vision đọc từng trang (Gemini → Groq) — ưu tiên trước Tesseract vì
          // chất lượng đọc số liệu/ngày tháng/tên cơ quan chính xác hơn nhiều.
          const reason = hasWatermark ? 'PDF watermark VATM' : `PDF scan (${totalPages} trang)`
          report(`👁️ ${reason} — AI Vision đọc văn bản...`, 25)
          const { text: visionText, failedCount, totalPgs } = await ocrWithAIVision(buf.slice(0), report)

          if (visionText.length > 100 && failedCount < totalPgs / 2) {
            rawText = visionText
            ocrSource = 'ai-vision'
            report(`✅ AI Vision đọc xong: ${(rawText.length / 1000).toFixed(0)}K ký tự` + (failedCount ? ` (${failedCount} trang phải dùng Tesseract dự phòng)` : ''), 55)
          } else {
            // C. AI Vision thất bại phần lớn → Tesseract OCR toàn bộ file (luôn thành công, chất lượng thấp hơn)
            report(`🔤 AI Vision không đọc được — chuyển sang Tesseract OCR...`, 25)
            rawText = await ocrWithTesseract(buf.slice(0), report)
            ocrSource = 'tesseract'
            report(`✅ Tesseract OCR xong: ${(rawText.length / 1000).toFixed(0)}K ký tự`, 55)
          }
        } else {
          ocrSource = 'pdfjs'
          report(`✅ Đọc text xong: ${totalPages} trang`, 50)
        }

      } else if (['doc', 'docx'].includes(ext)) {
        report('📄 Đọc DOCX...', 20)
        rawText = await extractDocxText(buf)
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
      const { markdown, source: aiSource } = await analyzeWithAI(rawText, fileName || 'văn bản', groqKeys)

      if (aiSource === 'local') {
        report('📝 Định dạng tự động (Groq/Gemini không khả dụng)...', 80)
      } else {
        report(`✅ AI (${aiSource}) phân tích xong`, 80)
      }

      // ── 4. Lưu vào Firestore ───────────────────────────────────
      report('💾 Đang lưu kết quả...', 85)
      await setDoc(doc(db, 'documentMarkdown', docId), {
        markdown,
        rawText: rawText.slice(0, 50000),
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