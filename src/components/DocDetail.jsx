import { useState, useRef, useEffect } from 'react'
import { useAI } from '../hooks/useAI'
import { useDocMemory } from '../hooks/useDocMemory'
import { useProcessPipeline } from '../hooks/useProcessPipeline'
import { useAuth } from '../context/AuthContext'

// ── Đọc file qua Vercel proxy (tránh CORS) ──────────────────────
const loadPdfJs = () => new Promise((res,rej) => {
  if (window.pdfjsLib){res(window.pdfjsLib);return}
  const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload=()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';res(window.pdfjsLib)}
  s.onerror=rej; document.head.appendChild(s)
})

const extractPdfTextFull = async (buf, onStep = null) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({data: buf}).promise
  const maxPages = pdf.numPages // Đọc TOÀN BỘ trang
  let text = ''
  for(let i=1;i<=maxPages;i++){
    if (onStep) onStep(`📄 Đang đọc trang ${i}/${maxPages}...`)
    const page = await pdf.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map(it=>it.str).join(' ') + '\n'
  }
  return text.trim().replace(/\s+/g,' ')
}

const loadScript = (src,check) => new Promise((res,rej)=>{
  if(check()){res();return}
  const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s)
})

const extractDocxText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',()=>window.mammoth)
  return (await window.mammoth.extractRawText({arrayBuffer:buf})).value
}

// ── Đọc PDF scan (OCR dự phòng khi không có chunks/markdown/text khác) ──
const readPDFWithGemini = async (arrayBuf, fileName, onStep) => {
  if (onStep) onStep('🔍 Đang trích xuất thông tin...')

  // Convert ArrayBuffer → base64
  const bytes = new Uint8Array(arrayBuf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  const base64 = btoa(binary)

  const gemKeys = [
    import.meta.env.VITE_GEMINI_API_KEY,
    import.meta.env.VITE_GEMINI_API_KEY_2,
    import.meta.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)

  const GEM_URL = (key) =>
    `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${key}`

  for (let i = 0; i < gemKeys.length; i++) {
    try {
      if (onStep) onStep(`🔍 Đang đọc và nhận dạng văn bản${i > 0 ? ` (lần ${i+1})` : ''}...`)
      const res = await fetch(GEM_URL(gemKeys[i]), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: 'application/pdf',
                  data: base64
                }
              },
              {
                text: `Trích xuất TOÀN BỘ nội dung văn bản trong file PDF này (tên file: ${fileName}).
Yêu cầu:
- Giữ nguyên 100% câu chữ, số liệu, tên người, bảng biểu, điều khoản
- Giữ nguyên cấu trúc: tiêu đề, điều, khoản, mục
- Không tóm tắt, không bỏ bất kỳ thông tin nào
- Chỉ trả về nội dung văn bản thuần túy`
              }
            ]
          }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 }
        })
      })

      if (res.status === 429) {
        if (i < gemKeys.length - 1) { await new Promise(r => setTimeout(r, 3000)); continue }
        throw new Error('Gemini hết quota')
      }
      if (!res.ok) { continue }

      const data = await res.json()
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
      if (text.length > 100) {
        if (onStep) onStep(`✅ Đã trích xuất ${text.length.toLocaleString()} ký tự`)
        return text
      }
    } catch(e) {
      if (i === gemKeys.length - 1) throw e
      continue
    }
  }
  throw new Error('Không thể đọc PDF bằng Gemini')
}

// Đọc file qua proxy /api/read-file để tránh CORS
const readFileViaProxy = async (url, fileName, onStep = null) => {
  const proxyUrl = `/api/read-file?url=${encodeURIComponent(url)}`
  if (onStep) onStep('📥 Đang tải file qua proxy...')

  // Stream trực tiếp dưới dạng binary (không base64 — không giới hạn kích thước)
  const res = await fetch(proxyUrl)
  if (!res.ok) throw new Error(`Proxy error: ${res.status}`)

  const arrayBuf = await res.arrayBuffer()
  const sizeMB = (arrayBuf.byteLength / 1024 / 1024).toFixed(1)
  if (onStep) onStep(`✅ Đã tải ${sizeMB}MB · Đang đọc nội dung...`)

  const ext = (fileName || '').split('.').pop().toLowerCase()
  if (ext === 'pdf') {
    const text = await extractPdfTextFull(arrayBuf, onStep)
    // Trả về cả text lẫn arrayBuf để dùng Gemini nếu text rỗng
    return { text, arrayBuf, ext }
  }
  if (['doc','docx'].includes(ext)) {
    const text = await extractDocxText(arrayBuf)
    return { text, arrayBuf, ext }
  }
  return { text: '', arrayBuf, ext }
}

// ── Helpers ──────────────────────────────────────────────────────
const get = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined && doc[k] !== '') return doc[k]
  return ''
}

const parseJ = (s) => {
  try { const m=s.match(/\{[\s\S]*\}/); return JSON.parse(m?m[0]:s.replace(/```json|```/g,'').trim()) } catch { return null }
}

