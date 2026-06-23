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

// ─── OCR scan PDF bằng Groq Vision (tối đa 8 trang) ───────────────────────
const ocrScanPdf = async (buf, groqKey, onStatus) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  const maxOcr = Math.min(pdf.numPages, 8)
  let allText = ''
  for (let i = 1; i <= maxOcr; i++) {
    if (onStatus) onStatus(`🔍 OCR trang ${i}/${maxOcr}...`)
    const page = await pdf.getPage(i)
    const b64 = await renderPageToJpeg(page)
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
      if (res.ok) {
        const data = await res.json()
        allText += (data.choices?.[0]?.message?.content || '') + '\n'
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1200))
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
const analyzeWithAI = async (text, fileName, groqKeys) => {
  const prompt = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
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
${text.slice(0, 12000)}`

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
      if (res.status === 429) continue
      if (!res.ok) continue
      const data = await res.json()
      const result = data.choices?.[0]?.message?.content || ''
      if (result.length > 100) return result
    } catch { continue }
  }
  return null
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

      if (ext === 'pdf') {
        const { text, totalPages: tp } = await extractPdfText(buf.slice(0))
        rawText = text; totalPages = tp
        const avgChars = rawText.length / Math.max(totalPages, 1)
        isScan = avgChars < 80
        if (isScan) {
          report(`🔍 PDF scan (${totalPages} trang) — đang OCR...`, 30)
          rawText = await ocrScanPdf(buf.slice(0), groqKeys[0], report)
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
      const now = serverTimestamp()
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
