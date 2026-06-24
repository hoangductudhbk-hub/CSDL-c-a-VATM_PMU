// src/hooks/useProcessPipeline.js
// Pipeline: fileUrl → extract text/OCR → AI analysis → Firestore
//
// OCR chain (PDF scan):
//   1. Mistral OCR qua server (chất lượng cao, 125+ trang)
//   2. Tesseract.js (chạy trong browser, KHÔNG cần API key, miễn phí vĩnh viễn)
//
// AI chain (phân tích):
//   1. Groq (nếu có key hợp lệ)
//   2. Gemini proxy (nếu key hợp lệ trên Vercel)
//   3. Basic formatter (tự động format text thành markdown, KHÔNG cần AI)
//
// → Pipeline KHÔNG bao giờ fail hoàn toàn kể cả khi mọi API đều lỗi

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

// ─── AI phân tích: Groq → Gemini proxy → basic formatter ──────────────────
const analyzeWithAI = async (text, fileName, groqKeys) => {
  const prompt = buildPrompt(text, fileName)

  // 1. Thử Groq
  for (const key of groqKeys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 3000,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }]
        })
      })
      if (res.status === 429 || res.status === 401) continue
      if (!res.ok) continue
      const data = await res.json()
      const result = data.choices?.[0]?.message?.content || ''
      if (result.length > 100) return { markdown: result, source: 'groq' }
    } catch { continue }
  }

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

  const getGroqKeys = () => {
    const fromEnv = [
      import.meta.env.VITE_GROQ_API_KEY,
      import.meta.env.VITE_GROQ_API_KEY_2,
      import.meta.env.VITE_GROQ_API_KEY_3,
    ].filter(Boolean)
    if (fromEnv.length) return fromEnv
    return (localStorage.getItem('groq_key') || '')
      .split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  }

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

      const groqKeys = getGroqKeys()  // có thể rỗng, không throw

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

        // A. Mistral OCR qua server (chất lượng tốt nhất)
        report('🤖 Thử Mistral OCR (server)...', 15)
        let mistralDone = false
        try {
          const mRes = await fetch('/api/ocr-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileUrl, fileName: fileName || '' }),
          })
          if (mRes.ok) {
            const mData = await mRes.json()
            if (mData.ok && mData.markdown?.length > 200) {
              rawText = mData.markdown
              totalPages = mData.pages || 1
              isScan = true
              ocrSource = mData.engine || 'mistral'
              mistralDone = true
              report(`✅ OCR xong: ${totalPages} trang (${ocrSource})`, 50)
            }
          }
        } catch (e) {
          console.warn('[pipeline] Mistral OCR lỗi:', e.message)
        }

        if (!mistralDone) {
          // B. pdf.js extract text layer
          report('📄 Đọc text layer PDF...', 20)
          const { text, totalPages: tp } = await extractPdfText(buf.slice(0))
          rawText = text
          totalPages = tp

          const avgChars = rawText.length / Math.max(totalPages, 1)
          const hasWatermark = /tải\s+về\s+từ\s+(?:hệ\s+thống|vatm)|thông\s+tin\s+tải\s+về|phòng\s*nghiệp\s*vụ|da\.phongnv/i.test(rawText)
          isScan = avgChars < 80 || hasWatermark

          if (isScan) {
            // C. Tesseract.js OCR — chạy 100% trong browser, không cần API
            const reason = hasWatermark ? 'PDF watermark VATM' : `PDF scan (${totalPages} trang)`
            report(`🔤 ${reason} — Tesseract.js OCR...`, 25)
            rawText = await ocrWithTesseract(buf.slice(0), report)
            ocrSource = 'tesseract'
            report(`✅ Tesseract OCR xong: ${(rawText.length / 1000).toFixed(0)}K ký tự`, 55)
          } else {
            ocrSource = 'pdfjs'
            report(`✅ Đọc text xong: ${totalPages} trang`, 50)
          }
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
