// src/hooks/useProcessPipeline.js
// ĐÃ VIẾT LẠI: bản cũ tự render từng trang PDF bằng pdf.js + gọi Groq Vision
// liên tục KHÔNG NGHỈ → dính rate limit 429 với file nhiều trang (vd 125 trang).
//
// Bản này: gọi api/process-batch.js (server) cho từng lô trang, CÓ NGHỈ giữa
// các lượt gọi, server tự lo việc đọc PDF (pdf-parse hoặc Gemini OCR cho scan).
// Bước tổng hợp bộ nhớ dùng lại analyzeFullDocument có sẵn trong useAI.js
// (đã sửa gọi Gemini qua proxy server, không gọi thẳng từ trình duyệt nữa).

import { useState, useRef } from 'react'
import { doc, setDoc, addDoc, collection, getDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'
import { analyzeFullDocument } from './useAI'

const jobRef = (id) => doc(db, 'processingJobs', id)
const PAGE_BATCH = 8     // số trang/lô — an toàn cho giới hạn 60s của Vercel
const PAUSE_MS   = 1200  // nghỉ giữa các lượt gọi — đây là phần bản cũ bị thiếu

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

  const startPipeline = async ({ docId, fileUrl, fileName, onStatus }) => {
    abortRef.current = false
    const notify = (msg, pct) => {
      setStatus(msg)
      if (pct != null) setProgress(pct)
      if (onStatus) onStatus(msg)
    }

    try {
      // ── 0. Đã chạy xong từ trước? (idempotent) ──────────────────
      const existingSnap = await getDoc(jobRef(docId))
      if (existingSnap.exists() && existingSnap.data().stage === 'done') {
        notify('✅ Đã xử lý xong từ trước', 100)
        setStage('done')
        return { ok: true, resumed: true }
      }
      // Nếu job cũ dở dang (ví dụ do lỗi/đóng tab giữa lúc chạy), tiếp tục
      // đúng từ lô còn thiếu — không làm lại từ đầu.
      const existing = existingSnap.exists() ? existingSnap.data() : null
      const markdownParts = existing?.markdownParts ? [...existing.markdownParts] : []
      let fromPage = existing?.nextFromPage || 1
      let batchIndex = existing?.batchesDone || 0
      let totalPages = existing?.totalPages || null

      // ── 1. Kiểm tra server đã cấu hình đủ key chưa ──────────────
      notify('📥 Đang khởi tạo...', 5)
      const initRes = await fetch('/api/process-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, fileUrl, fileName: fileName || '', totalPages }),
      })
      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({}))
        notify(`❌ Lỗi khởi tạo: ${err.error || initRes.status}`)
        return { ok: false, error: err.error || 'init_failed' }
      }

      await setDoc(jobRef(docId), {
        docId, fileUrl, fileName: fileName || '',
        stage: 'extract', batchesDone: batchIndex,
        markdownParts, totalPages,
        updatedAt: serverTimestamp(),
      }, { merge: true })
      setStage('extract')

      // ── 2. Đọc từng lô trang, CÓ NGHỈ giữa các lượt ─────────────
      let safety = 0
      while (!abortRef.current) {
        safety++
        if (safety > 200) { notify('⚠️ Quá nhiều lô, dừng lại'); return { ok: false, error: 'too_many_batches' } }
        if (totalPages && fromPage > totalPages) break // đã đọc hết

        const toPage = totalPages ? Math.min(fromPage + PAGE_BATCH - 1, totalPages) : fromPage + PAGE_BATCH - 1

        const pct = totalPages ? 10 + Math.round((fromPage / totalPages) * 50) : 10
        notify(`🔍 Đang đọc trang ${fromPage}–${toPage}${totalPages ? '/' + totalPages : ''}...`, pct)

        const res = await fetch('/api/process-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ docId, fileUrl, fileName: fileName || '', fromPage, toPage, batchIndex }),
        })

        if (res.status === 422) {
          // Lô này không OCR được — KHÔNG bỏ qua âm thầm, thử lại 1 lần sau khi nghỉ lâu hơn
          notify(`⏳ Trang ${fromPage}–${toPage} chưa đọc được, thử lại...`)
          await new Promise(r => setTimeout(r, 3000))
          continue // thử lại đúng lô này, không tăng fromPage/batchIndex
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}))
          notify(`❌ Lỗi đọc trang ${fromPage}–${toPage}: ${err.error || res.status}`)
          await setDoc(jobRef(docId), { stage: 'error', errorMessage: err.error || String(res.status) }, { merge: true })
          return { ok: false, error: err.error }
        }

        const data = await res.json()
        if (data.totalPages && !totalPages) totalPages = data.totalPages // học được tổng số trang từ lô đầu

        markdownParts.push(data.text || '')
        batchIndex++
        fromPage = toPage + 1

        await setDoc(jobRef(docId), {
          batchesDone: batchIndex, markdownParts, totalPages,
          nextFromPage: fromPage,
          updatedAt: serverTimestamp(),
        }, { merge: true })

        if (totalPages && fromPage > totalPages) break
        await new Promise(r => setTimeout(r, PAUSE_MS)) // ── nghỉ trước lượt gọi tiếp theo ──
      }

      if (abortRef.current) { notify('⏸ Đã dừng theo yêu cầu'); return { ok: false, aborted: true } }

      // ── 3. Ghép markdown, lưu vào documentMarkdown ──────────────
      notify('📝 Đang ghép nội dung...', 65)
      const fullMarkdown = markdownParts.join('\n\n')
      const mdRef = await addDoc(collection(db, 'documentMarkdown'), {
        fileName: fileName || '', markdown: fullMarkdown, charCount: fullMarkdown.length,
        createdAt: serverTimestamp(),
      })
      const docSnap = await getDoc(doc(db, 'documents', docId))
      await setDoc(doc(db, 'documents', docId), {
        ...(docSnap.exists() ? docSnap.data() : {}),
        markdownRef: mdRef.id,
        extractedText: fullMarkdown.slice(0, 100000),
      })

      await setDoc(jobRef(docId), { stage: 'memory', updatedAt: serverTimestamp() }, { merge: true })
      setStage('memory')

      // ── 4. Tổng hợp bộ nhớ — dùng lại logic chunking có sẵn ─────
      notify('🧠 Đang tổng hợp bộ nhớ AI...', 70)
      const memoryRaw = await analyzeFullDocument(fullMarkdown, fileName || '', (msg) => notify(msg, 85))
      let memory
      try { memory = JSON.parse((memoryRaw.match(/\{[\s\S]*\}/) || [memoryRaw])[0]) }
      catch { memory = { summary: memoryRaw } }

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
