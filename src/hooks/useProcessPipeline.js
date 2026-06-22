// src/hooks/useProcessPipeline.js
// Pipeline chuyển đổi văn bản → Markdown → AI Memory
//
// Luồng theo loại file:
//   PDF text  → Server (pdf-parse + Groq format)    via api/process-batch
//   PDF scan  → Client render pdfjs → api/ocr-page  (loại bỏ mupdf trên server!)
//   Word docx → Client mammoth → markdown
//   Excel xlsx→ Client SheetJS → markdown table/CSV
//
// Tất cả kết quả lưu vào documentMarkdown/{docId} (dùng docId làm key, không random)

import { useState, useRef } from 'react'
import { doc, setDoc, getDoc, deleteDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { analyzeFullDocument } from './useAI'

// ─── Hằng số ───────────────────────────────────────────────────────────────
const PAGE_BATCH   = 8      // số trang/lô gửi server (text PDF path)
const PAUSE_MS     = 1200   // nghỉ giữa các lô để tránh rate-limit
const OCR_PAUSE_MS = 1500   // nghỉ giữa các trang khi OCR scan PDF
const SCAN_THRESHOLD = 80   // avg chars/page dưới mức này → coi là scan PDF
const jobRef = (id) => doc(db, 'processingJobs', id)

// ─── Load pdfjs từ CDN (dùng lại window.pdfjsLib nếu đã load) ──────────────
const loadPdfJs = () => new Promise((res, rej) => {
  if (window.pdfjsLib) { res(window.pdfjsLib); return }
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload = () => {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
    res(window.pdfjsLib)
  }
  s.onerror = () => rej(new Error('Không load được pdfjs'))
  document.head.appendChild(s)
})

// ─── Render trang PDF thành PNG base64 bằng browser canvas ─────────────────
const renderPageToBase64 = async (pdfDoc, pageNum) => {
  const page = await pdfDoc.getPage(pageNum)
  const viewport = page.getViewport({ scale: 2.0 })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
  // Trả về phần base64 sau "data:image/png;base64,"
  return canvas.toDataURL('image/png').split(',')[1]
}

// ─── Kiểm tra PDF text hay scan ─────────────────────────────────────────────
const detectScanPdf = async (pdfDoc) => {
  const total = pdfDoc.numPages
  const checkPages = Math.min(total, 5)
  let totalChars = 0
  for (let i = 1; i <= checkPages; i++) {
    const page = await pdfDoc.getPage(i)
    const content = await page.getTextContent()
    totalChars += content.items.map(x => x.str).join('').length
  }
  const avgChars = totalChars / checkPages
  return avgChars < SCAN_THRESHOLD // scan nếu ít chữ
}

// ─── OCR scan PDF: browser render → Groq Vision TRỰC TIẾP (không qua Vercel) ─
// Lý do bỏ /api/ocr-page: Vercel serverless body limit ~1MB, ảnh JPEG base64
// 1 trang A4 ≈ 300–700KB → dễ vượt ngưỡng → 502 Bad Gateway.
// Gọi thẳng Groq API từ browser: không giới hạn body, nhanh hơn 1 round-trip.
const ocrScanPdf = async (pdfDoc, fileName, notify) => {
  // Lấy Groq keys từ env (VITE_ exposed ở client) + localStorage
  const envKeys = [
    import.meta.env.VITE_GROQ_API_KEY,
    import.meta.env.VITE_GROQ_API_KEY_2,
    import.meta.env.VITE_GROQ_API_KEY_3,
  ].filter(Boolean)
  const lsKeys = (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  const allKeys = [...new Set([...envKeys, ...lsKeys])]
  if (!allKeys.length) throw new Error('Chưa cấu hình VITE_GROQ_API_KEY')

  const VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'
  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
  const total = pdfDoc.numPages
  const parts = []
  let keyIdx = 0

  for (let pageNum = 1; pageNum <= total; pageNum++) {
    notify(`📷 Groq Vision - OCR trang ${pageNum}/${total}...`, 10 + Math.round((pageNum / total) * 50))

    try {
      // Render trang: scale 1.5 + JPEG (nhỏ hơn PNG 60-70%, đủ chất cho OCR)
      const page = await pdfDoc.getPage(pageNum)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = viewport.width
      canvas.height = viewport.height
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise
      const base64 = canvas.toDataURL('image/jpeg', 0.85).split(',')[1]

      // Gọi Groq Vision trực tiếp — thử lần lượt các key nếu rate-limit
      let pageText = ''
      for (let attempt = 0; attempt < allKeys.length; attempt++) {
        const key = allKeys[(keyIdx + attempt) % allKeys.length]
        try {
          const resp = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: VISION_MODEL,
              max_tokens: 4096,
              temperature: 0,
              messages: [{
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}` } },
                  { type: 'text', text: `Đọc toàn bộ nội dung trang ${pageNum}/${total} của tài liệu "${fileName}". Trả về Markdown, giữ nguyên 100% số liệu/tên/ngày tháng. Bảng → markdown table. Không giải thích thêm.` },
                ],
              }],
            }),
          })
          if (resp.status === 429) {
            keyIdx = (keyIdx + 1) % allKeys.length
            await new Promise(r => setTimeout(r, 2500))
            continue
          }
          if (resp.ok) {
            const data = await resp.json()
            pageText = data.choices?.[0]?.message?.content?.trim() || ''
            if (pageText) break
          }
        } catch { continue }
      }

      parts.push(pageText
        ? `## Trang ${pageNum}\n\n${pageText}`
        : `## Trang ${pageNum}\n\n*(Không đọc được)*`)

    } catch (e) {
      parts.push(`## Trang ${pageNum}\n\n*(Lỗi: ${e.message})*`)
    }

    if (pageNum < total) await new Promise(r => setTimeout(r, OCR_PAUSE_MS))
  }

  return parts.join('\n\n---\n\n')
}

// ─── Convert Word (.docx) → markdown bằng mammoth ──────────────────────────
const convertWordToMd = async (arrayBuffer) => {
  const mammoth = await import('mammoth')
  const result = await mammoth.convertToMarkdown({ arrayBuffer })
  return result.value
}

// ─── Convert Excel (.xlsx/.xls) → markdown table ───────────────────────────
const convertExcelToMd = async (arrayBuffer) => {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(arrayBuffer, { type: 'array' })
  const parts = []
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName]
    const csv = XLSX.utils.sheet_to_csv(ws, { defval: '' })
    // Chuyển CSV sang markdown table
    const rows = csv.trim().split('\n').map(r => r.split(','))
    if (!rows.length) continue
    const header = '| ' + rows[0].join(' | ') + ' |'
    const divider = '| ' + rows[0].map(() => '---').join(' | ') + ' |'
    const body = rows.slice(1).map(r => '| ' + r.join(' | ') + ' |').join('\n')
    parts.push(`### Sheet: ${sheetName}\n\n${header}\n${divider}\n${body}`)
  }
  return parts.join('\n\n')
}

// ─── Download file về ArrayBuffer ──────────────────────────────────────────
const fetchBuffer = async (url) => {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Không tải được file: ${resp.status}`)
  return await resp.arrayBuffer()
}

// ═══════════════════════════════════════════════════════════════════════════
// Hook chính
// ═══════════════════════════════════════════════════════════════════════════
export function useProcessPipeline() {
  const [status,   setStatus]   = useState('')
  const [progress, setProgress] = useState(0)
  const [stage,    setStage]    = useState('idle')
  const abortRef = useRef(false)

  const reset = () => {
    abortRef.current = false
    setStatus(''); setProgress(0); setStage('idle')
  }
  const abort = () => { abortRef.current = true }

  const startPipeline = async ({ docId, fileUrl, fileName, onStatus, forceRestart = false }) => {
    abortRef.current = false
    const notify = (msg, pct) => {
      setStatus(msg)
      if (pct != null) setProgress(pct)
      if (onStatus) onStatus(msg)
    }

    try {
      // ── 0. forceRestart: xóa data cũ ────────────────────────────
      if (forceRestart) {
        notify('🗑️ Đang xóa dữ liệu cũ...', 2)
        await setDoc(jobRef(docId), {
          docId, stage: 'idle', batchesDone: 0, markdownParts: [],
          totalPages: null, nextFromPage: 1, updatedAt: serverTimestamp(),
        })
        try { await deleteDoc(doc(db, 'documentMemory', docId)) } catch {}
        try { await deleteDoc(doc(db, 'documentMarkdown', docId)) } catch {}
      } else {
        // Đã xong từ trước → skip
        const snap = await getDoc(jobRef(docId))
        if (snap.exists() && snap.data().stage === 'done') {
          notify('✅ Đã xử lý xong từ trước', 100)
          setStage('done')
          return { ok: true, resumed: true }
        }
      }

      setStage('extract')
      const ext = (fileName || '').split('.').pop().toLowerCase()

      let fullMarkdown = ''

      // ════════════════════════════════════════════════════════════
      // ĐƯỜNG 1: Word (.docx) — mammoth client-side
      // ════════════════════════════════════════════════════════════
      if (ext === 'docx') {
        notify('📄 Đang tải file Word...', 5)
        const buf = await fetchBuffer(fileUrl)
        notify('📝 Đang chuyển Word → Markdown...', 15)
        fullMarkdown = await convertWordToMd(buf)
        notify('✅ Chuyển đổi Word xong', 60)
      }

      // ════════════════════════════════════════════════════════════
      // ĐƯỜNG 2: Excel (.xlsx/.xls) — SheetJS client-side
      // ════════════════════════════════════════════════════════════
      else if (ext === 'xlsx' || ext === 'xls') {
        notify('📊 Đang tải file Excel...', 5)
        const buf = await fetchBuffer(fileUrl)
        notify('📝 Đang chuyển Excel → Markdown table...', 15)
        fullMarkdown = await convertExcelToMd(buf)
        notify('✅ Chuyển đổi Excel xong', 60)
      }

      // ════════════════════════════════════════════════════════════
      // ĐƯỜNG 3: PDF
      // Thứ tự ưu tiên:
      //   A. Mistral OCR (1 API call, toàn bộ file, markdown chất lượng cao)
      //   B. pdfjs extract (nếu PDF text, 0 token)
      //   C. Groq Vision page-by-page (nếu scan PDF, browser render)
      // ════════════════════════════════════════════════════════════
      else if (ext === 'pdf') {

        // ── A. Thử Mistral OCR / OCR.space trước (1 API call, nhanh nhất) ──
        notify('🤖 [Bước 1/3] Thử Mistral OCR / OCR.space...', 8)
        try {
          const mistralRes = await fetch('/api/ocr-document', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileUrl, fileName: fileName || '', docId }),
          })
          if (mistralRes.ok) {
            const mistralData = await mistralRes.json()
            if (mistralData.ok && mistralData.markdown?.length > 200) {
              fullMarkdown = mistralData.markdown
              const engineLabel = mistralData.engine === 'mistral' ? '🤖 Mistral OCR' : '🔵 OCR.space'
              notify(`✅ ${engineLabel}: ${mistralData.pages} trang, ${(mistralData.charCount/1000).toFixed(0)}K ký tự`, 60)
            }
          } else {
            const errData = await mistralRes.json().catch(() => ({}))
            console.warn('[pipeline] Mistral/OCR.space không khả dụng:', mistralRes.status)
            notify(`⚠️ Mistral+OCR.space không dùng được (${mistralRes.status}) → chuyển sang Groq Vision`, 9)
          }
        } catch (e) {
          console.warn('[pipeline] Mistral OCR exception:', e.message)
        }

        // ── B & C. Fallback: pdfjs detect → text extract hoặc Groq Vision ──
        if (!fullMarkdown) {
        notify('📥 Đang tải file PDF...', 5)
        const buf = await fetchBuffer(fileUrl)
        const lib = await loadPdfJs()
        const pdfDoc = await lib.getDocument({ data: new Uint8Array(buf) }).promise
        const totalPages = pdfDoc.numPages

        // ── B: PDF text ───────────────────────────────────────────
        notify('🔎 Đang phát hiện loại PDF...', 8)
        const isScan = await detectScanPdf(pdfDoc)

        if (isScan) {
          // ── C. PDF SCAN → Groq Vision trực tiếp từ browser ────────────────
          notify(`📷 PDF scan (${totalPages} trang) - đang OCR...`, 10)
          await setDoc(jobRef(docId), {
            docId, fileUrl, fileName: fileName || '',
            stage: 'extract', totalPages, updatedAt: serverTimestamp(),
          }, { merge: true })
          fullMarkdown = await ocrScanPdf(pdfDoc, fileName, notify)

        } else {
          // ── B. PDF TEXT → pdfjs extract text CLIENT-SIDE (không cần API) ──
          // Không dùng api/process-batch nữa: WASM crash trên Vercel, phức tạp.
          // pdfjs đã load rồi, extract text tại chỗ — nhanh, free, 0 token.
          notify(`📄 Đang đọc văn bản (${totalPages} trang)...`, 10)
          const parts = []
          for (let i = 1; i <= totalPages; i++) {
            const p = await pdfDoc.getPage(i)
            const content = await p.getTextContent()
            const pageText = content.items.map(x => x.str).join(' ').trim()
            if (pageText.length > 30) parts.push(`## Trang ${i}\n\n${pageText}`)
            notify(`📄 Đọc trang ${i}/${totalPages}...`, 10 + Math.round((i / totalPages) * 45))
          }
          fullMarkdown = parts.join('\n\n---\n\n')

          // Nếu text layer hỏng (watermark lặp / CMap lỗi) → fallback Groq Vision
          const accentCount = (fullMarkdown.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []).length
          const accentRatio = accentCount / Math.max(fullMarkdown.length, 1)
          if (fullMarkdown.length < 200 || accentRatio < 0.05) {
            notify('⚠️ Text layer hỏng → chuyển sang Groq Vision OCR...', 50)
            fullMarkdown = await ocrScanPdf(pdfDoc, fileName, notify)
          } else {
            notify('✅ Đã đọc văn bản thành công', 58)
          }
        }
        } // end if (!fullMarkdown) — fallback khi Mistral không khả dụng
      }

      // ════════════════════════════════════════════════════════════
      // ĐƯỜNG 4: File khác — thử server batch như cũ
      // ════════════════════════════════════════════════════════════
      else {
        notify('📥 Đang xử lý file...', 5)
        const initRes = await fetch('/api/process-document', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docId, fileUrl, fileName: fileName || '' }),
        })
        if (!initRes.ok) return { ok: false, error: 'Loại file không hỗ trợ' }
        const data = await initRes.json()
        fullMarkdown = data.text || ''
      }

      if (!fullMarkdown.trim()) {
        notify('⚠️ Không đọc được nội dung file')
        return { ok: false, error: 'empty_content' }
      }

      // ── Lưu markdown vào Firestore ────────────────────────────────
      notify('📝 Đang lưu nội dung...', 65)
      await setDoc(doc(db, 'documentMarkdown', docId), {
        fileName: fileName || '',
        markdown: fullMarkdown,
        charCount: fullMarkdown.length,
        updatedAt: serverTimestamp(),
      })

      // Cập nhật documents/{docId} — đánh dấu đã có markdown
      const docSnap = await getDoc(doc(db, 'documents', docId))
      await setDoc(doc(db, 'documents', docId), {
        ...(docSnap.exists() ? docSnap.data() : {}),
        hasMarkdown: true,
        extractedText: fullMarkdown.slice(0, 100000),
      })

      await setDoc(jobRef(docId), { stage: 'memory', updatedAt: serverTimestamp() }, { merge: true })
      setStage('memory')

      // ── Tổng hợp bộ nhớ AI (có retry + fallback nếu Groq rate-limit) ────────
      notify('🧠 Đang tổng hợp bộ nhớ AI...', 70)
      let memory = null
      // Thử tối đa 2 lần (lần 2 nghỉ 5s để tránh rate-limit sau OCR)
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) {
            notify('⏳ Chờ để tránh rate-limit Groq...', 72)
            await new Promise(r => setTimeout(r, 5000))
          }
          const memoryRaw = await analyzeFullDocument(fullMarkdown, fileName || '', (msg) => notify(msg, 85))
          if (memoryRaw) {
            try { memory = JSON.parse((memoryRaw.match(/\{[\s\S]*\}/) || [memoryRaw])[0]) }
            catch { memory = { summary: memoryRaw } }
            break
          }
        } catch (e) {
          console.warn('[pipeline] analyzeFullDocument lần', attempt + 1, 'thất bại:', e.message)
        }
      }

      // Fallback: nếu vẫn không tạo được memory → lưu placeholder để chat vẫn dùng được
      if (!memory) {
        memory = {
          summary: `Tài liệu đã được đọc (${fullMarkdown.length} ký tự). Nhấn "Hỏi đáp" để đặt câu hỏi về nội dung.`,
          keywords: [],
          documentType: 'unknown',
          fallback: true,
        }
        notify('⚠️ Bộ nhớ AI tạm thời — chat vẫn hoạt động bình thường', 90)
      }

      await setDoc(doc(db, 'documentMemory', docId), {
        ...memory,
        analyzedAt: serverTimestamp(),
      })
      await setDoc(jobRef(docId), { stage: 'done', updatedAt: serverTimestamp() }, { merge: true })
      setStage('done')

      notify('✅ Hoàn tất! Đã đọc và ghi nhớ toàn bộ tài liệu.', 100)
      return { ok: true }

    } catch (e) {
      notify(`❌ Lỗi: ${e.message}`)
      try { await setDoc(jobRef(docId), { stage: 'error', errorMessage: e.message }, { merge: true }) } catch {}
      return { ok: false, error: e.message }
    }
  }

  return { startPipeline, abort, reset, status, progress, stage }
}