// ── RAG: Tìm đoạn văn bản liên quan đến câu hỏi ──────────────────
const findRelevantChunks = (text, question) => {
  if (!text || !question) return ''

  // 1. Tách từ khóa từ câu hỏi (bỏ stop words tiếng Việt)
  const stopWords = new Set(['là','gì','có','của','và','các','cho','trong','được','không','về','này','đó','với','những','theo','từ','khi','hay','hoặc','như','thì','mà','để','tôi','bạn','hãy','cần','phải','làm','nào','ai','bao','nhiêu','sao'])
  const keywords = question.toLowerCase()
    .replace(/[?.,!;:""''()\[\]]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w))

  if (!keywords.length) return text.slice(0, 3000)

  // 2. Chia văn bản thành đoạn ~400 ký tự có overlap
  const chunks = []
  const size = 400, overlap = 100
  for (let i = 0; i < text.length; i += size - overlap) {
    chunks.push({ text: text.slice(i, i + size), pos: i })
  }

  // 3. Tính điểm liên quan cho từng đoạn
  const scored = chunks.map(chunk => {
    const lower = chunk.text.toLowerCase()
    let score = 0
    for (const kw of keywords) {
      // Khớp chính xác = 3 điểm, khớp một phần = 1 điểm
      if (lower.includes(kw)) score += 3
      else if (keywords.some(k => k.length > 3 && lower.includes(k.slice(0, -1)))) score += 1
    }
    return { ...chunk, score }
  })

  // 4. Lấy các đoạn điểm cao nhất, tối đa 3000 ký tự
  const relevant = scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .sort((a, b) => a.pos - b.pos) // Sắp xếp lại theo vị trí gốc

  if (!relevant.length) return text.slice(0, 2000) // fallback: đầu văn bản

  return relevant.map(c => c.text).join('\n---\n').slice(0, 3000)
}

const fmtDate = (ts) => {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000)
  return d.toLocaleDateString('vi-VN') + ' ' + d.toLocaleTimeString('vi-VN', { hour:'2-digit', minute:'2-digit' })
}

// ── Load chunks từ Firestore theo docId ──────────────────────────
// Đọc nội dung văn bản từ documentMarkdown (qua markdownRef trên documents/{docId}).
// KHÔNG còn đọc documentChunks nữa — cơ chế cũ đã bỏ hẳn.
const loadDocChunks = async (docId) => {
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const { db } = await import('../firebase')

    const docSnap = await getDoc(doc(db, 'documents', docId))
    const markdownRef = docSnap.exists() ? docSnap.data().markdownRef : null
    if (!markdownRef) return []

    const mdSnap = await getDoc(doc(db, 'documentMarkdown', markdownRef))
    if (mdSnap.exists()) {
      const mdData = mdSnap.data()
      if (mdData.markdown?.length > 50) {
        // Wrap markdown thành 1 chunk giả để code downstream (RAG, hiển thị) dùng được nguyên vẹn
        return [{ fromPage: 1, toPage: 99, text: mdData.markdown, chunkIndex: 0, docId }]
      }
    }
    return []
  } catch { return [] }
}

// ── RAG trên chunks Firestore (tìm theo trang liên quan) ──────────
const findRelevantChunksFromFirestore = (chunks, question) => {
  const stopWords = new Set(['là','gì','có','của','và','các','cho','trong','được','không','về','này','đó','với','những','theo','từ','khi','hay','hoặc','như','thì','mà','để','tôi','bạn','hãy','cần','phải','làm','nào','ai','bao','nhiêu','sao'])
  const keywords = question.toLowerCase()
    .replace(/[?.,!;:""\'\`()\[\]]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !stopWords.has(w))

  if (!keywords.length) return chunks.slice(0, 3).map(c => c.text).join('\n\n')

  const scored = chunks.map(chunk => {
    const lower = (chunk.text || '').toLowerCase()
    let score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 3 : 0), 0)
    return { ...chunk, score }
  })

  const top = scored
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => a.chunkIndex - b.chunkIndex)

  if (!top.length) return chunks.slice(0, 2).map(c => c.text).join('\n\n')
  return top.map(c => `### Trang ${c.fromPage}–${c.toPage}\n${c.text}`).join('\n\n').slice(0, 6000)
}

