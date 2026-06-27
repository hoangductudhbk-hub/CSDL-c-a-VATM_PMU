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

  // Gọi Gemini qua /api/gemini-proxy — key ở server, không lộ ra browser
  if (onStep) onStep('🔍 Đang đọc và nhận dạng văn bản...')
  const parts = [
    { inline_data: { mime_type: 'application/pdf', data: base64 } },
    { text: `Trích xuất TOÀN BỘ nội dung văn bản trong file PDF này (tên file: ${fileName}).
Yêu cầu:
- Giữ nguyên 100% câu chữ, số liệu, tên người, bảng biểu, điều khoản
- Giữ nguyên cấu trúc: tiêu đề, điều, khoản, mục
- Không tóm tắt, không bỏ bất kỳ thông tin nào
- Chỉ trả về nội dung văn bản thuần túy` }
  ]
  const res = await fetch('/api/gemini-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts, maxTokens: 8192 }),
  })
  if (!res.ok) throw new Error(`Gemini proxy lỗi: ${res.status}`)
  const data = await res.json()
  const text = data.text || ''
  if (text.length > 100) {
    if (onStep) onStep(`✅ Đã trích xuất ${text.length.toLocaleString()} ký tự`)
    return text
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

// ── Chuẩn hoá ngày ban hành về dd/mm/yyyy (luôn pad số 0) ─────────
const pad2 = (n) => String(n).padStart(2, '0')
const normDate = (raw = '') => {
  if (!raw) return ''
  const s = raw.replace(/^[^,]+,\s*/i, '').trim()
  const m1 = s.match(/(?:ngày\s*)?(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m1) return `${pad2(m1[1])}/${pad2(m1[2])}/${m1[3]}`
  const m4 = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/)
  if (m4) return `${pad2(m4[1])}/${pad2(m4[2])}/${m4[3].length===2?'20'+m4[3]:m4[3]}`
  const m5 = s.match(/^(\d{1,2})[\/-](\d{4})$/) // chỉ có tháng/năm
  if (m5) return `${pad2(m5[1])}/${m5[2]}`
  return s
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
  const { startPipeline, status: pipeStatus, progress: pipeProgress } = useProcessPipeline()
  const { isAdmin } = useAuth()

  const [analyzing,        setAnalyzing]        = useState(false)
  const [analyzeStep,      setAnalyzeStep]      = useState('')
  const [analyzeError,     setAnalyzeError]     = useState('')
  const [showChat,         setShowChat]         = useState(false)
  const [chat,             setChat]             = useState([])
  const [chatInput,        setChatInput]        = useState('')
  const [autoPipeStarted,  setAutoPipeStarted]  = useState(false)
  // ── Xem trực tiếp nội dung đã đọc — để biết "đã xong" có thật không ──
  const [mdPreview,    setMdPreview]    = useState(null)   // {text, charCount, totalPages}
  const [mdPreviewOpen, setMdPreviewOpen] = useState(false)
  const [mdLoading,    setMdLoading]    = useState(false)

  const loadMdPreview = async () => {
    if (mdPreview) { setMdPreviewOpen(v => !v); return }
    setMdLoading(true)
    try {
      const { doc: fsDoc, getDoc } = await import('firebase/firestore')
      const { db } = await import('../firebase')
      let text = '', charCount = 0, totalPages = null
      const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.id))
      if (mdSnap.exists()) {
        text = mdSnap.data().markdown || ''
        charCount = mdSnap.data().charCount || text.length
        totalPages = mdSnap.data().totalPages || null
      }
      setMdPreview({ text, charCount, totalPages })
      setMdPreviewOpen(true)
    } catch (e) {
      setMdPreview({ text: '', charCount: 0, totalPages: null, error: e.message })
      setMdPreviewOpen(true)
    } finally { setMdLoading(false) }
  }
  const chatEndRef = useRef(null)

  useEffect(() => {
    if (showChat) setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
  }, [chat, showChat])

  // Auto-pipeline đã bị tắt — người dùng tự nhấn nút khi cần để tiết kiệm token

  const code     = get(doc, 'code')
  const date     = normDate(get(doc, 'date'))
  const org      = get(doc, 'org')
  const docType  = get(doc, 'docType')
  const subject  = get(doc, 'subject')
  const detail   = get(doc, 'detail')
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

  // ── Đọc lại toàn bộ file từ đầu (xóa bộ nhớ cũ, chạy pipeline mới) ──
  const handleForceReAnalyze = async () => {
    const fileUrl = get(doc, 'fileUrl', 'downloadUrl')
    if (!fileUrl) { alert('Không có file URL để đọc lại'); return }
    setChat([]); setShowChat(false)
    setMdPreview(null); setMdPreviewOpen(false)
    setAutoPipeStarted(true)
    try {
      await startPipeline({
        docId: doc.id, fileUrl, fileName: doc.fileName || '',
        onStatus: setAnalyzeStep, forceRestart: true,
      })
      setShowChat(true)
    } catch {}
    setAutoPipeStarted(false)
  }

  // ── Phân tích sâu & ghi nhớ ──
  const handleAnalyze = async () => {
    const fileUrl = get(doc, 'fileUrl', 'downloadUrl')
    if (!fileUrl) { alert('Không có file URL'); return }
    setChat([]); setShowChat(false)
    setAnalyzeError('')
    setAnalyzing(true)
    try {
      await startPipeline({
        docId: doc.id, fileUrl, fileName: doc.fileName || '',
        onStatus: setAnalyzeStep,
      })
      setShowChat(true)
    } catch (e) {
      setAnalyzeError(e.message)
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
      // Lấy markdown từ Firestore làm context
      let relevantText = ''
      try {
        const { doc: fsDoc, getDoc } = await import('firebase/firestore')
        const { db } = await import('../firebase')
        const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', doc.id))
        if (mdSnap.exists()) {
          const d = mdSnap.data()
          // Ưu tiên rawText (text gốc đầy đủ từ OCR/Vision, CHƯA qua bước tổng hợp AI
          // có thể gộp nhầm/làm mất các mục con riêng) — markdown chỉ dùng khi
          // rawText không có (văn bản cũ tạo trước khi có field này).
          relevantText = d.rawText || d.markdown || ''
        }
      } catch {}
      // Fallback: metadata văn bản
      if (!relevantText) {
        relevantText = [
          doc.code    ? `Số ký hiệu: ${doc.code}` : '',
          doc.date    ? `Ngày ban hành: ${doc.date}` : '',
          doc.org     ? `Cơ quan ban hành: ${doc.org}` : '',
          doc.subject ? `Nội dung: ${doc.subject}` : '',
          doc.detail  ? `Trích yếu: ${doc.detail}` : '',
        ].filter(Boolean).join('\n')
      }
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

                /* CHƯA PHÂN TÍCH LẦN NÀO */
                ) : (
                  <>
                    {analyzeError ? (
                      <div style={{ fontSize:12, color:'#b91c1c', marginBottom:10, padding:'8px 10px', background:'#fef2f2', borderRadius:8, border:'0.5px solid #fecaca' }}>
                        ❌ {analyzeError}
                      </div>
                    ) : (
                      <div style={{ fontSize:12, color:'#92400e', marginBottom:10 }}>
                        📋 <b>Tài liệu chưa được phân tích</b>
                        {hasFile && <span style={{ color:'#555', fontWeight:400 }}> — AI sẽ đọc và ghi nhớ để hỏi đáp.</span>}
                      </div>
                    )}
                    <button onClick={handleAnalyze}
                      style={{ width:'100%', padding:'9px', borderRadius:8, fontSize:13, fontWeight:600, background:'#0a2342', color:'#fff', border:'none', cursor:'pointer' }}>
                      📊 {analyzeError ? 'Tiếp tục phân tích' : 'Phân tích tài liệu'}
                    </button>
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
