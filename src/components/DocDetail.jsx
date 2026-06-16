import { useState, useRef, useEffect } from 'react'
import { useAI } from '../hooks/useAI'
import { useDocMemory } from '../hooks/useDocMemory'

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

// ── Đọc PDF scan bằng Gemini Vision (OCR) ──────────────────────
const readPDFWithGemini = async (arrayBuf, fileName, onStep) => {
  if (onStep) onStep('🔍 PDF scan — dùng Gemini OCR đọc toàn bộ...')

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
      if (onStep) onStep(`🔍 Gemini đang đọc và nhận dạng văn bản${i > 0 ? ` (key ${i+1})` : ''}...`)
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
        if (onStep) onStep(`✅ Gemini đọc xong ${text.length.toLocaleString()} ký tự`)
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

const fmtDate = (ts) => {
  if (!ts) return ''
  const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000)
  return d.toLocaleDateString('vi-VN')
}

export default function DocDetail({ doc, onEdit, onClose }) {
  if (!doc) return null

  const { analyzeDeepForMemory, askDeep, loading: aiLoading } = useAI()
  const { memory, loading: memLoading, saveMemory } = useDocMemory(doc.id)

  const [analyzing,   setAnalyzing]   = useState(false)
  const [analyzeStep, setAnalyzeStep] = useState('')
  const [countdown,   setCountdown]   = useState(0)  // giây còn lại trước khi retry
  const [showChat,    setShowChat]    = useState(false)
  const [chat,        setChat]        = useState([])
  const [chatInput,   setChatInput]   = useState('')
  const chatEndRef = useRef(null)

  useEffect(() => {
    if (showChat) setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
  }, [chat, showChat])

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

      // Bước 2: Kiểm tra cache extractedText trong Firestore
      let extractedText = memory?.extractedText || ''

      if (extractedText.length > 100) {
        setAnalyzeStep(`📚 Dùng văn bản đã lưu (${(extractedText.length/1000).toFixed(0)}K ký tự) · 🤖 AI phân tích...`)
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
              setAnalyzeStep(`⚠️ Gemini OCR lỗi: ${e.message} — dùng metadata`)
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
      } else if (e.message === 'AI_QUOTA') {
        setAnalyzeStep('⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!')
        setTimeout(() => setAnalyzeStep(''), 6000)
      } else {
        setAnalyzeStep('❌ Lỗi: ' + e.message)
        setTimeout(() => setAnalyzeStep(''), 6000)
      }
    } finally { setAnalyzing(false) }
  }

  // ── Hỏi đáp sâu dùng bộ nhớ ──
  const handleAsk = async (q) => {
    if (!q.trim() || aiLoading) return
    setChat(c => [...c, { role:'user', content:q }])
    setChatInput('')
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 50)
    try {
      const answer = await askDeep(q, memory, chat)
      setChat(c => [...c, { role:'ai', content: answer }])
    } catch(e) {
      const errMsg = e.message === 'AI_QUOTA'
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
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:'100%', maxWidth: showChat ? 760 : 560, maxHeight:'90vh', overflowY:'auto', boxShadow:'0 8px 32px rgba(0,0,0,.15)', transition:'max-width .2s' }}>

        {/* Header */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:700, color:'#1a1a1a', marginBottom:6 }}>{code || subject || '(Chưa có số ký hiệu)'}</div>
            <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:500, background:s.bg, color:s.color }}>{s.label}</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888' }}>✕</button>
        </div>

        <div style={{ display: showChat ? 'grid' : 'block', gridTemplateColumns:'1fr 1fr', gap:20 }}>
          {/* Cột trái */}
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

              {/* Vùng phân tích sâu — hiện với tất cả văn bản */}
              <div style={{ marginBottom:12, padding:'14px', borderRadius:10, background: memory ? '#f0fdf4' : '#fefce8', border:`0.5px solid ${memory ? '#bbf7d0' : '#fde68a'}` }}>
                {memLoading ? (
                  <div style={{ fontSize:12, color:'#888', textAlign:'center' }}>⏳ Đang kiểm tra bộ nhớ...</div>
                ) : memory ? (
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:8 }}>
                      <div style={{ fontSize:12, fontWeight:600, color:'#15803d' }}>
                        🧠 Đã ghi nhớ · {fmtDate(memory.analyzedAt)}
                        {memory.readChars > 500 && <span style={{ fontWeight:400, color:'#888' }}> · {(memory.readChars/1000).toFixed(0)}K ký tự</span>}
                      </div>
                      <div style={{ display:'flex', gap:6 }}>
                        <button onClick={() => setShowChat(v => !v)}
                          style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600, background:'#0a2342', color:'#fff', border:'none', cursor:'pointer' }}>
                          {showChat ? '✕ Đóng chat' : '💬 Hỏi đáp sâu'}
                        </button>
                        <button onClick={handleAnalyze} disabled={analyzing}
                          style={{ padding:'5px 10px', borderRadius:7, fontSize:11, background:'#fff', border:'0.5px solid #ddd', color:'#888', cursor:'pointer' }}
                          title="Phân tích lại">🔄</button>
                      </div>
                    </div>
                    {memory.summary && (
                      <div style={{ fontSize:12, color:'#374151', lineHeight:1.6, background:'#fff', borderRadius:8, padding:'8px 10px', border:'0.5px solid #d1fae5' }}>
                        {memory.summary.slice(0, 250)}{memory.summary.length > 250 ? '...' : ''}
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
                ) : (
                  <>
                    <div style={{ fontSize:12, color:'#92400e', marginBottom:10 }}>
                      🧠 <b>Chưa có bộ nhớ</b> — Phân tích 1 lần, hỏi đáp mãi mãi!
                      {hasFile && <span style={{ color:'#555', fontWeight:400 }}> AI sẽ đọc toàn bộ {(fileSize/1024/1024).toFixed(1)}MB file.</span>}
                    </div>
                    {analyzeStep && (
                      <div style={{ fontSize:12, color:'#1d4ed8', marginBottom:8, padding:'6px 10px', background:'#eff6ff', borderRadius:6 }}>{analyzeStep}</div>
                    )}
                    <button onClick={handleAnalyze} disabled={analyzing}
                      style={{ width:'100%', padding:'9px', borderRadius:8, fontSize:13, fontWeight:600, background: analyzing ? '#9ca3af' : '#0a2342', color:'#fff', border:'none', cursor: analyzing ? 'not-allowed' : 'pointer' }}>
                      {analyzing ? analyzeStep || '⏳ Đang phân tích...' : '🧠 Phân tích & Ghi nhớ tài liệu'}
                    </button>
                  </>
                )}
                {analyzeStep && !memLoading && memory && (
                  <div style={{ fontSize:12, color:'#1d4ed8', marginTop:8, padding:'6px 10px', background:'#eff6ff', borderRadius:6 }}>{analyzeStep}</div>
                )}
              </div>
            </div>
          </div>

          {/* Cột phải: Chat */}
          {showChat && memory && (
            <div style={{ display:'flex', flexDirection:'column', borderLeft:'0.5px solid #e5e4e0', paddingLeft:20, minHeight:400 }}>
              <div style={{ fontSize:13, fontWeight:600, color:'#0a2342', marginBottom:12 }}>💬 Hỏi đáp sâu về tài liệu</div>
              {chat.length === 0 && (
                <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
                  {[
                    'Tóm tắt toàn bộ nội dung văn bản này',
                    'Các điểm quan trọng cần lưu ý là gì?',
                    'Căn cứ pháp lý được viện dẫn?',
                    'Có rủi ro hoặc điểm bất thường gì không?',
                    memory.requirements ? 'Yêu cầu kỹ thuật cụ thể là gì?' : null,
                    memory.legalBasis ? 'Các văn bản pháp lý liên quan?' : null,
                  ].filter(Boolean).map(q => (
                    <button key={q} onClick={() => handleAsk(q)}
                      style={{ textAlign:'left', padding:'7px 10px', borderRadius:8, fontSize:12, background:'#f5f5f3', border:'0.5px solid #e5e4e0', cursor:'pointer', color:'#444' }}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ flex:1, overflowY:'auto', display:'flex', flexDirection:'column', gap:8, marginBottom:10, maxHeight:360 }}>
                {chat.map((m, i) => (
                  <div key={i} style={{ display:'flex', justifyContent: m.role==='user' ? 'flex-end' : 'flex-start' }}>
                    <div style={{ maxWidth:'90%', padding:'8px 12px', borderRadius:10, fontSize:12, lineHeight:1.6, background: m.role==='user' ? '#0a2342' : '#f0fdf4', color: m.role==='user' ? '#fff' : '#1a1a1a', border: m.role==='ai' ? '0.5px solid #bbf7d0' : 'none' }}>
                      {m.content}
                    </div>
                  </div>
                ))}
                {aiLoading && <div style={{ display:'flex' }}><div style={{ padding:'8px 12px', borderRadius:10, fontSize:12, background:'#f5f5f3', color:'#888' }}>⏳ Đang tra cứu bộ nhớ...</div></div>}
                <div ref={chatEndRef}/>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
                  placeholder="Hỏi bất kỳ điều gì về tài liệu..."
                  style={{ flex:1, padding:'8px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:12, outline:'none' }}/>
                <button onClick={() => handleAsk(chatInput)} disabled={aiLoading || !chatInput.trim()}
                  style={{ padding:'8px 14px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>▶</button>
              </div>
              {chat.length > 0 && (
                <button onClick={() => setChat([])} style={{ marginTop:6, fontSize:11, color:'#aaa', background:'none', border:'none', cursor:'pointer' }}>
                  🗑️ Xóa lịch sử chat
                </button>
              )}
            </div>
          )}
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:16, borderTop:'0.5px solid #e5e4e0', paddingTop:14 }}>
          <button onClick={onClose} style={{ padding:'8px 18px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', color:'#555', fontSize:13 }}>Đóng</button>
          <button onClick={onEdit}  style={{ padding:'8px 20px', border:'none', borderRadius:8, cursor:'pointer', background:'#1a1a1a', color:'#fff', fontSize:13, fontWeight:500 }}>✏️ Chỉnh sửa</button>
        </div>
      </div>
    </div>
  )
}
