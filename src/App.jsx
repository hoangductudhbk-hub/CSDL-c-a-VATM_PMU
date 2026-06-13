import { useState, useEffect, useRef } from 'react'
import React from 'react'
import { useAuth }        from './context/AuthContext'
import { useProjects }    from './hooks/useProjects'
import { useDocuments }   from './hooks/useDocuments'
import { useAI }          from './hooks/useAI'
import DocModal           from './components/DocModal'
import DocDetail          from './components/DocDetail'
import HistoryView        from './components/HistoryView'
import { useActivityLog } from './hooks/useActivityLog'
import { useCloudinaryStorage } from './hooks/useCloudinaryStorage'
import { UploadProvider, useUploadCtx } from './contexts/UploadContext'


// Chuẩn hoá ngày → d/m/yyyy (bỏ địa chỉ, chữ dài)
const normDate = (raw = '') => {
  if (!raw) return '—'
  // Bỏ phần địa danh trước dấu phẩy: "Hà Nội, ngày..." → "ngày..."
  let s = raw.replace(/^[^,]+,\s*/i, '').trim()
  // "ngày D tháng M năm Y" hoặc "D tháng M năm Y"
  const m1 = s.match(/(?:ngày\s*)?(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m1) return `${parseInt(m1[1])}/${parseInt(m1[2])}/${m1[3]}`
  // "tháng M năm Y"
  const m2 = s.match(/tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m2) return `${parseInt(m2[1])}/${m2[2]}`
  // "năm Y"
  const m3 = s.match(/năm\s*(\d{4})/i)
  if (m3) return m3[1]
  // Đã là dạng số d/m/y hoặc d-m-y
  const m4 = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/)
  if (m4) return `${parseInt(m4[1])}/${parseInt(m4[2])}/${m4[3].length===2?'20'+m4[3]:m4[3]}`
  // Chỉ lấy phần số nếu còn lại
  const nums = s.match(/\d+/g)
  if (nums && nums.length >= 3) return `${parseInt(nums[0])}/${parseInt(nums[1])}/${nums[2]}`
  if (nums && nums.length === 2) return `${parseInt(nums[0])}/${nums[1]}`
  return s.slice(0, 15) // cắt ngắn nếu không parse được
}

