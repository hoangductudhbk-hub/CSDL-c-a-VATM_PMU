// src/hooks/useProcessPipeline.js
// Pipeline tự động: upload xong → OCR từng lô trang → lưu Firestore → tạo bộ nhớ AI
//
// Flow:
//   startPipeline(params) →
//     POST /api/process-document  (tạo job metadata)
//     → tạo processingJobs/{docId} trong Firestore
//     → lặp POST /api/process-batch (10 trang/lần)
//     → lưu từng chunk vào documentChunks
//     → gộp toàn bộ markdown → lưu documentMarkdown
//     → analyzeDeepForMemory → lưu documentMemory
//     → cập nhật processingJobs stage:'done'

import { useState, useRef } from 'react'
import {
  doc, setDoc, updateDoc, addDoc, collection, getDoc, serverTimestamp
} from 'firebase/firestore'
import { db } from '../firebase'
import { analyzeFullDocument } from './useAI'

// ── Helpers Firestore ────────────────────────────────────────────
const jobRef  = (docId) => doc(db, 'processingJobs', docId)
const chunkCol = () => collection(db, 'documentChunks')
const mdCol    = () => collection(db, 'documentMarkdown')
const memRef  = (docId) => doc(db, 'documentMemory', docId)
const docRef  = (docId) => doc(db, 'documents', docId)