export default function DocDetail({ doc, onEdit, onClose }) {
  if (!doc) return null

  const { analyzeDeepForMemory, askDeep, loading: aiLoading } = useAI()
  const { memory, loading: memLoading, saveMemory } = useDocMemory(doc.id)
  const { startPipeline, status: pipeStatus, progress: pipeProgress, stage: pipeStage } = useProcessPipeline()
  const { isAdmin } = useAuth()

  const [analyzing,        setAnalyzing]        = useState(false)
  const [docChunks,        setDocChunks]        = useState([])
  const [analyzeStep,      setAnalyzeStep]      = useState('')
  const [countdown,        setCountdown]        = useState(0)
  const [showChat,         setShowChat]         = useState(false)
  const [chat,             setChat]             = useState([])
  const [chatInput,        setChatInput]        = useState('')
  const [autoPipeStarted,  setAutoPipeStarted]  = useState(false)
  // ── Xem trực tiếp nội dung đã đọc — để biết "đã xong" có thật không ──
  const [mdPreview,    setMdPreview]    = useState(null)   // {text, charCount, totalPages}
  const [mdPreviewOpen, setMdPreviewOpen] = useState(false)
  const [mdLoading,    setMdLoading]    = useState(false)

  const loadMdPreview = async () => {
    if (mdPreview) { setMdPreviewOpen(v => !v); return } // đã tải rồi, chỉ toggle hiện/ẩn
    setMdLoading(true)
    try {
      const { doc: fsDoc, getDoc } = await import('firebase/firestore')
      const { db } = await import('../firebase')
      // documentMarkdown dùng docId làm key (bản mới) hoặc markdownRef (bản cũ)
      let text = '', charCount = 0
      const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.id))
      if (mdSnap.exists()) {
        text = mdSnap.data().markdown || ''
        charCount = mdSnap.data().charCount || text.length
      } else if (doc?.markdownRef) {
        const mdSnap2 = await getDoc(fsDoc(db, 'documentMarkdown', doc.markdownRef))
        if (mdSnap2.exists()) { text = mdSnap2.data().markdown || ''; charCount = mdSnap2.data().charCount || text.length }
      }
      let totalPages = null
      const jobSnap = await getDoc(fsDoc(db, 'processingJobs', doc.id))
      if (jobSnap.exists()) totalPages = jobSnap.data().totalPages || null
      setMdPreview({ text, charCount, totalPages })
      setMdPreviewOpen(true)
    } catch (e) {
      setMdPreview({ text: '', charCount: 0, totalPages: null, error: e.message })
      setMdPreviewOpen(true)
    } finally { setMdLoading(false) }
  }
  const [jobDone,          setJobDone]          = useState(false)
  const chatEndRef = useRef(null)

  useEffect(() => {
    if (showChat) setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
  }, [chat, showChat])

  // Load chunks + kiểm tra processingJobs khi mở
  useEffect(() => {
    if (!doc?.id) return
    loadDocChunks(doc.id).then(chunks => {
      if (chunks.length > 0) setDocChunks(chunks)
    })
    // Kiểm tra pipeline đã chạy xong chưa
    import('firebase/firestore').then(({ doc: fsDoc, getDoc }) =>
      import('../firebase').then(({ db }) =>
        getDoc(fsDoc(db, 'processingJobs', doc.id)).then(snap => {
          if (snap.exists() && snap.data().stage === 'done') setJobDone(true)
        }).catch(() => {})
      )
    )
  }, [doc?.id])

  // Auto-pipeline: CHỈ chạy khi văn bản HOÀN TOÀN mới (không có bất kỳ data nào)
  // Không resume data cũ (có thể là watermark) — người dùng tự bấm "Đọc lại" nếu muốn
  useEffect(() => {
    if (memLoading) return
    if (memory) return                            // đã có memory → bỏ qua
    if (jobDone) return
    if (autoPipeStarted) return
    const fileUrl = get(doc, 'fileUrl', 'downloadUrl')
    if (!fileUrl) return                          // chưa có file → bỏ qua

    const timer = setTimeout(async () => {
      if (docChunks.length > 0) return            // đã có chunks → người dùng tự quyết

      // Kiểm tra processingJobs — nếu đã có bất kỳ data nào thì KHÔNG auto chạy
      // (tránh resume dữ liệu cũ bị lỗi/watermark)
      try {
        const { doc: fsDoc, getDoc } = await import('firebase/firestore')
        const { db } = await import('../firebase')
        const jobSnap = await getDoc(fsDoc(db, 'processingJobs', doc.id))
        if (jobSnap.exists()) return              // đã có job cũ → không auto, để user bấm "Đọc lại"
        const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.id))
        if (mdSnap.exists()) return              // đã có markdown cũ → không auto
      } catch {}

      // Thực sự là văn bản mới chưa xử lý gì → auto chạy pipeline
      setAutoPipeStarted(true)
      setAnalyzeStep('🚀 Đang tự động xử lý tài liệu mới...')
      await startPipeline({
        docId:    doc.id,
        fileUrl,
        fileName: doc.fileName || '',
        onStatus: setAnalyzeStep,
        forceRestart: false,
      })
    }, 1500)

    return () => clearTimeout(timer)
  }, [memLoading, memory, jobDone, doc?.id, docChunks.length, autoPipeStarted])

  const code     = get(doc, 'code')
  const date     = get(doc, 'date')
  const org      = get(doc, 'org')
  const docType  = get(doc, 'docType')
  const subject  = get(doc, 'subject')
  const detail   = get(doc, 'detail')
  const note     = get(doc, 'note')
  const fileName = get(doc, 'fileName')
  const fileSize = doc.fileSize || 0
  const fileUrl  = get(doc, 'fileUrl', 'downloadUrl', 'secureUrl')
  const hasFile  = fileUrl && fileUrl.length > 5

  const SM = {
    done:    { label:'✅ Hoàn thành',     bg:'#f0fdf4', color:'#15803d' },
    pending: { label:'🔄 Đang thực hiện', bg:'#fffbeb', color:'#b45309' },
    prep:    { label:'⬜ Chưa thực hiện', bg:'#f5f5f5', color:'#666' },
  }
  const s = SM[doc.status] || SM.prep

  const fIcon = (n='') => {
    const e = n.split('.').pop().toLowerCase()
    if (e==='pdf') return '📕'
    if (['doc','docx'].includes(e)) return '📘'
    if (['xls','xlsx'].includes(e)) return '📗'
    return '📄'
  }

  const handleDownload = async (e) => {
    e.preventDefault()
    if (!fileUrl) return
    try {
      const data = await readFileViaProxy(fileUrl, fileName)
      window.open(fileUrl, '_blank')
    } catch {
      window.open(fileUrl, '_blank')
    }
  }

  // ── Đếm ngược và tự retry ──
  const startCountdownAndRetry = (seconds) => {
    let left = seconds
    setCountdown(left)
    setAnalyzeStep(`⏳ AI đang nghỉ ngơi... thử lại sau ${left}s`)
    const timer = setInterval(() => {
      left -= 1
      setCountdown(left)
      setAnalyzeStep(`⏳ AI đang nghỉ ngơi... thử lại sau ${left}s`)
      if (left <= 0) {
        clearInterval(timer)
        setCountdown(0)
        handleAnalyze() // Tự động retry
      }
    }, 1000)
  }

  // ── Đọc lại toàn bộ file từ đầu (xóa bộ nhớ cũ, chạy pipeline mới) ──
  const handleForceReAnalyze = async () => {
    const fileUrl = get(doc, 'fileUrl', 'downloadUrl')
    if (!fileUrl) { alert('Không có file URL để đọc lại'); return }
    setChat([]); setShowChat(false)
    setMdPreview(null); setMdPreviewOpen(false)
    setJobDone(false); setAutoPipeStarted(true)
    setAnalyzeStep('🔄 Đang xóa dữ liệu cũ và đọc lại từ đầu...')
    await startPipeline({
      docId: doc.id, fileUrl, fileName: doc.fileName || '',
      onStatus: setAnalyzeStep, forceRestart: true,
    })
    setAutoPipeStarted(false)
    setJobDone(true)
  }

  // ── Local OCR bằng ABBYY (worker chạy trên máy tính) ──
  const handleLocalOcr = async () => {
    const fileUrl = get(doc, 'fileUrl', 'downloadUrl')
    if (!fileUrl) { alert('Không có file URL'); return }
    setChat([]); setShowChat(false)
    setMdPreview(null); setMdPreviewOpen(false)
    setJobDone(false); setAutoPipeStarted(true)
    setAnalyzeStep('🖥️ Đang gửi lệnh cho ABBYY worker trên máy tính...')
    await startPipeline({
      docId: doc.id, fileUrl, fileName: doc.fileName || '',
      onStatus: setAnalyzeStep, forceRestart: true, useLocalOcr: true,
    })
    setAutoPipeStarted(false)
    setJobDone(true)
  }

  // ── Phân tích sâu & ghi nhớ ──
  const handleAnalyze = async () => {
    if (countdown > 0) {
      setAnalyzeStep(`⏳ Vui lòng đợi thêm ${countdown} giây nữa để AI sẵn sàng!`)
      return
    }
    // Xóa chat cũ khi phân tích lại để tránh AI trả lời theo lịch sử cũ
    setChat([])
    setShowChat(false)
    if (countdown > 0) {
      setAnalyzeStep(`⏳ Vui lòng đợi thêm ${countdown} giây nữa để AI sẵn sàng!`)
      return
    }
    // Xóa chat cũ khi phân tích lại để tránh AI trả lời theo lịch sử cũ
    setChat([])
    setShowChat(false)
    setAnalyzing(true)
    try {
      // Bước 1: metadata sẵn có trong Firestore
      const docMeta = [
        `Số ký hiệu: ${doc.code || ''}`,
        `Ngày ban hành: ${doc.date || ''}`,
        `Cơ quan ban hành: ${doc.org || ''}`,
        `Loại văn bản: ${doc.docType || ''}`,
        `Nội dung/Về việc: ${doc.subject || ''}`,
        `Trích yếu: ${doc.detail || ''}`,
        `Ghi chú: ${doc.note || ''}`,
      ].filter(l => !l.endsWith(': ')).join('\n')

      let fullText = docMeta

      // Bước 2: Kiểm tra nguồn text — ưu tiên: chunks → doc.extractedText → memory → proxy
      let extractedText = ''

      if (docChunks.length > 0) {
        // 🟢 Tốt nhất: chunks Firestore — đọc đầy đủ 100-200 trang
        extractedText = docChunks.map(c => `### Trang ${c.fromPage}–${c.toPage}\n${c.text}`).join('\n\n')
        setAnalyzeStep(`⚡ Dùng ${docChunks.length} chunks Firestore (${(extractedText.length/1000).toFixed(0)}K ký tự) · 🤖 AI phân tích...`)
        fullText = docMeta + '\n\n=== NỘI DUNG ĐẦY ĐỦ TỪ FILE (CHUNKS) ===\n' + extractedText.slice(0, 80000)

      } else if (doc.markdownRef) {
        // 🟢 Tốt nhất: Markdown đầy đủ từ Firestore documentMarkdown
        try {
          setAnalyzeStep('📥 Đang tải Markdown từ Firestore...')
          const { doc: fsDoc, getDoc } = await import('firebase/firestore')
          const { db } = await import('../firebase')
          const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.markdownRef))
          if (mdSnap.exists()) {
            extractedText = mdSnap.data().markdown || ''
            setAnalyzeStep(`✅ Tải xong Markdown (${(extractedText.length/1000).toFixed(0)}K ký tự) · 🤖 AI phân tích...`)
            fullText = docMeta + '\n\n=== NỘI DUNG MARKDOWN ĐẦY ĐỦ ===\n' + extractedText
          }
        } catch(e) {
          setAnalyzeStep('⚠️ Không tải được Markdown, dùng extractedText...')
        }
        if (!extractedText && doc.extractedText?.length > 100) {
          extractedText = doc.extractedText
          fullText = docMeta + '\n\n=== NỘI DUNG ĐẦY ĐỦ TỪ FILE ===\n' + extractedText
        }

      } else if (doc.extractedText?.length > 100) {
        // 🟡 Thứ 2: text lưu ngay lúc upload
        extractedText = doc.extractedText
        setAnalyzeStep(`⚡ Dùng text đã lưu sẵn (${(extractedText.length/1000).toFixed(0)}K ký tự) · 🤖 AI phân tích...`)
        fullText = docMeta + '\n\n=== NỘI DUNG ĐẦY ĐỦ TỪ FILE ===\n' + extractedText

      } else if (memory?.extractedText?.length > 100) {
        // 🟡 Thứ 2: text đã lưu từ lần phân tích trước
        extractedText = memory.extractedText
        setAnalyzeStep(`📚 Dùng bộ nhớ cũ (${(extractedText.length/1000).toFixed(0)}K ký tự) · 🤖 AI phân tích...`)
        fullText = docMeta + '\n\n=== NỘI DUNG ĐẦY ĐỦ TỪ FILE ===\n' + extractedText

      } else if (hasFile) {
        // Bước 3: Tải file qua proxy
        setAnalyzeStep('📥 Đang tải file qua proxy...')
        try {
          const result = await Promise.race([
            readFileViaProxy(fileUrl, fileName, setAnalyzeStep),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 180000))
          ])

          let fileText = result.text || ''

          // Bước 4: Nếu PDF không có text (scan) → dùng Gemini OCR
          if (fileText.length < 100 && result.ext === 'pdf' && result.arrayBuf) {
            try {
              fileText = await readPDFWithGemini(result.arrayBuf, fileName, setAnalyzeStep)
            } catch(e) {
              setAnalyzeStep(`⚠️ Không trích xuất được nội dung: ${e.message} — dùng metadata`)
            }
          }

          if (fileText.length > 100) {
            extractedText = fileText
            fullText = docMeta + '\n\n=== NỘI DUNG ĐẦY ĐỦ TỪ FILE ===\n' + fileText
            setAnalyzeStep(`✅ Đọc xong ${fileText.length.toLocaleString()} ký tự · 🤖 AI bắt đầu phân tích...`)
          } else {
            setAnalyzeStep('⚠️ Không đọc được nội dung file — dùng metadata')
          }
        } catch(e) {
          setAnalyzeStep(`⚠️ ${e.message === 'timeout' ? 'File quá lớn/chậm' : 'Lỗi: ' + e.message} — dùng metadata`)
        }
      }

      setAnalyzeStep(prev => prev.includes('AI') ? prev : '🤖 AI đang phân tích sâu...')
      const result = await analyzeDeepForMemory(fullText, fileName || doc.code, setAnalyzeStep)

      let parsed = parseJ(result)
      if (!parsed) {
        parsed = {
          summary: result.slice(0, 1500),
          keyPoints: result.split('\n').filter(l => l.trim().match(/^[-\d•*]/)).map(l => l.replace(/^[-\d.•*]+\s*/,'').trim()).filter(Boolean).slice(0,10),
          legalBasis: '',
          requirements: '',
          risks: '',
          keywords: (doc.subject||'').split(/\s+/).filter(w=>w.length>3).slice(0,8),
        }
      }

      await saveMemory({ ...parsed, fileName: fileName || doc.code, readChars: fullText.length, extractedText: extractedText || '' })
      setAnalyzeStep('✅ Đã ghi nhớ thành công!')
      setShowChat(true)
      setTimeout(() => setAnalyzeStep(''), 2000)
    } catch(e) {
      if (e.message === 'AI_RATE_LIMIT') {
        const wait = e.waitSeconds || 60
        startCountdownAndRetry(wait)
      } else {
        setAnalyzeStep('❌ Lỗi: ' + e.message)
        setTimeout(() => setAnalyzeStep(''), 6000)
      }
    } finally { setAnalyzing(false) }
  }

  // ── Hỏi đáp sâu dùng bộ nhớ ──
  // ── Tìm câu trả lời trong dữ liệu đã trích xuất sẵn (keyPoints, legal,
  // deadlines, technicalSpecs, financial, members, otherData, requirements,
  // risks) — TRƯỚC khi gọi AI. Có rồi thì trả lời ngay, không tốn 1 lượt AI. ──
  const searchStructuredMemory = (mem, question) => {
    if (!mem) return null
    const stopWords = new Set(['là','gì','có','của','và','các','cho','trong','được','không','về','này','đó','với','những','theo','từ','khi','hay','hoặc','như','thì','mà','để','tôi','bạn','hãy','cần','phải','làm','nào','ai','quy','định'])
    const keywords = question.toLowerCase().replace(/[?.,!;:]/g, ' ').split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
    if (!keywords.length) return null

    const arrayFields = ['keyPoints', 'legal', 'deadlines', 'technicalSpecs', 'financial', 'members', 'otherData']
    const matches = []
    for (const field of arrayFields) {
      const arr = mem[field]
      if (!Array.isArray(arr)) continue
      for (const item of arr) {
        if (!item) continue
        const lower = String(item).toLowerCase()
        const score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0)
        if (score > 0) matches.push({ item, score })
      }
    }
    for (const field of ['requirements', 'risks']) {
      const text = mem[field]
      if (text && typeof text === 'string') {
        const lower = text.toLowerCase()
        const score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 1 : 0), 0)
        if (score > 0) matches.push({ item: text, score })
      }
    }

    if (!matches.length) return null
    matches.sort((a, b) => b.score - a.score)
    const topScore = matches[0].score
    // Chỉ chắc ăn khi khớp ít nhất 2 từ khóa, hoặc 1 từ khóa nhưng không còn lựa chọn nào khác có điểm cao hơn
    if (topScore < (keywords.length > 1 ? 2 : 1)) return null

    const best = matches.filter(m => m.score === topScore).slice(0, 5)
    return best.map(m => `• ${m.item}`).join('\n')
  }

  const handleAsk = async (q) => {
    if (!q.trim() || aiLoading) return
    setChat(c => [...c, { role:'user', content:q }])
    setChatInput('')
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 50)

    // ── Ưu tiên 1: có sẵn trong dữ liệu đã trích xuất → trả lời ngay, không gọi AI ──
    const directAnswer = searchStructuredMemory(memory, q)
    if (directAnswer) {
      setChat(c => [...c, { role:'ai', content: `📋 Tìm thấy trong dữ liệu đã trích xuất (không cần gọi AI):\n\n${directAnswer}` }])
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
      return
    }

    try {
      // RAG: Ưu tiên chunks Firestore, fallback memory.extractedText, fallback metadata
      let relevantText = ''
      if (docChunks.length > 0) {
        relevantText = findRelevantChunksFromFirestore(docChunks, q)
      } else {
        // Ưu tiên Markdown từ Firestore cho RAG
        let rawText = memory?.extractedText || doc?.extractedText || ''
        // Đọc markdown từ documentMarkdown/{docId} (key mới) hoặc markdownRef (key cũ)
        if (!rawText) {
          try {
            const { doc: fsDoc, getDoc } = await import('firebase/firestore')
            const { db } = await import('../firebase')
            // Thử key mới (docId) trước
            const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.id))
            if (mdSnap.exists()) {
              rawText = mdSnap.data().markdown || ''
            } else if (doc?.markdownRef) {
              // Tương thích ngược: key cũ (random ID)
              const mdSnap2 = await getDoc(fsDoc(db, 'documentMarkdown', doc.markdownRef))
              if (mdSnap2.exists()) rawText = mdSnap2.data().markdown || ''
            }
          } catch {}
        }
        // Fallback: metadata văn bản làm context tối thiểu
        if (!rawText && (doc?.subject || doc?.detail)) {
          rawText = [
            doc.code    ? `Số ký hiệu: ${doc.code}` : '',
            doc.date    ? `Ngày ban hành: ${doc.date}` : '',
            doc.org     ? `Cơ quan ban hành: ${doc.org}` : '',
            doc.docType ? `Loại văn bản: ${doc.docType}` : '',
            doc.subject ? `Nội dung/Về việc: ${doc.subject}` : '',
            doc.detail  ? `Trích yếu: ${doc.detail}` : '',
            doc.note    ? `Ghi chú: ${doc.note}` : '',
          ].filter(Boolean).join('\n')
        }
        relevantText = rawText.length > 50 ? findRelevantChunks(rawText, q) : rawText
      }
      // Truyền memory || {} để askDeep không crash khi memory chưa có
      const answer = await askDeep(q, memory || {}, chat, relevantText)
      setChat(c => [...c, { role:'ai', content: answer }])
    } catch(e) {
      const errMsg = e.message === 'AI_RATE_LIMIT'
        ? '⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!'
        : '❌ Lỗi: ' + e.message
      setChat(prev => [...prev, { role:'ai', content: errMsg }])
    }
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
  }

  const Row = ({ label, value }) => value ? (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, color:'#1a1a1a', lineHeight:1.6 }}>{value}</div>
    </div>
  ) : null

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100, padding:20 }}
      onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:'100%', maxWidth:620, maxHeight:'92vh', overflowY:'auto', boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:700, color:'#1a1a1a', marginBottom:6 }}>{code || subject || '(Chưa có số ký hiệu)'}</div>
            <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:500, background:s.bg, color:s.color }}>{s.label}</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888' }}>✕</button>
        </div>

        <div>
          {/* Thông tin văn bản */}
          <div>
            <div style={{ borderTop:'0.5px solid #e5e4e0', paddingTop:14 }}>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
                <Row label="Ngày ban hành" value={date}/>
                <Row label="Loại văn bản"  value={docType}/>
              </div>
              <Row label="Cơ quan ban hành"   value={org}/>
              <Row label="Nội dung / Về việc" value={subject}/>
              {detail && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:3 }}>Trích yếu nội dung</div>
                  <div style={{ fontSize:13, color:'#1a1a1a', lineHeight:1.7, background:'#fafaf8', border:'0.5px solid #e5e4e0', borderRadius:8, padding:'10px 12px' }}>{detail}</div>
                </div>
              )}
              {note && (
                <div style={{ marginBottom:12 }}>
                  <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:3 }}>✨ Ghi chú AI</div>
                  <div style={{ fontSize:13, color:'#555', lineHeight:1.7, fontStyle:'italic', background:'#f5f3ff', border:'0.5px solid #e9d5ff', borderRadius:8, padding:'10px 12px' }}>{note}</div>
                </div>
              )}

              {/* File đính kèm */}
              {hasFile ? (
                <div style={{ marginBottom:12, padding:'14px', borderRadius:10, background:'#f8faff', border:'0.5px solid #c7d7f5' }}>
                  <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:10 }}>📎 Tài liệu đính kèm</div>
                  <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                    <span style={{ fontSize:28, flexShrink:0 }}>{fIcon(fileName)}</span>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:'#1a1a1a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fileName || 'tài liệu'}</div>
                      {fileSize > 0 && <div style={{ fontSize:11, color:'#9b9b9b', marginTop:2 }}>{(fileSize/1024/1024).toFixed(1)} MB</div>}
                    </div>
                    <button onClick={async () => {
                        // Tải qua proxy với tên file gốc
                        const a = document.createElement('a')
                        a.href = `/api/read-file?url=${encodeURIComponent(fileUrl)}`
                        a.download = fileName || 'document.pdf'
                        document.body.appendChild(a)
                        a.click()
                        document.body.removeChild(a)
                      }}
                      style={{ padding:'7px 14px', borderRadius:8, fontSize:12, fontWeight:600, background:'#f0fdf4', border:'0.5px solid #bbf7d0', color:'#15803d', cursor:'pointer' }}>
                      📥 Tải về
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ marginBottom:12, padding:'12px 14px', borderRadius:10, background:'#fafaf8', border:'0.5px solid #e5e7eb', fontSize:12, color:'#9b9b9b', textAlign:'center' }}>
                  📂 Chưa có file đính kèm
                </div>
              )}

              {/* Vùng phân tích sâu */}
              <div style={{ marginBottom:12, padding:'14px', borderRadius:10,
                background: memory ? '#f0fdf4' : (autoPipeStarted || analyzing) ? '#eff6ff' : '#fefce8',
                border:`0.5px solid ${memory ? '#bbf7d0' : (autoPipeStarted || analyzing) ? '#bfdbfe' : '#fde68a'}` }}>

                {/* Đang kiểm tra */}
                {memLoading ? (
                  <div style={{ fontSize:12, color:'#888', textAlign:'center' }}>⏳ Đang kiểm tra...</div>

                /* Đang chạy pipeline */
                ) : (autoPipeStarted || analyzing) ? (
                  <div style={{ fontSize:12, color:'#1d4ed8' }}>
                    {isAdmin
                      ? (analyzeStep || '⏳ Đang phân tích tài liệu...')
                      : '⏳ Đang phân tích tài liệu...'}
                  </div>

                /* ĐÃ PHÂN TÍCH — có memory */
                ) : memory ? (
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8, flexWrap:'wrap', gap:6 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:'#15803d' }}>
                        ✅ Tài liệu đã được phân tích · {fmtDate(memory.analyzedAt)}
                      </div>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => setShowChat(v => !v)}
                          style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600, background:'#0a2342', color:'#fff', border:'none', cursor:'pointer' }}>
                          💬 Hỏi đáp tài liệu
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('Tài liệu đã được phân tích rồi.\nCó muốn phân tích lại từ đầu không?\n(Bộ nhớ cũ sẽ bị xóa)')) {
                              handleForceReAnalyze()
                            }
                          }}
                          style={{ padding:'5px 10px', borderRadius:7, fontSize:11, background:'#fff', border:'0.5px solid #d1d5db', color:'#6b7280', cursor:'pointer' }}>
                          🔄 Phân tích lại
                        </button>
                        <button onClick={handleLocalOcr} title="Đọc lại bằng ABBYY FineReader (cần chạy start-worker.bat)"
                          style={{ padding:'5px 10px', borderRadius:7, fontSize:11, background:'#f3e8ff', border:'0.5px solid #c4b5fd', color:'#7c3aed', cursor:'pointer' }}>
                          🖥️ ABBYY
                        </button>
                      </div>
                    </div>
                    {memory.summary && (
                      <div style={{ fontSize:12, color:'#374151', lineHeight:1.6, background:'#fff', borderRadius:8, padding:'8px 10px', border:'0.5px solid #d1fae5' }}>
                        {memory.summary.slice(0, 300)}{memory.summary.length > 300 ? '...' : ''}
                      </div>
                    )}
                    {memory.keywords?.length > 0 && (
                      <div style={{ marginTop:8, display:'flex', flexWrap:'wrap', gap:4 }}>
                        {memory.keywords.slice(0,10).map(kw => (
                          <span key={kw} style={{ fontSize:10, padding:'2px 8px', borderRadius:10, background:'#d1fae5', color:'#065f46' }}>{kw}</span>
                        ))}
                      </div>
                    )}
                  </>

                /* ĐÃ XỬ LÝ — có chunks/jobDone nhưng chưa có memory (lỗi bước cuối) */
                ) : (docChunks.length > 0 || jobDone) ? (
                  <div>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:6 }}>
                      <div style={{ fontSize:12, color:'#92400e' }}>
                        ⚠️ Đã đọc file nhưng chưa tạo được bộ nhớ AI
                      </div>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => setShowChat(v => !v)}
                          style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600, background:'#0a2342', color:'#fff', border:'none', cursor:'pointer' }}>
                          💬 Hỏi đáp tài liệu
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('Tài liệu đã được đọc rồi.\nCó muốn phân tích lại từ đầu không?')) {
                              handleForceReAnalyze()
                            }
                          }}
                          style={{ padding:'5px 10px', borderRadius:7, fontSize:11, background:'#fff7ed', border:'0.5px solid #f59e0b', color:'#92400e', cursor:'pointer', fontWeight:600 }}>
                          🔄 Phân tích lại
                        </button>
                      </div>
                    </div>
                  </div>

                /* CHƯA PHÂN TÍCH LẦN NÀO */
                ) : (
                  <>
                    <div style={{ fontSize:12, color:'#92400e', marginBottom:10 }}>
                      📋 <b>Tài liệu chưa được phân tích</b>
                      {hasFile && <span style={{ color:'#555', fontWeight:400 }}> — AI sẽ đọc toàn bộ {(fileSize/1024/1024).toFixed(1)}MB và ghi nhớ để hỏi đáp sau này.</span>}
                    </div>
                    <div style={{ display:'flex', gap:6 }}>
                      <button onClick={handleForceReAnalyze}
                        style={{ flex:1, padding:'9px', borderRadius:8, fontSize:13, fontWeight:600, background:'#0a2342', color:'#fff', border:'none', cursor:'pointer' }}>
                        📊 Phân tích (Cloud)
                      </button>
                      <button onClick={handleLocalOcr} title="Dùng ABBYY FineReader trên máy tính (cần chạy start-worker.bat)"
                        style={{ padding:'9px 14px', borderRadius:8, fontSize:13, fontWeight:600, background:'#7c3aed', color:'#fff', border:'none', cursor:'pointer' }}>
                        🖥️ ABBYY
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Chat Q&A — hiển thị bên DƯỚI thông tin văn bản ── */}
        {showChat && (
          <div style={{ marginTop:16, borderTop:'0.5px solid #e5e4e0', paddingTop:14 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#0a2342', marginBottom:10 }}>💬 Hỏi đáp sâu về tài liệu</div>

            {/* Gợi ý câu hỏi nhanh khi chưa có chat */}
            {chat.length === 0 && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginBottom:12 }}>
                {[
                  'Tóm tắt toàn bộ nội dung văn bản này',
                  'Các điểm quan trọng cần lưu ý?',
                  'Căn cứ pháp lý được viện dẫn?',
                  'Có rủi ro hoặc điểm bất thường không?',
                  memory?.requirements ? 'Yêu cầu kỹ thuật cụ thể?' : null,
                  memory?.legalBasis   ? 'Văn bản pháp lý liên quan?' : null,
                ].filter(Boolean).map(q => (
                  <button key={q} onClick={() => handleAsk(q)}
                    style={{ padding:'6px 10px', borderRadius:16, fontSize:11, background:'#f0f4ff', border:'0.5px solid #c7d7f5', cursor:'pointer', color:'#0a2342', whiteSpace:'nowrap' }}>
                    {q}
                  </button>
                ))}
              </div>
            )}

            {/* Lịch sử chat */}
            <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:10, maxHeight:380, overflowY:'auto' }}>
              {chat.map((m, i) => (
                <div key={i} style={{ display:'flex', justifyContent: m.role==='user' ? 'flex-end' : 'flex-start' }}>
                  <div style={{ maxWidth:'88%', padding:'9px 13px', borderRadius:12, fontSize:12.5, lineHeight:1.65,
                    background: m.role==='user' ? '#0a2342' : '#f8fffe',
                    color: m.role==='user' ? '#fff' : '#1a1a1a',
                    border: m.role==='ai' ? '0.5px solid #c3e6cb' : 'none',
                    whiteSpace:'pre-wrap' }}>
                    {m.content}
                  </div>
                </div>
              ))}
              {aiLoading && (
                <div style={{ display:'flex' }}>
                  <div style={{ padding:'8px 12px', borderRadius:10, fontSize:12, background:'#f5f5f3', color:'#888' }}>⏳ Đang tra cứu...</div>
                </div>
              )}
              <div ref={chatEndRef}/>
            </div>

            {/* Input */}
            <div style={{ display:'flex', gap:6 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
                placeholder="Hỏi bất kỳ điều gì về tài liệu..."
                style={{ flex:1, padding:'9px 13px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none' }}/>
              <button onClick={() => handleAsk(chatInput)} disabled={aiLoading || !chatInput.trim()}
                style={{ padding:'9px 16px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:14 }}>▶</button>
            </div>
            {chat.length > 0 && (
              <button onClick={() => setChat([])} style={{ marginTop:6, fontSize:11, color:'#aaa', background:'none', border:'none', cursor:'pointer' }}>
                🗑️ Xóa lịch sử chat
              </button>
            )}
          </div>
        )}

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:16, borderTop:'0.5px solid #e5e4e0', paddingTop:14 }}>
          <button onClick={onClose} style={{ padding:'8px 18px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', color:'#555', fontSize:13 }}>Đóng</button>
          <button onClick={onEdit}  style={{ padding:'8px 20px', border:'none', borderRadius:8, cursor:'pointer', background:'#1a1a1a', color:'#fff', fontSize:13, fontWeight:500 }}>✏️ Chỉnh sửa</button>
        </div>
      </div>
    </div>
  )
}