const SM = {
  done:    { label: 'Hoàn thành',       bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  pending: { label: 'Đang thực hiện',   bg: '#fffbeb', color: '#b45309', dot: '#f59e0b' },
  prep:    { label: 'Chưa thực hiện',   bg: '#f5f5f5', color: '#666',    dot: '#aaa' },
}

function SpinIcon() {
  return (
    <div style={{ width:16, height:16, border:'2.5px solid rgba(255,255,255,.3)',
      borderTopColor:'#fff', borderRadius:'50%', animation:'spin .7s linear infinite' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}

function FloatingUpload({ onOpen }) {
  const { draft, clearDraft } = useUploadCtx()
  if (!draft) return null
  const name   = draft.file?.name ?? 'file'
  const short  = name.length > 26 ? name.slice(0, 23) + '...' : name
  const isDone = !draft.loading && (draft.status || '').startsWith('✅')
  const isErr  = !draft.loading && (draft.status || '').startsWith('⚠️')
  return (
    <div style={{ position:'fixed', bottom:20, right:20, zIndex:9999,
      display:'flex', alignItems:'center', gap:10, background:'#fff', borderRadius:14,
      boxShadow:'0 4px 24px rgba(0,0,0,.18)', padding:'10px 14px', minWidth:280, maxWidth:360, border:'1px solid #eee' }}>
      <div style={{ width:34, height:34, borderRadius:8, flexShrink:0, display:'flex',
        alignItems:'center', justifyContent:'center', fontSize:14,
        background: isDone ? '#1D9E75' : isErr ? '#e74c3c' : '#1a1a1a' }}>
        {isDone ? '✅' : isErr ? '⚠️' : <SpinIcon />}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'#1a1a1a', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{short}</div>
        <div style={{ fontSize:11, color:'#888', marginTop:2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {draft.loading ? (draft.status||'').replace(/^⏳\s*/,'') || 'Đang xử lý...'
            : isDone ? 'Xong! Nhấn để xem kết quả'
            : (draft.status||'').replace(/^⚠️\s*/,'') || 'Có lỗi xảy ra'}
        </div>
      </div>
      {!draft.loading && (
        <button onClick={() => onOpen(draft.projectId)}
          style={{ flexShrink:0, padding:'5px 12px', border:'none', borderRadius:7, color:'#fff',
            cursor:'pointer', fontSize:12, fontWeight:500, background: isDone ? '#1D9E75' : '#e74c3c' }}>
          Mở
        </button>
      )}
      <button onClick={clearDraft} style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:14, padding:'2px 4px' }}>✕</button>
    </div>
  )
}

// ── KeyModal — nhiều Groq key + Gemini ───────────────────────────
function KeyModal({ onClose, saveKey }) {
  const existing = (localStorage.getItem('groq_key') || '').split(',').map(k=>k.trim()).filter(Boolean)
  const existingGem = (localStorage.getItem('gemini_key') || '').split(',').map(k=>k.trim()).filter(Boolean)
  const [groq1, setG1] = useState(existing[0] || '')
  const [groq2, setG2] = useState(existing[1] || '')
  const [groq3, setG3] = useState(existing[2] || '')
  const [gem1, setGem1] = useState(existingGem[0] || '')
  const [gem2, setGem2] = useState(existingGem[1] || '')
  const [gem3, setGem3] = useState(existingGem[2] || '')

  const save = () => {
    const groqKeys = [groq1, groq2, groq3].map(k=>k.trim()).filter(Boolean)
    localStorage.setItem('groq_key', groqKeys.join(','))
    const gemKeys = [gem1, gem2, gem3].map(k=>k.trim()).filter(Boolean)
    if (gemKeys.length) localStorage.setItem('gemini_key', gemKeys.join(','))
    onClose()
  }

  const iSt = { width:'100%', padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8,
    fontSize:12, outline:'none', boxSizing:'border-box', marginBottom:8, fontFamily:'monospace' }
  const lSt = { fontSize:12, fontWeight:600, color:'#444', display:'block', marginBottom:4, marginTop:10 }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:500, boxShadow:'0 8px 32px rgba(0,0,0,.2)', maxHeight:'90vh', overflowY:'auto' }}>
        <h3 style={{ fontSize:15, fontWeight:600, marginBottom:4 }}>⚙️ Cài API Key AI</h3>
        <p style={{ fontSize:12, color:'#888', marginBottom:8, lineHeight:1.6 }}>
          Mỗi Groq key 500K token/ngày · Mỗi Gemini key ~1M token/ngày — tất cả miễn phí
        </p>

        <label style={lSt}>🔵 Groq key #1 <span style={{ color:'#888', fontWeight:400 }}>(console.groq.com)</span></label>
        <input value={groq1} onChange={e=>setG1(e.target.value)} placeholder="gsk_..." autoFocus style={iSt}/>
        <label style={lSt}>🔵 Groq key #2</label>
        <input value={groq2} onChange={e=>setG2(e.target.value)} placeholder="gsk_..." style={iSt}/>
        <label style={lSt}>🔵 Groq key #3</label>
        <input value={groq3} onChange={e=>setG3(e.target.value)} placeholder="gsk_..." style={iSt}/>

        <div style={{ margin:'12px 0', borderTop:'0.5px solid #eee' }}/>

        <label style={lSt}>🟢 Gemini key #1 <span style={{ color:'#888', fontWeight:400 }}>(aistudio.google.com)</span></label>
        <input value={gem1} onChange={e=>setGem1(e.target.value)} placeholder="AIza..." style={iSt}/>
        <label style={lSt}>🟢 Gemini key #2</label>
        <input value={gem2} onChange={e=>setGem2(e.target.value)} placeholder="AIza..." style={iSt}/>
        <label style={lSt}>🟢 Gemini key #3</label>
        <input value={gem3} onChange={e=>setGem3(e.target.value)} placeholder="AIza..." style={{...iSt, marginBottom:16}}/>

        <div style={{ fontSize:11, color:'#15803d', background:'#f0fdf4', padding:'8px 12px', borderRadius:8, marginBottom:16 }}>
          ✅ 3 Groq + 3 Gemini → tổng ~4.5 triệu token/ngày miễn phí
        </div>

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
          <button onClick={save} style={{ padding:'8px 20px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>💾 Lưu key</button>
        </div>
      </div>
    </div>
  )
}

function StatusCell({ doc, updateDocument, admin }) {
  const SM2 = {
    done:    { label:'✅ Hoàn thành',     bg:'#f0fdf4', color:'#15803d' },
    pending: { label:'🔄 Đang thực hiện', bg:'#fffbeb', color:'#b45309' },
    prep:    { label:'⬜ Chưa thực hiện', bg:'#f5f5f5', color:'#666' },
  }
  const [editing, setEditing] = useState(false)
  const [val, setVal]         = useState(doc.status || 'prep')
  const s = SM2[doc.status || 'prep']
  if (!editing) return (
    <span onClick={() => { if(admin) { setVal(doc.status||'prep'); setEditing(true) } }}
      style={{ fontSize:11, padding:'4px 10px', borderRadius:20, background:s.bg, color:s.color,
        cursor:admin?'pointer':'default', display:'inline-flex', alignItems:'center', gap:5,
        whiteSpace:'nowrap', border:'0.5px solid '+s.color }}
      title={admin ? "Nhấn để đổi trạng thái" : ""}>
      {s.label}{admin ? ' ✎' : ''}
    </span>
  )
  const sv = SM2[val]
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <select value={val} onChange={e => setVal(e.target.value)}
        style={{ fontSize:11, padding:'4px 8px', borderRadius:20, background:sv.bg, color:sv.color,
          border:'0.5px solid '+sv.color, cursor:'pointer', outline:'none', fontWeight:500 }}>
        <option value="done">✅ Hoàn thành</option>
        <option value="pending">🔄 Đang thực hiện</option>
        <option value="prep">⬜ Chưa thực hiện</option>
      </select>
      <button onClick={() => { updateDocument(doc.id, { status: val }); setEditing(false) }}
        style={{ padding:'3px 8px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600 }}>✓</button>
      <button onClick={() => setEditing(false)}
        style={{ padding:'3px 6px', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', fontSize:11, color:'#888' }}>✕</button>
    </div>
  )
}

function AppInner() {
  const { user, loginWithGoogle, logout } = useAuth()
  const { projects, loading: pLoad, addProject, deleteProject } = useProjects(user?.uid)
  const { logLogin, logLogout, logViewDoc, logAddDoc, logEditDoc, logDeleteDoc,
          logStatus, logUploadFile, logAddProj, logDeleteProj, logExportReport } = useActivityLog(user)
  const { draft } = useUploadCtx()
  const [selProj, setSelProj] = useState('home')
  const proj = selProj === 'home' ? null : (projects.find(p => p.id === selProj) || null)
  const { docs, addDocument, updateDocument, deleteDocument } = useDocuments(proj?.id, user?.uid)
  const { deleteFile } = useCloudinaryStorage()
  const { ask, getKey, saveKey } = useAI()
  const [tab,          setTab]          = useState('docs')
  const [search,       setSearch]       = useState('')
  const [filter,       setFilter]       = useState('all')
  const [modal,        setModal]        = useState(null)
  const [editDoc,      setEditDoc]      = useState(null)
  const [detailDoc,    setDetailDoc]    = useState(null)
  const [chat,         setChat]         = useState([])
  const [chatInput,    setChatInput]    = useState('')
  const [aiLoading,    setAiLoad]       = useState(false)
  const [showAddProj,  setShowAddProj]  = useState(false)
  const [showKeyModal, setShowKeyModal] = useState(false)
  const [chatExpanded, setChatExpanded] = useState(false)
  const [loggedIn,     setLoggedIn]     = useState(false)
  const [newProjName,  setNewProjName]  = useState('')
  const [projPage,     setProjPage]     = useState(0)
  const chatEndRef = useRef(null)
  const chatBoxRef = useRef(null)

  useEffect(() => {
    if (user && !loggedIn) { logLogin(); setLoggedIn(true) }
  }, [user]) // eslint-disable-line

  const openFromDraft = (projectId) => {
    if (projectId) setSelProj(projectId)
    setEditDoc(null); setModal('add')
  }

  if (!user && user !== undefined) return <Login onLogin={loginWithGoogle} />
  if (user === undefined || pLoad) {
    return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:14, color:'#888' }}>⏳ Đang tải...</div>
  }

  const safeDocs = docs || []
  const filtered = safeDocs.filter(d => {
    const q = search.toLowerCase()
    const matchS = !q || (d.code||'').toLowerCase().includes(q) || (d.subject||'').toLowerCase().includes(q) || (d.org||'').toLowerCase().includes(q)
    return matchS && (filter === 'all' || d.status === filter)
  })
  const stats = {
    total:   safeDocs.length,
    done:    safeDocs.filter(d => d.status === 'done').length,
    pending: safeDocs.filter(d => d.status === 'pending').length,
    prep:    safeDocs.filter(d => !d.status || d.status === 'prep').length,
    urgent:  safeDocs.filter(d => d.status === 'urgent').length,
  }
  const progress = stats.total ? Math.round((stats.done / stats.total) * 100) : 0

  const handleSave = async (data, silent = false) => {
    if (editDoc) {
      await updateDocument(editDoc.id, data)
      logEditDoc(data.code||editDoc.code, data.subject||editDoc.subject, proj?.name)
    } else {
      await addDocument(data, silent)
      if (!silent) logAddDoc(data.code, data.subject, proj?.name)
    }
    if (!silent) { setModal(null); setEditDoc(null) }
  }

  const handleAsk = async (q) => {
    if (!q.trim() || aiLoading) return
    if (!getKey()) { setShowKeyModal(true); return }
    const ctx = `Dự án: ${proj?.name}\nTổng: ${stats.total} văn bản, Hoàn thành: ${stats.done}\n${safeDocs.slice(0,8).map(d => d.code+': '+d.subject+'('+d.status+')').join('; ')}`
    setChat(c => [...c, { role:'user', content:q }])
    setChatInput(''); setAiLoad(true); setChatExpanded(true)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
    try {
      const res = await ask(q, ctx)
      setChat(c => [...c, { role:'ai', content:res }])
    } catch {
      setChat(c => [...c, { role:'ai', content:'❌ Lỗi kết nối AI. Kiểm tra API key.' }])
    } finally { setAiLoad(false) }
  }

  const exportReport = () => {
    const now = new Date()
    const ngay = now.toLocaleDateString('vi-VN')
    const s2 = (n) => String(n).padStart(2,'0')
    const dd=s2(now.getDate()), mm=s2(now.getMonth()+1), yyyy=now.getFullYear()
    const hh=s2(now.getHours()), min=s2(now.getMinutes())
    const rows = safeDocs.map((d,i) => {
      const s = SM[d.status] || SM.prep
      return `<tr><td style="padding:6px 10px;border:1px solid #ddd;text-align:center">${i+1}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;font-weight:bold">${d.code||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.date||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.docType||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.subject||''}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;color:${s.color};font-weight:bold">${s.label}</td></tr>`
    }).join('')
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head><meta charset='utf-8'><style>body{font-family:'Times New Roman',serif;font-size:14pt}
    h1{font-size:16pt;font-weight:bold;text-align:center;text-transform:uppercase}
    table{border-collapse:collapse;width:100%;font-size:13pt}
    th{background:#1a1a1a;color:#fff;padding:6pt 8pt;border:1px solid #333;text-align:center}
    td{padding:5pt 8pt;border:1px solid #ccc;vertical-align:top}
    tr:nth-child(even) td{background:#f9f9f9}</style></head><body>
    <h1>BÁO CÁO TỔNG HỢP VĂN BẢN</h1><h1>DỰ ÁN: ${proj?.name||''}</h1>
    <p style="text-align:center;font-size:12pt;color:#888">Ngày xuất: ${ngay} | Tổng: ${stats.total} | Tiến độ: ${progress}%</p>
    <table><thead><tr><th style="width:4%">STT</th><th style="width:14%">Số hiệu</th><th style="width:10%">Ngày</th>
    <th style="width:11%">Loại</th><th style="width:43%">Nội dung</th><th style="width:12%">Trạng thái</th>
    </tr></thead><tbody>${rows}</tbody></table>
    <br/><p style="text-align:right;font-style:italic">Hà Nội, ngày ${ngay}</p></body></html>`
    logExportReport(proj?.name)
    const blob = new Blob(['\uFEFF' + html], { type:'application/msword;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    const pn = (proj?.name||'DuAn').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').replace(/[^a-zA-Z0-9]/g,'_').replace(/_+/g,'_')
    a.download = `BaoCao_${pn}_${dd}-${mm}-${yyyy}_${hh}h${min}.doc`
    a.click()
  }

  return (
    <div style={{ display:'flex', height:'100vh', overflow:'hidden', fontFamily:'Times New Roman,serif' }}>
      {/* Sidebar */}
      <div style={{ width:210, background:'#fff', borderRight:'0.5px solid #e5e4e0', display:'flex', flexDirection:'column', flexShrink:0, height:'100vh', overflow:'hidden' }}>
        <div style={{ padding:'16px 16px 12px', borderBottom:'0.5px solid #e5e4e0', textAlign:'center' }}>
          <img src="/vatm-logo.png" alt="VATM"
            style={{ width:72, height:72, borderRadius:'50%', objectFit:'cover', display:'block', margin:'0 auto 8px' }}/>
          <div style={{ fontSize:13, fontWeight:700, color:'#1a1a1a' }}>VATM-PMU</div>
          <div style={{ fontSize:10, color:'#888', fontWeight:600 }}>QUẢN LÝ CÁC DỰ ÁN</div>
        </div>
        <div style={{ padding:'0 8px', flex:'none' }}>
          <button onClick={() => { setSelProj('home'); setTab('docs') }}
            style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer',
              background:selProj==='home'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13,
              fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
            <span style={{ fontSize:14 }}>🏠</span> Trang chủ
          </button>
          <button onClick={() => { setSelProj('home'); setTab('about') }}
            style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer',
              background:tab==='about'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13,
              fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
            <span style={{ fontSize:14 }}>ℹ️</span> Giới thiệu
          </button>
          <button onClick={() => { setSelProj('home'); setTab('guide') }}
            style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer',
              background:tab==='guide'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13,
              fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
            <span style={{ fontSize:14 }}>📖</span> Hướng dẫn sử dụng
          </button>
          <button onClick={() => { setTab('history'); setSelProj('home') }}
            style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer',
              background:tab==='history'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13,
              fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:8 }}>
            <span style={{ fontSize:14 }}>📋</span> Lịch sử truy cập
          </button>
        </div>
        <div style={{ padding:'0 8px', borderTop:'0.5px solid #f0f0ec', marginTop:4, flex:1, overflowY:'auto' }}>
          <div style={{ fontSize:12, color:'#555', padding:'8px 8px 4px', fontWeight:800, letterSpacing:'0.05em' }}>DỰ ÁN</div>
          {(() => {
            const PAGE = 5
            const totalPages = Math.ceil(projects.length / PAGE)
            const paginated = projects.slice(projPage * PAGE, projPage * PAGE + PAGE)
            return <>
              {paginated.map(p => (
                <div key={p.id} style={{ display:'flex', alignItems:'center', borderRadius:8, marginBottom:2, background:proj?.id===p.id?'#f0f0ec':'transparent' }}>
                  <button onClick={() => { setSelProj(p.id); setTab('docs') }}
                    style={{ flex:1, textAlign:'left', padding:'8px 10px', border:'none', cursor:'pointer',
                      background:'transparent', color:'#1a1a1a', fontSize:13, fontWeight:600,
                      display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
                    <span style={{ fontSize:14, flexShrink:0 }}>📋</span>
                    <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
                  </button>
                  <button onClick={() => { if (confirm('Xóa dự án "' + p.name + '"?')) { deleteProject(p.id); logDeleteProj(p.name); if (selProj === p.id) setSelProj('home') } }}
                    title="Xóa dự án" style={{ padding:'4px 8px', background:'none', border:'none', cursor:'pointer', color:'#ccc', fontSize:12, flexShrink:0 }}>✕</button>
                </div>
              ))}
              {totalPages > 1 && (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'4px 8px', marginTop:4 }}>
                  <button onClick={() => setProjPage(p => Math.max(0, p-1))} disabled={projPage===0}
                    style={{ fontSize:11, padding:'3px 8px', border:'0.5px solid #ddd', borderRadius:6, cursor:projPage===0?'not-allowed':'pointer', background:'#fff', color:projPage===0?'#ccc':'#555' }}>← Trước</button>
                  <span style={{ fontSize:10, color:'#aaa' }}>{projPage+1}/{totalPages}</span>
                  <button onClick={() => setProjPage(p => Math.min(totalPages-1, p+1))} disabled={projPage===totalPages-1}
                    style={{ fontSize:11, padding:'3px 8px', border:'0.5px solid #ddd', borderRadius:6, cursor:projPage===totalPages-1?'not-allowed':'pointer', background:'#fff', color:projPage===totalPages-1?'#ccc':'#555' }}>Tiếp →</button>
                </div>
              )}
              <button onClick={() => setShowAddProj(true)}
                style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', background:'transparent', color:'#888', fontSize:12, marginTop:4, fontWeight:600 }}>
                + Thêm dự án
              </button>
            </>
          })()}
        </div>
        <div style={{ padding:'12px 16px', borderTop:'0.5px solid #e5e4e0', flexShrink:0, background:'#fff' }}>

          <div style={{ fontSize:12, fontWeight:700 }}>{user?.displayName||'Người dùng'}</div>
          <div style={{ fontSize:11, color:'#888', marginBottom:8, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', fontWeight:600 }}>{user?.email}</div>
          <button onClick={() => { logLogout().then(() => logout()) }}
            style={{ fontSize:11, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', padding:'4px 10px' }}>Đăng xuất</button>
        </div>
      </div>

      {/* Main */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {!proj && tab !== 'history' && tab !== 'about' && tab !== 'guide' && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:48, background:'linear-gradient(135deg, #e8f4fd 0%, #bdd9f0 100%)' }}>
            <img src="/vatm-logo.png" alt="VATM" style={{ width:200, height:200, borderRadius:'50%', objectFit:'cover', marginBottom:24 }}/>
            <h2 style={{ fontSize:36, fontWeight:700, color:'#0a2342', marginBottom:12 }}>Chào mừng đến VATM-PMU</h2>
            <p style={{ fontSize:18, color:'#1a5490', textAlign:'center', maxWidth:500 }}>Chọn dự án ở thanh công cụ bên trái để xem và quản lý.</p>
          </div>
        )}
        {tab === 'history' && <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}><HistoryView user={user}/></div>}

        {tab === 'about' && (
          <div style={{ flex:1, position:'relative', display:'flex', alignItems:'center', justifyContent:'center', padding:48, background:'linear-gradient(135deg, #e8f4fd 0%, #bdd9f0 100%)' }}>
            <div style={{ textAlign:'center' }}>
              <img src="/vatm-logo.png" alt="VATM" style={{ width:200, height:200, borderRadius:'50%', objectFit:'cover', marginBottom:24 }}/>
              <h2 style={{ fontSize:40, fontWeight:700, color:'#0a2342', marginBottom:12 }}>VATM-PMU</h2>
              <p style={{ fontSize:18, color:'#1a5490', lineHeight:1.8 }}>
                Phần mềm Quản lý Văn bản & Dự án<br/>
                Ban Quản lý dự án chuyên ngành Quản lý bay
              </p>
            </div>
            <div style={{ position:'absolute', bottom:24, right:32, textAlign:'right', fontSize:12, color:'#5b8ab5', lineHeight:1.8 }}>
              <div>✉️ Người phát triển</div>
              <div style={{ fontWeight:700, color:'#0a2342', fontSize:13 }}>hoangductudhbk@gmail.com</div>
            </div>
          </div>
        )}

                        {tab === 'guide' && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding:'12px 24px 8px', borderBottom:'0.5px solid #e5e4e0', background:'#fff', flexShrink:0 }}>
              <h2 style={{ fontSize:18, fontWeight:700, margin:0 }}>📖 Hướng dẫn sử dụng</h2>
            </div>
            <div style={{ flex:1, display:'flex', gap:10, padding:'12px 16px', overflow:'hidden' }}>
              <div style={{ flex:1 }}>
                {[
                  { icon:'1️⃣', title:'Đăng nhập', lines:['Nhấn "Đăng nhập bằng Google" và chọn tài khoản Google.','Dữ liệu được đồng bộ tự động trên mọi thiết bị.'] },
                  { icon:'2️⃣', title:'Tạo dự án', lines:['Nhấn "+ Thêm dự án" ở sidebar bên trái.','Nhập tên dự án → nhấn "Thêm".','Mỗi dự án chứa các văn bản pháp lý riêng biệt.'] },
                  { icon:'3️⃣', title:'Thêm văn bản bằng AI', lines:['Chọn dự án → nhấn "+ Thêm văn bản" góc trên phải.','Chọn "✨ AI tự điền" → kéo thả hoặc nhấn chọn file PDF/Word.','AI tự đọc nội dung và điền đầy đủ thông tin.','Kiểm tra lại thông tin rồi nhấn "Lưu văn bản".'] },
                  { icon:'4️⃣', title:'Upload nhiều file cùng lúc', lines:['Trong tab AI tự điền → nhấn chọn file.','Giữ Ctrl và click để chọn nhiều file.','App xử lý và lưu từng văn bản tự động.'] },
                  { icon:'5️⃣', title:'Nhập thủ công', lines:['Chọn "✏️ Nhập thủ công" nếu không có file.','Điền đầy đủ các trường: số ký hiệu, ngày, cơ quan, nội dung.','Nhấn "Lưu văn bản" khi hoàn thành.'] },
                ].map(({ icon, title, lines }) => (
                  <div key={title} style={{ display:'flex', gap:10, padding:'10px 12px', background:'#fff', borderRadius:10, border:'0.5px solid #e5e4e0', marginBottom:8 }}>
                    <div style={{ fontSize:18, flexShrink:0 }}>{icon}</div>
                    <div>
                      <div style={{ fontWeight:700, fontSize:12, color:'#1a1a1a', marginBottom:3 }}>{title}</div>
                      {lines.map((l, i) => <div key={i} style={{ fontSize:11, color:'#555', lineHeight:1.6 }}>{'• ' + l}</div>)}
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ flex:1 }}>
                {[
                  { icon:'6️⃣', title:'Xem & tải văn bản', lines:['Click vào bất kỳ hàng nào trong bảng để xem chi tiết.','Nếu văn bản có file đính kèm sẽ thấy nút "📥 Tải về".','Nhấn "✏️ Chỉnh sửa" để cập nhật thông tin.'] },
                  { icon:'7️⃣', title:'Đổi trạng thái', lines:['Trong bảng danh sách, click vào ô trạng thái.','Chọn: Hoàn thành / Đang thực hiện / Chưa thực hiện.','Nhấn ✓ để xác nhận, không cần mở chi tiết.'] },
                  { icon:'8️⃣', title:'Tìm kiếm', lines:['Dùng ô tìm kiếm phía trên bảng để lọc văn bản.','Tìm theo số ký hiệu, nội dung hoặc cơ quan ban hành.','Kết hợp với bộ lọc trạng thái để thu hẹp kết quả.'] },
                  { icon:'9️⃣', title:'Xuất báo cáo Word', lines:['Vào tab "Xuất báo cáo".','Nhấn "📥 Tải báo cáo Word" để tải file .doc.','File báo cáo gồm toàn bộ văn bản trong dự án.'] },
                ].map(({ icon, title, lines }) => (
                  <div key={title} style={{ display:'flex', gap:10, padding:'10px 12px', background:'#fff', borderRadius:10, border:'0.5px solid #e5e4e0', marginBottom:8 }}>
                    <div style={{ fontSize:18, flexShrink:0 }}>{icon}</div>
                    <div>
                      <div style={{ fontWeight:700, fontSize:12, color:'#1a1a1a', marginBottom:3 }}>{title}</div>
                      {lines.map((l, i) => <div key={i} style={{ fontSize:11, color:'#555', lineHeight:1.6 }}>{'• ' + l}</div>)}
                    </div>
                  </div>
                ))}
                <div style={{ padding:'10px 12px', background:'#f0fdf4', borderRadius:10, border:'0.5px solid #bbf7d0', fontSize:11, color:'#15803d', lineHeight:1.6 }}>
                  <strong>💡 Lưu ý:</strong> Các nền tảng tạo lên trang web sử dụng các công cụ miễn phí. Ứng dụng vẫn đang trong quá trình phát triển nên còn nhiều hạn chế. Mọi ý kiến đóng góp xin liên hệ <strong>hoangductudhbk@gmail.com</strong>
                </div>
              </div>
            </div>
          </div>
        )}

        {proj && tab !== 'history' && <>
          <div style={{ padding:'16px 24px 12px', borderBottom:'0.5px solid #e5e4e0', background:'#fff', display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div style={{ fontSize:17, fontWeight:700 }}>{proj?.name}</div>
            <button onClick={() => { setEditDoc(null); setModal('add') }}
              style={{ padding:'8px 16px', background:'#fff', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', fontSize:13 }}>+ Thêm văn bản</button>
          </div>
          <div style={{ padding:'12px 24px', background:'#fff', borderBottom:'0.5px solid #e5e4e0', display:'flex', gap:12 }}>
            {[['Tổng văn bản',stats.total,'#1a1a1a'],['Hoàn thành',stats.done,'#15803d'],['Đang thực hiện',stats.pending,'#b45309'],['Chưa thực hiện',stats.prep,'#888']].map(([l,v,c]) => (
              <div key={l} style={{ flex:1, padding:'10px 14px', background:'#fafaf8', borderRadius:10, border:'0.5px solid #e5e4e0' }}>
                <div style={{ fontSize:11, color:'#888', marginBottom:2 }}>{l}</div>
                <div style={{ fontSize:18, fontWeight:700, color:c }}>{v}</div>
              </div>
            ))}
            <div style={{ flex:2, padding:'10px 14px', background:'#fafaf8', borderRadius:10, border:'0.5px solid #e5e4e0' }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#888', marginBottom:6 }}>
                <span>Tỷ lệ hoàn thành</span><span style={{ fontWeight:600, color:'#1a1a1a' }}>{progress}%</span>
              </div>
              <div style={{ height:8, background:'#e5e4e0', borderRadius:4, overflow:'hidden' }}>
                <div style={{ height:'100%', width:progress+'%', background:'#22c55e', borderRadius:4, transition:'width .3s' }}/>
              </div>
            </div>
          </div>
          <div style={{ padding:'0 24px', background:'#fff', borderBottom:'0.5px solid #e5e4e0', display:'flex' }}>
            {[['docs','Văn bản'],['progress','Tiến độ pháp lý'],['report','Xuất báo cáo']].map(([v,l]) => (
              <button key={v} onClick={() => setTab(v)}
                style={{ padding:'12px 16px', border:'none', borderBottom:tab===v?'2px solid #1a1a1a':'2px solid transparent',
                  background:'transparent', cursor:'pointer', fontSize:13, fontWeight:tab===v?600:400, color:tab===v?'#1a1a1a':'#888' }}>{l}</button>
            ))}
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
            {tab === 'docs' && (
              <div>
                <div style={{ display:'flex', gap:10, marginBottom:16 }}>
                  <div style={{ flex:1, position:'relative' }}>
                    <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'#aaa' }}>🔍</span>
                    <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm văn bản..."
                      style={{ width:'100%', padding:'9px 12px 9px 36px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box' }}/>
                  </div>
                  <select value={filter} onChange={e => setFilter(e.target.value)}
                    style={{ padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', background:'#fff' }}>
                    <option value="all">Tất cả trạng thái</option>
                    <option value="done">Hoàn thành</option>
                    <option value="pending">Đang thực hiện</option>
                    <option value="prep">Chưa thực hiện</option>
                  </select>
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ borderBottom:'0.5px solid #e5e4e0' }}>
                      {['Số hiệu văn bản','Ngày','Loại','Nội dung / Về việc','Trạng thái',''].map(h => (
                        <th key={h} style={{ textAlign:'left', padding:'8px 12px', fontSize:11, color:'#888', fontWeight:500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && <tr><td colSpan={6} style={{ padding:'40px', textAlign:'center', color:'#888', fontSize:13 }}>Chưa có văn bản nào</td></tr>}
                    {filtered.map(d => {
                      const s = SM[d.status] || SM.prep
                      return (
                        <tr key={d.id} onClick={() => { setDetailDoc(d); logViewDoc(d.code, d.subject, proj?.name) }}
                          style={{ borderBottom:'0.5px solid #f0f0ec', cursor:'pointer' }}
                          onMouseEnter={e => e.currentTarget.style.background='#fafaf8'}
                          onMouseLeave={e => e.currentTarget.style.background=''}>
                          <td style={{ padding:'10px 12px', fontSize:13, fontWeight:600, whiteSpace:'nowrap' }}>{d.code||'—'}</td>
                          <td style={{ padding:'10px 12px', fontSize:12, color:'#888', whiteSpace:'nowrap' }}>{normDate(d.date)}</td>
                          <td style={{ padding:'10px 12px' }}><span style={{ fontSize:11, padding:'3px 8px', borderRadius:12, background:'#f0f0ec', color:'#555' }}>{d.docType||'Khác'}</span></td>
                          <td style={{ padding:'10px 12px', fontSize:13, maxWidth:320 }}>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block' }}>{d.subject||''}</span>
                            {(d.fileUrl||d.downloadUrl) && <span style={{ fontSize:10, color:'#22c55e' }}>✦ Có file</span>}
                          </td>
                          <td style={{ padding:'6px 12px' }} onClick={e => e.stopPropagation()}>
                            <StatusCell doc={d} updateDocument={updateDocument} admin={true}/>
                          </td>
                          <td style={{ padding:'10px 8px', whiteSpace:'nowrap' }} onClick={e => e.stopPropagation()}>
                            <button onClick={() => { setEditDoc(d); setModal('edit') }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, padding:'2px 6px', color:'#888' }}>✏️</button>
                            <button onClick={() => { if(confirm('Xóa văn bản này?')) { deleteFile(d); deleteDocument(d.id); logDeleteDoc(d.code, d.subject, proj?.name) } }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, padding:'2px 6px', color:'#e53e3e' }}>🗑️</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'progress' && (
              <div style={{ maxWidth:700 }}>
                <h3 style={{ fontSize:15, fontWeight:600, marginBottom:16 }}>Tiến độ pháp lý — {proj?.name}</h3>
                {[['Giai đoạn 1','Chủ trương & số liệu đầu vào',['Phê duyệt chủ trương đầu tư','Khảo sát địa hình','Lập báo cáo đánh giá hiện trạng']],['Giai đoạn 2','Lập & phê duyệt QH 1/500',['Lập quy hoạch 1/500','Thẩm định quy hoạch','Phê duyệt quy hoạch']],['Giai đoạn 3','Lập dự án đầu tư',['Lập báo cáo kinh tế kỹ thuật','Thẩm định dự án','Phê duyệt dự án']]].map(([phase, desc, items]) => (
                  <div key={phase} style={{ marginBottom:16, padding:'16px', background:'#fff', border:'0.5px solid #e5e4e0', borderRadius:12 }}>
                    <div style={{ fontWeight:600, marginBottom:4 }}>{phase}</div>
                    <div style={{ fontSize:12, color:'#888', marginBottom:12 }}>{desc}</div>
                    {items.map(item => {
                      const related = safeDocs.find(d => (d.subject||'').toLowerCase().includes(item.split(' ').slice(0,3).join(' ').toLowerCase()))
                      return (
                        <div key={item} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 0', borderBottom:'0.5px solid #f0f0ec' }}>
                          <span style={{ fontSize:16 }}>{related ? '✅' : '⬜'}</span>
                          <span style={{ fontSize:13, flex:1 }}>{item}</span>
                          {related && <span style={{ fontSize:11, color:'#15803d' }}>{related.code}</span>}
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )}
            {tab === 'report' && (
              <div style={{ maxWidth:600 }}>
                <div style={{ padding:'20px', background:'#fff', border:'0.5px solid #e5e4e0', borderRadius:12 }}>
                  <p style={{ fontSize:13, color:'#555', marginBottom:16 }}>Xuất báo cáo tổng hợp dự án <strong>{proj?.name}</strong> ({stats.total} văn bản, tiến độ {progress}%).</p>
                  <button onClick={exportReport} style={{ padding:'10px 20px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:500 }}>📥 Tải báo cáo Word (.doc)</button>
                </div>
              </div>
            )}
          </div>
        </>}

        {/* AI Chat — chỉ hiện khi đang trong dự án */}
        {proj &&
        <div style={{ borderTop:'0.5px solid #e5e4e0', background:'#fff', flexShrink:0, display:'flex', flexDirection:'column', maxHeight:'40vh' }}>
          {/* Header cố định */}
          <div style={{ padding:'8px 24px 0', flexShrink:0 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6, flexWrap:'wrap' }}>
              <span style={{ fontSize:12, color:'#888' }}>✨ Trợ lý AI</span>
              {user?.email === 'hoangductudhbk@gmail.com' && <>
                <span style={{ fontSize:11, padding:'2px 8px', background:'#f0fdf4', color:'#15803d', borderRadius:20, border:'0.5px solid #bbf7d0' }}>AI · Tự động xoay vòng</span>
                <button onClick={() => setShowKeyModal(true)}
                  style={{ fontSize:11, padding:'3px 10px', background:getKey()?'#f0fdf4':'#fef2f2',
                    border:getKey()?'0.5px solid #bbf7d0':'0.5px solid #fecaca', borderRadius:6, cursor:'pointer',
                    color:getKey()?'#15803d':'#b91c1c', fontWeight:600 }}>
                  {getKey() ? '✅ Đã có key AI' : '⚠️ Chưa có key — nhấn để cài'}
                </button>
              </>}
              {chat.length > 0 && (
                <button onClick={() => setChat([])} style={{ fontSize:11, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', padding:'2px 8px', marginLeft:'auto' }}>🗑️ Xóa chat</button>
              )}
            </div>
            <div style={{ display:'flex', gap:6, marginBottom:6, flexWrap:'wrap' }}>
              {[['📋 Tóm tắt pháp lý','Tóm tắt tình trạng pháp lý hiện tại của dự án'],['🔴 Việc cần gấp','Liệt kê các văn bản cần xử lý gấp'],['📊 Tạo báo cáo','Tạo báo cáo tình trạng dự án'],['⚠️ Rủi ro','Phân tích rủi ro pháp lý dự án']].map(([l,q]) => (
                <button key={l} onClick={() => handleAsk(q)} style={{ fontSize:11, padding:'5px 10px', background:'#f5f5f3', border:'0.5px solid #e5e4e0', borderRadius:20, cursor:'pointer', color:'#555' }}>{l}</button>
              ))}
            </div>
          </div>
          {/* Vùng tin nhắn — chỉ phần này cuộn */}
          {chat.length > 0 && (
            <div ref={chatBoxRef} style={{ flex:1, overflowY:'auto', padding:'0 24px 6px', display:'flex', flexDirection:'column', gap:6 }}>
              {chat.map((m,i) => (
                <div key={i} style={{ display:'flex', justifyContent:m.role==='user'?'flex-end':'flex-start' }}>
                  <div style={{ maxWidth:'80%', padding:'8px 12px', borderRadius:10, fontSize:12, lineHeight:1.5, background:m.role==='user'?'#1a1a1a':'#f5f5f3', color:m.role==='user'?'#fff':'#1a1a1a' }}>
                    {m.role === 'ai' ? m.content.replace(/^[•\-\+\*] /gm,'▸ ').split('\n').filter(l=>l.trim()).map((line,i) => <div key={i} style={{marginBottom:line.startsWith('▸')?4:2}}>{line}</div>) : m.content}
                  </div>
                </div>
              ))}
              {aiLoading && <div style={{ display:'flex' }}><div style={{ padding:'8px 12px', borderRadius:10, fontSize:12, background:'#f5f5f3', color:'#888' }}>⏳ Đang trả lời...</div></div>}
              <div ref={chatEndRef}/>
            </div>
          )}
          {/* Input cố định */}
          <div style={{ padding:'6px 24px 10px', flexShrink:0 }}>
            <div style={{ display:'flex', gap:8 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
                placeholder="Hỏi về dự án... (Enter để gửi)"
                style={{ flex:1, padding:'9px 14px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none' }}/>
              <button onClick={() => handleAsk(chatInput)} disabled={aiLoading||!chatInput.trim()}
                style={{ padding:'9px 16px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>▶</button>
            </div>
          </div>
        </div>}
      </div>

      {/* Modals */}
      {(modal==='add'||modal==='edit') && (
        <DocModal project={proj} doc={editDoc} onSave={handleSave} onClose={() => { setModal(null); setEditDoc(null) }}/>
      )}
      {detailDoc && (
        <DocDetail doc={detailDoc} onEdit={() => { setEditDoc(detailDoc); setDetailDoc(null); setModal('edit') }} onClose={() => setDetailDoc(null)}/>
      )}
      {showAddProj && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}>
          <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:400, boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>
            <h3 style={{ fontSize:15, fontWeight:600, marginBottom:16 }}>Thêm dự án mới</h3>
            <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="Tên dự án" autoFocus
              style={{ width:'100%', padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', marginBottom:12, boxSizing:'border-box' }}/>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowAddProj(false)} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
              <button onClick={async () => {
                if (newProjName.trim()) {
                  await addProject({ name:newProjName.trim(), code:'', budget:'Đang lập', period:'2026–2030', address:'' })
                  logAddProj(newProjName.trim()); setNewProjName(''); setShowAddProj(false)
                }
              }} style={{ padding:'8px 16px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>Thêm</button>
            </div>
          </div>
        </div>
      )}
      {showKeyModal && <KeyModal onClose={() => setShowKeyModal(false)} saveKey={saveKey}/>}
      <FloatingUpload onOpen={openFromDraft}/>
    </div>
  )
}

export default function App() {
  return <UploadProvider><AppInner /></UploadProvider>
}

function Login({ onLogin }) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', background:'#f5f5f3' }}>
      <div style={{ background:'#fff', borderRadius:20, padding:'48px 40px', textAlign:'center', boxShadow:'0 8px 32px rgba(0,0,0,.1)', maxWidth:380, width:'90%' }}>
        <div style={{ fontSize:48, marginBottom:12 }}>✈️</div>
        <h1 style={{ fontSize:20, fontWeight:700, marginBottom:4 }}>VATM-PMU</h1>
        <p style={{ fontSize:13, color:'#888', marginBottom:32 }}>Phần mềm quản lý dự án thông minh AI</p>
        <button onClick={onLogin} style={{ width:'100%', padding:'12px 20px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:10, cursor:'pointer', fontSize:14, fontWeight:600 }}>Đăng nhập bằng Google</button>
        <p style={{ fontSize:11, color:'#aaa', marginTop:16 }}>Dữ liệu được đồng bộ trên mọi thiết bị</p>
      </div>
    </div>
  )
}
