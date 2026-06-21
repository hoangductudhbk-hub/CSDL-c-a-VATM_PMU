// src/hooks/useProcessPipeline.js
// Pipeline OCR hoàn toàn client-side:
//   Tải PDF → pdfjs render từng trang → Groq Vision OCR → Firestore
// Không cần server-side OCR, không cần Mistral key.

import { useState, useRef } from 'react'
import {
  doc, setDoc, updateDoc, addDoc, collection, getDoc, serverTimestamp
} from 'firebase/firestore'
import { db } from '../firebase'
import { analyzeFullDocument } from './useAI'

// ── Firestore refs ────────────────────────────────────────────────
const jobRef   = (id) => doc(db, 'processingJobs', id)
const chunkCol = ()   => collection(db, 'documentChunks')
const mdCol    = ()   => collection(db, 'documentMarkdown')
const memRef   = (id) => doc(db, 'documentMemory', id)
const docRef   = (id) => doc(db, 'documents', id)

// ── Load pdfjs từ CDN (1 lần) ────────────────────────────────────
const loadPdfjs = () => new Promise((resolve, reject) => {
  if (window.pdfjsLib) { resolve(window.pdfjsLib); return }
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    resolve(window.pdfjsLib)
  }
  s.onerror = reject
  document.head.appendChild(s)
})

// ── Tải PDF buffer qua proxy ──────────────────────────────────────
const fetchPdfBuffer = async (fileUrl) => {
  const proxyUrl = `/api/read-file?url=${encodeURIComponent(fileUrl)}`
  const res = await fetch(proxyUrl)
  if (!res.ok) throw new Error(`Không tải được PDF: HTTP ${res.status}`)
  return await res.arrayBuffer()
}

// ── Render 1 trang PDF → base64 JPEG ─────────────────────────────
const renderPageToBase64 = async (pdfDoc, pageNum, scale = 1.5) => {
  const page = await pdfDoc.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width  = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')
  await page.render({ canvasContext: ctx, viewport }).promise
  return canvas.toDataURL('image/jpeg', 0.85).replace(/^data:image\/jpeg;base64,/, '')
}

// ── Extract text từ 1 trang (text-based PDF) ─────────────────────
const extractPageText = async (pdfDoc, pageNum) => {
  try {
    const page = await pdfDoc.getPage(pageNum)
    const content = await page.getTextContent()
    return content.items.map(i => i.str).join(' ').trim()
  } catch { return '' }
}

// ── Kiểm tra text có phải tiếng Việt thật không ─────────────────
const isRealText = (text) => {
  if (!text || text.length < 50) return false
  const vnChars = (text.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []).length
  return vnChars > 5 || text.length > 200
}

// ── Groq Vision OCR 1 ảnh ────────────────────────────────────────
const groqVisionOCR = async (base64Img, pageNum, fileName, groqKeys) => {
  const prompt = `Đây là ảnh scan trang ${pageNum} của văn bản hành chính Việt Nam "${fileName}".
Hãy trích xuất TOÀN BỘ nội dung: số hiệu, ngày tháng, tên người, số liệu, nội dung điều khoản, bảng biểu.
Trả về dưới dạng Markdown, bắt đầu bằng "## Trang ${pageNum}". Giữ nguyên 100%, không tóm tắt.`

  for (const key of groqKeys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'meta-llama/llama-4-scout-17b-16e-instruct',
          max_tokens: 2000,
          temperature: 0.05,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Img}` } },
              { type: 'text', text: prompt }
            ]
          }]
        })
      })
      if (!res.ok) { if (res.status === 429) continue; continue }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content || ''
      if (text.length > 30) return text
    } catch { continue }
  }
  return null
}

// ── Groq text format (text-based PDF) ───────────────────────────
const groqFormatText = async (rawText, pageNum, fileName, groqKeys) => {
  const prompt = `Làm sạch và định dạng Markdown đoạn text sau từ trang ${pageNum} của "${fileName}".
Giữ nguyên 100% nội dung, bắt đầu bằng "## Trang ${pageNum}":
---
${rawText.slice(0, 3000)}
---`

  for (const key of groqKeys) {
    try {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1500,
          temperature: 0.1,
          messages: [{ role: 'user', content: prompt }]
        })
      })
      if (!res.ok) { if (res.status === 429) continue; continue }
      const data = await res.json()
      const text = data.choices?.[0]?.message?.content || ''
      if (text.length > 30) return text
    } catch { continue }
  }
  return `## Trang ${pageNum}\n\n${rawText}`
}

