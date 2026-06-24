// src/hooks/useProcessPipeline.js
// Pipeline đơn giản: fileUrl → extract text → AI → markdown → Firestore
// Không ABBYY, không OCR.space, không server-side OCR, không job queue.
//
// Luồng:
//   1. Fetch file từ Cloudinary URL
//   2. Extract text (pdf.js / mammoth / sheetjs) — client-side, free
//   3. Nếu PDF scan (ít text) → Groq Vision vài trang đầu
//   4. AI tổng hợp → markdown
//   5. Lưu documentMarkdown + documentMemory vào Firestore

import { useState } from 'react'
import { doc, setDoc, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

// ─── Helpers load thư viện từ CDN ──────────────────────────────────────────
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

// ─── Extract text từ PDF (text layer) ──────────────────────────────────────
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

// ─── Render trang PDF thành JPEG base64 (cho scan PDF) ─────────────────────
const renderPageToJpeg = async (page) => {
  const viewport = page.getViewport({ scale: 1.5 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width; canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  try { await page.render({ canvasContext: ctx, viewport }).promise } catch {}
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1]
}

// ─── OCR scan PDF bằng Groq Vision → fallback Gemini Vision ───────────────
const ocrScanPdf = async (buf, groqKey, onStatus) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  const maxOcr = Math.min(pdf.numPages, 10)
  let allText = ''
  let groqWorking = !!groqKey  // nếu không có key → dùng Gemini ngay

  for (let i = 1; i <= maxOcr; i++) {
    if (onStatus) onStatus(`🔍 OCR trang ${i}/${maxOcr}...`)
    const page = await pdf.getPage(i)
    const b64 = await renderPageToJpeg(page)
    let pageText = ''

    // Thử Groq Vision trước
    if (groqWorking && groqKey) {
      try {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
          body: JSON.stringify({
            model: 'meta-llama/llama-4-scout-17b-16e-instruct',
            max_tokens: 2000,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: 'Đọc toàn bộ văn bản trong ảnh này. Trả về đúng text, giữ nguyên số liệu và tên.' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
              ]
            }]
          })
        })
        if (res.status === 401 || res.status === 403) {
          groqWorking = false  // key hết hạn → chuyển hẳn sang Gemini
        } else if (res.ok) {
          const data = await res.json()
          pageText = data.choices?.[0]?.message?.content || ''
        }
        if (pageText) { allText += pageText + '\n'; await new Promise(r => setTimeout(r, 1200)); continue }
      } catch {}
    }

    // Fallback: Gemini Vision qua proxy server
    if (!pageText) {
      if (onStatus) onStatus(`🔍 OCR trang ${i}/${maxOcr} (Gemini)...`)
      pageText = await ocrPageWithGemini(b64, i)
      allText += pageText + '\n'
      await new Promise(r => setTimeout(r, 500))
    }
  }
  return allText
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

// ─── AI tổng hợp text → markdown ──────────────────────────────────────────
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

// Thử Groq → nếu 401/fail toàn bộ → fallback Gemini proxy server-side
const analyzeWithAI = async (text, fileName, groqKeys) => {
  const prompt = buildPrompt(text, fileName)

  // 1. Thử Groq trước
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
      if (result.length > 100) return result
    } catch { continue }
  }

  // 2. Groq thất bại → thử Gemini qua proxy server (không bị CORS, key server-side)
  try {
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens: 3000 }),
    })
    if (res.ok) {
      const data = await res.json()
      const result = data.text || ''
      if (result.length > 100) return result
    }
  } catch {}

  return null
}