// ── Lấy số trang PDF bằng pdfjs (client-side) ───────────────────
const getPdfPageCount = async (fileUrl) => {
  try {
    if (!window.pdfjsLib) {
      await new Promise((res, rej) => {
        if (window.pdfjsLib) { res(); return }
        const s = document.createElement('script')
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
        s.onload = () => {
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
          res()
        }
        s.onerror = rej
        document.head.appendChild(s)
      })
    }
    // Fetch PDF qua api/read-file để tránh CORS
    const proxyUrl = `/api/read-file?url=${encodeURIComponent(fileUrl)}`
    const res = await fetch(proxyUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const buf = await res.arrayBuffer()
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise
    return pdf.numPages
  } catch (e) {
    console.warn('[pipeline] Không đọc được số trang:', e.message)
    return null
  }
}

// ── Hook chính ───────────────────────────────────────────────────
export function useProcessPipeline() {
  const [status,   setStatus]   = useState('')   // thông báo hiển thị
  const [progress, setProgress] = useState(0)    // 0–100
  const [stage,    setStage]    = useState('')   // 'idle'|'extract'|'memory'|'done'|'error'
  const abortRef = useRef(false)                 // set true để dừng sớm

  const reset = () => {
    abortRef.current = false
    setStatus(''); setProgress(0); setStage('idle')
  }

  // ── startPipeline ─────────────────────────────────────────────
  // Params: { docId, fileUrl, fileName, totalPages? }
  // Returns: { ok, markdownRef, memoryOk }
  const startPipeline = async ({ docId, fileUrl, fileName, totalPages: knownPages = null, onStatus }) => {
    abortRef.current = false
    const notify = (msg, pct) => {
      setStatus(msg)
      if (pct != null) setProgress(pct)
      if (onStatus) onStatus(msg)
    }

    try {
      // ── 0. Kiểm tra job cũ (resumable) ───────────────────────
      const existingJob = await getDoc(jobRef(docId))
      let jobData = existingJob.exists() ? existingJob.data() : null

      if (jobData?.stage === 'done') {
        notify('✅ Pipeline đã chạy xong trước đó', 100)
        setStage('done')
        return { ok: true, resumed: true }
      }

      // ── 1. Lấy số trang nếu chưa biết ────────────────────────
      let totalPages = knownPages || jobData?.totalPages || null
      if (!totalPages && fileUrl?.includes('raw.githubusercontent.com')) {
        notify('📄 Đang đọc số trang PDF...')
        totalPages = await getPdfPageCount(fileUrl)
      }

      // ── 2. Gọi api/process-document → lấy job metadata ───────
      notify('🚀 Khởi tạo pipeline xử lý...')
      const initRes = await fetch('/api/process-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, fileUrl, fileName, totalPages }),
      })
      if (!initRes.ok) {
        const err = await initRes.json()
        throw new Error(err.error || `process-document HTTP ${initRes.status}`)
      }
      const { pageBatch, totalBatches, jobData: initJobData } = await initRes.json()

      // ── 3. Tạo/cập nhật processingJobs trong Firestore ───────
      const batchesDoneSoFar = jobData?.batchesDone || 0
      const startBatch = batchesDoneSoFar  // resume từ đây

      const jobRecord = {
        docId,
        fileUrl,
        fileName: fileName || '',
        totalPages: totalPages || null,
        totalBatches: totalBatches || null,
        pageBatch,
        stage: 'extract',
        batchesDone: batchesDoneSoFar,
        createdAt: jobData?.createdAt || serverTimestamp(),
        updatedAt: serverTimestamp(),
      }
      await setDoc(jobRef(docId), jobRecord, { merge: true })
      setStage('extract')

      // ── 4. Lặp gọi api/process-batch ─────────────────────────
      const allChunks = [] // {fromPage, toPage, text, index}

      if (totalBatches) {
        for (let b = startBatch; b < totalBatches; b++) {
          if (abortRef.current) {
            notify('⏸ Pipeline bị dừng')
            return { ok: false, aborted: true }
          }

          const fromPage = b * pageBatch + 1
          const toPage   = totalPages ? Math.min((b + 1) * pageBatch, totalPages) : (b + 1) * pageBatch
          const pct = Math.round((b / totalBatches) * 70)

          notify(`🤖 OCR trang ${fromPage}–${toPage} (lô ${b + 1}/${totalBatches})...`, pct)

          let batchText = null
          let retries = 2

          while (retries > 0 && !batchText) {
            const batchRes = await fetch('/api/process-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ docId, fileUrl, fileName, fromPage, toPage, batchIndex: b }),
            })

            if (batchRes.status === 413) {
              // File quá lớn — dừng server-side, fallback về client
              const errData = await batchRes.json()
              notify(`⚠️ ${errData.error}`)
              return { ok: false, fallback: true, reason: 'file_too_large' }
            }

            if (batchRes.ok) {
              const data = await batchRes.json()
              batchText = data.text
            } else {
              retries--
              if (retries > 0) {
                notify(`⚠️ Lô ${b + 1} thất bại, thử lại sau 3s...`)
                await new Promise(r => setTimeout(r, 3000))
              }
            }
          }

          if (!batchText) {
            notify(`⚠️ Bỏ qua lô ${b + 1} (thất bại sau retry)`)
            allChunks.push({ fromPage, toPage, text: '', index: b })
          } else {
            allChunks.push({ fromPage, toPage, text: batchText, index: b })
          }

          // Lưu chunk vào Firestore ngay lập tức (không chờ hết)
          if (batchText) {
            try {
              await addDoc(chunkCol(), {
                docId,
                fileName: fileName || '',
                fromPage,
                toPage,
                chunkIndex: b,
                text: batchText,
                createdAt: serverTimestamp(),
              })
            } catch (e) {
              console.error('[pipeline] Lưu chunk lỗi:', e.code, e.message)
              notify(`⚠️ Firestore lỗi (chunk): ${e.code || e.message}`)
            }
          }

          // Cập nhật progress trong Firestore (resumable)
          try {
            await updateDoc(jobRef(docId), {
              batchesDone: b + 1,
              updatedAt: serverTimestamp(),
            })
          } catch (e) {
            console.error('[pipeline] Update job lỗi:', e.code, e.message)
          }

          // Delay nhỏ tránh rate limit
          if (b < totalBatches - 1) await new Promise(r => setTimeout(r, 800))
        }
      }

      notify('📝 Gộp markdown từ tất cả lô...', 75)

      // ── 5. Gộp chunks → lưu documentMarkdown ─────────────────
      const fullMarkdown = allChunks
        .filter(c => c.text)
        .sort((a, b) => a.index - b.index)
        .map(c => c.text)
        .join('\n\n')

      let markdownRef = null
      if (fullMarkdown.length > 50) {
        try {
          const mdDoc = await addDoc(mdCol(), {
            docId,
            fileName: fileName || '',
            markdown: fullMarkdown,
            charCount: fullMarkdown.length,
            source: 'pipeline',
            createdAt: serverTimestamp(),
          })
          markdownRef = mdDoc.id

          // Cập nhật document gốc với markdownRef
          try {
            await updateDoc(docRef(docId), {
              markdownRef,
              extractedText: fullMarkdown.slice(0, 100000),
              updatedAt: serverTimestamp(),
            })
          } catch (e) {
            console.warn('[pipeline] Cập nhật doc với markdownRef thất bại:', e.message)
          }
        } catch (e) {
          console.error('[pipeline] Lưu markdown thất bại:', e.code, e.message)
          notify(`⚠️ Firestore lỗi (markdown): ${e.code || e.message}`)
        }
      }

      // ── 6. Tạo bộ nhớ AI (documentMemory) ─────────────────────
      setStage('memory')
      await updateDoc(jobRef(docId), { stage: 'memory', updatedAt: serverTimestamp() })
      notify('🧠 Đang phân tích sâu để tạo bộ nhớ AI...', 80)

      let memoryOk = false
      if (fullMarkdown.length > 100) {
        try {
          const rawResult = await analyzeFullDocument(
            fullMarkdown,
            fileName || docId,
            (step) => notify(`🧠 ${step}`, null)
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
                source: 'pipeline',
                analyzedAt: serverTimestamp(),
              })
              memoryOk = true
              notify('✅ Bộ nhớ AI đã tạo xong!', 95)
            }
          }
        } catch (e) {
          console.warn('[pipeline] Tạo memory thất bại:', e.message)
          notify('⚠️ Tạo bộ nhớ AI thất bại: ' + e.message)
        }
      }

      // ── 7. Hoàn thành ─────────────────────────────────────────
      await setDoc(jobRef(docId), {
        stage: 'done',
        markdownRef,
        memoryOk,
        doneAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      }, { merge: true })

      setStage('done')
      notify('✅ Pipeline hoàn tất!', 100)

      return { ok: true, markdownRef, memoryOk }

    } catch (e) {
      console.error('[pipeline] Lỗi:', e)
      setStage('error')
      notify('❌ Pipeline lỗi: ' + e.message)

      try {
        await updateDoc(jobRef(docId), {
          stage: 'error',
          errorMessage: e.message,
          updatedAt: serverTimestamp(),
        })
      } catch {}

      return { ok: false, error: e.message }
    }
  }

  const abort = () => { abortRef.current = true }

  return { startPipeline, abort, reset, status, progress, stage }
}