// ── Hook chính ───────────────────────────────────────────────────
export function useProcessPipeline() {
  const [status,   setStatus]   = useState('')
  const [progress, setProgress] = useState(0)
  const [stage,    setStage]    = useState('idle')
  const abortRef = useRef(false)

  const reset = () => {
    abortRef.current = false
    setStatus(''); setProgress(0); setStage('idle')
  }

  const startPipeline = async ({ docId, fileUrl, fileName, onStatus }) => {
    abortRef.current = false

    const notify = (msg, pct) => {
      setStatus(msg)
      if (pct != null) setProgress(pct)
      if (onStatus) onStatus(msg)
      console.log('[pipeline]', msg)
    }

    // Lấy Groq keys từ env
    const groqKeys = [
      import.meta.env.VITE_GROQ_API_KEY,
      import.meta.env.VITE_GROQ_API_KEY_2,
      import.meta.env.VITE_GROQ_API_KEY_3,
    ].filter(Boolean)

    if (!groqKeys.length) {
      notify('❌ Chưa có VITE_GROQ_API_KEY trong Vercel env')
      return { ok: false, error: 'no_groq_key' }
    }

    try {
      // ── 0. Kiểm tra đã chạy xong chưa ──────────────────────────
      const existingJob = await getDoc(jobRef(docId))
      if (existingJob.exists() && existingJob.data().stage === 'done') {
        notify('✅ Pipeline đã chạy xong trước đó', 100)
        setStage('done')
        return { ok: true, resumed: true }
      }

      // ── 1. Tải PDF ───────────────────────────────────────────────
      notify('📥 Đang tải PDF...', 5)
      const pdfBuffer = await fetchPdfBuffer(fileUrl)

      // ── 2. Load pdfjs ────────────────────────────────────────────
      notify('🔧 Khởi tạo PDF engine...', 8)
      const pdfjs = await loadPdfjs()
      const pdfDoc = await pdfjs.getDocument({ data: pdfBuffer }).promise
      const totalPages = pdfDoc.numPages
      notify(`📄 PDF có ${totalPages} trang`, 10)

      // ── 3. Tạo job trong Firestore ───────────────────────────────
      await setDoc(jobRef(docId), {
        docId, fileUrl, fileName: fileName || '',
        totalPages, stage: 'extract',
        batchesDone: 0,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }, { merge: true })
      setStage('extract')

      // ── 4. OCR từng trang ────────────────────────────────────────
      const pageTexts = [] // [{pageNum, text}]
      const PAGES_PER_BATCH = 5 // nhóm trang để lưu Firestore

      for (let p = 1; p <= totalPages; p++) {
        if (abortRef.current) {
          notify('⏸ Pipeline bị dừng')
          return { ok: false, aborted: true }
        }

        const pct = 10 + Math.round((p / totalPages) * 60)
        notify(`🔍 Đọc trang ${p}/${totalPages}...`, pct)

        let pageText = ''

        // Thử text extraction trước
        const rawText = await extractPageText(pdfDoc, p)
        if (isRealText(rawText)) {
          // Text-based PDF page
          pageText = await groqFormatText(rawText, p, fileName || 'document', groqKeys)
        } else {
          // Scan page → Groq Vision
          try {
            const base64Img = await renderPageToBase64(pdfDoc, p)
            const ocrText = await groqVisionOCR(base64Img, p, fileName || 'document', groqKeys)
            pageText = ocrText || `## Trang ${p}\n\n[Không đọc được trang này]`
          } catch (e) {
            pageText = `## Trang ${p}\n\n[Lỗi render: ${e.message}]`
          }
        }

        pageTexts.push({ pageNum: p, text: pageText })

        // Lưu chunk sau mỗi PAGES_PER_BATCH trang
        if (p % PAGES_PER_BATCH === 0 || p === totalPages) {
          const batchStart = Math.floor((p - 1) / PAGES_PER_BATCH) * PAGES_PER_BATCH + 1
          const batchEnd   = p
          const batchText  = pageTexts
            .filter(x => x.pageNum >= batchStart && x.pageNum <= batchEnd)
            .map(x => x.text)
            .join('\n\n')

          if (batchText.length > 50) {
            try {
              await addDoc(chunkCol(), {
                docId,
                fileName: fileName || '',
                fromPage: batchStart,
                toPage: batchEnd,
                chunkIndex: Math.floor((p - 1) / PAGES_PER_BATCH),
                text: batchText,
                createdAt: serverTimestamp(),
              })
            } catch (e) {
              console.warn('[pipeline] Lưu chunk lỗi:', e.message)
            }
          }

          try {
            await updateDoc(jobRef(docId), {
              batchesDone: Math.floor(p / PAGES_PER_BATCH),
              updatedAt: serverTimestamp(),
            })
          } catch {}
        }

        // Delay tránh rate limit Groq (500ms/trang)
        if (p < totalPages) await new Promise(r => setTimeout(r, 500))
      }

      // ── 5. Gộp markdown ──────────────────────────────────────────
      notify('📝 Gộp nội dung toàn bộ...', 72)
      const fullMarkdown = pageTexts
        .sort((a, b) => a.pageNum - b.pageNum)
        .map(x => x.text)
        .join('\n\n')

      let markdownRef = null
      if (fullMarkdown.length > 50) {
        try {
          const mdDoc = await addDoc(mdCol(), {
            docId,
            fileName: fileName || '',
            markdown: fullMarkdown,
            charCount: fullMarkdown.length,
            source: 'pipeline-client',
            createdAt: serverTimestamp(),
          })
          markdownRef = mdDoc.id
          await updateDoc(docRef(docId), {
            markdownRef,
            extractedText: fullMarkdown.slice(0, 100000),
            updatedAt: serverTimestamp(),
          }).catch(() => {})
        } catch (e) {
          console.warn('[pipeline] Lưu markdown lỗi:', e.message)
        }
      }

      // ── 6. Tạo bộ nhớ AI ────────────────────────────────────────
      setStage('memory')
      await updateDoc(jobRef(docId), { stage: 'memory', updatedAt: serverTimestamp() }).catch(() => {})
      notify('🧠 Phân tích sâu tạo bộ nhớ AI...', 80)

      let memoryOk = false
      if (fullMarkdown.length > 100) {
        try {
          const rawResult = await analyzeFullDocument(
            fullMarkdown,
            fileName || docId,
            (step) => notify(`🧠 ${step}`)
          )
          if (rawResult) {
            const parseJ = (s) => {
              try {
                const m = s.match(/\{[\s\S]*\}/)
                return JSON.parse(m ? m[0] : s.replace(/```json|```/g, '').trim())
              } catch { return null }
            }
            const parsed = parseJ(rawResult)
            if (parsed) {
              await setDoc(memRef(docId), {
                ...parsed,
                fileName: fileName || docId,
                readChars: fullMarkdown.length,
                source: 'pipeline-client',
                analyzedAt: serverTimestamp(),
              })
              memoryOk = true
              notify('✅ Bộ nhớ AI tạo xong!', 95)
            }
          }
        } catch (e) {
          console.warn('[pipeline] Memory lỗi:', e.message)
          notify('⚠️ Bộ nhớ AI thất bại: ' + e.message)
        }
      }

      // ── 7. Hoàn thành ────────────────────────────────────────────
      await setDoc(jobRef(docId), {
        stage: 'done', markdownRef, memoryOk,
        doneAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }, { merge: true })

      setStage('done')
      notify(`✅ Hoàn tất! Đã đọc ${totalPages} trang, ${fullMarkdown.length.toLocaleString()} ký tự`, 100)
      return { ok: true, markdownRef, memoryOk }

    } catch (e) {
      console.error('[pipeline] Lỗi:', e)
      setStage('error')
      notify('❌ Lỗi pipeline: ' + e.message)
      await updateDoc(jobRef(docId), {
        stage: 'error', errorMessage: e.message, updatedAt: serverTimestamp(),
      }).catch(() => {})
      return { ok: false, error: e.message }
    }
  }

  const abort = () => { abortRef.current = true }
  return { startPipeline, abort, reset, status, progress, stage }
}