// ─── OCR scan PDF bằng Groq Vision → fallback Gemini Vision ───────────────
const ocrPageWithGemini = async (b64, pageNum) => {
  try {
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [
          { text: `Đọc toàn bộ văn bản trong trang ${pageNum} này. Trả về đúng text, giữ nguyên số liệu và tên.` },
          { inlineData: { mimeType: 'image/jpeg', data: b64 } }
        ],
        maxTokens: 2000,
      }),
    })
    if (res.ok) {
      const data = await res.json()
      return data.text || ''
    }
  } catch {}
  return ''
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
      // Kiểm tra đã có markdown chưa (bỏ qua nếu forceRestart)
      if (!forceRestart) {
        const snap = await getDoc(doc(db, 'documentMarkdown', docId))
        if (snap.exists() && snap.data().markdown) {
          report('✅ Đã có dữ liệu phân tích')
          return
        }
      }

      const groqKeys = getGroqKeys()
      if (!groqKeys.length) throw new Error('Chưa có Groq API key. Vào ⚙️ cài đặt key.')

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
      report('📄 Đang đọc nội dung...', 20)

      // ── 2. Extract text theo loại file ────────────────────────
      const ext = (fileName || '').split('.').pop().toLowerCase()
      let rawText = ''
      let totalPages = 1
      let isScan = false
      const now = serverTimestamp()

      // ── Đường tắt: .md và .csv → lưu thẳng vào memory, không qua AI ──
      if (['md', 'csv'].includes(ext)) {
        report(`📋 File ${ext.toUpperCase()} — lưu thẳng vào bộ nhớ...`, 50)
        rawText = new TextDecoder('utf-8').decode(buf)
        if (!rawText.trim()) throw new Error('File rỗng.')

        // Với CSV, chuyển thành bảng markdown đẹp hơn
        let markdown = rawText
        if (ext === 'csv') {
          const lines = rawText.trim().split('\n').filter(Boolean)
          if (lines.length > 0) {
            const header = lines[0]
            const cols = header.split(',').length
            const separator = Array(cols).fill('---').join(' | ')
            markdown = lines.map((l, i) => `| ${l.replace(/,/g, ' | ')} |`)
              .join('\n')
            markdown = `# ${fileName}\n\n` +
              lines.slice(0, 1).map(l => `| ${l.replace(/,/g, ' | ')} |`).join('\n') + '\n' +
              `| ${separator} |\n` +
              lines.slice(1).map(l => `| ${l.replace(/,/g, ' | ')} |`).join('\n')
          }
        }

        report('💾 Đang lưu...', 85)
        await setDoc(doc(db, 'documentMarkdown', docId), {
          markdown,
          rawText: rawText.slice(0, 50000),
          fileName: fileName || '',
          totalPages: 1,
          charCount: markdown.length,
          isScan: false,
          source: ext,   // đánh dấu nguồn gốc
          updatedAt: now,
        })
        const summary = rawText.slice(0, 500)
        await setDoc(doc(db, 'documentMemory', docId), {
          summary,
          hasFullMarkdown: true,
          fileName: fileName || '',
          source: ext,
          analyzedAt: now,
        })
        setProgress(100)
        report(`✅ Đã lưu ${ext.toUpperCase()} vào bộ nhớ!`, 100)
        return
      }

      if (ext === 'pdf') {
        // ── A. Mistral OCR qua server (1 call, chất lượng cao, hỗ trợ 125+ trang) ──
        report('🤖 Đang OCR toàn bộ PDF (Mistral)...', 15)
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
              mistralDone = true
              report(`✅ OCR xong: ${totalPages} trang, ${(rawText.length/1000).toFixed(0)}K ký tự (${mData.engine})`, 55)
            }
          }
        } catch (e) {
          console.warn('[pipeline] Mistral OCR lỗi:', e.message)
        }

        // ── B. Fallback: pdf.js extract, detect watermark, Vision OCR ──
        if (!mistralDone) {
          report('📄 Thử đọc text layer PDF...', 20)
          const { text, totalPages: tp } = await extractPdfText(buf.slice(0))
          rawText = text; totalPages = tp
          const avgChars = rawText.length / Math.max(totalPages, 1)
          const hasWatermark = /tải\s+về\s+từ\s+(?:hệ\s+thống|vatm)|thông\s+tin\s+tải\s+về|phòng\s*nghiệp\s*vụ|da\.phongnv/i.test(rawText)
          isScan = avgChars < 80 || hasWatermark
          if (isScan) {
            const reason = hasWatermark ? 'PDF watermark hệ thống' : `PDF scan (${totalPages} trang)`
            report(`🔍 ${reason} — đang Vision OCR...`, 30)
            rawText = await ocrScanPdf(buf.slice(0), groqKeys[0], report)
          }
        }
      } else if (['doc', 'docx'].includes(ext)) {
        rawText = await extractDocxText(buf)
      } else if (['xls', 'xlsx'].includes(ext)) {
        rawText = await extractXlsxText(buf)
      } else if (ext === 'txt') {
        rawText = new TextDecoder('utf-8').decode(buf)
      } else {
        throw new Error(`Định dạng .${ext} chưa hỗ trợ phân tích`)
      }

      if (!rawText || rawText.trim().length < 50) {
        throw new Error('Không đọc được nội dung. File có thể bị bảo vệ hoặc trống.')
      }
      report('🤖 AI đang phân tích...', 60)

      // ── 3. AI tổng hợp → markdown ─────────────────────────────
      const markdown = await analyzeWithAI(rawText, fileName || 'văn bản', groqKeys)
      if (!markdown) throw new Error('AI không phản hồi. Kiểm tra API key hoặc thử lại.')

      report('💾 Đang lưu kết quả...', 85)

      // ── 4. Lưu vào Firestore ───────────────────────────────────
      await setDoc(doc(db, 'documentMarkdown', docId), {
        markdown,
        rawText: rawText.slice(0, 50000),
        fileName: fileName || '',
        totalPages,
        charCount: markdown.length,
        isScan,
        updatedAt: now,
      })

      // Memory: tóm tắt ngắn để chat nhanh
      const summaryMatch = markdown.match(/## Tổng quan\n([\s\S]*?)(?=\n##|$)/)
      const summary = summaryMatch ? summaryMatch[1].trim() : markdown.slice(0, 500)
      await setDoc(doc(db, 'documentMemory', docId), {
        summary,
        hasFullMarkdown: true,
        fileName: fileName || '',
        analyzedAt: now,
      })

      setProgress(100)
      report('✅ Phân tích xong!', 100)

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
