import { useState, useEffect, useRef } from 'react'
import React from 'react'
import { collection, query, where, getDocs, getDoc, updateDoc, doc as fsDoc } from 'firebase/firestore'
import { db } from './firebase'
import * as XLSX from 'xlsx'

// Dự án cũ chưa có field category → suy luận theo tên để không mất dữ liệu
const getCategory = (p) => {
  if (p.category) return p.category
  if (/quy định|quy trình/i.test(p.name)) return 'regulation'
  if (/biểu mẫu/i.test(p.name)) return 'form'
  return 'project'
}
const subItemLabel = (catKey) =>
  catKey === 'regulation' ? '+ Thêm văn bản' : catKey === 'form' ? '+ Thêm mục' : '+ Thêm gói thầu'
const subItemModalTitle = (catKey) =>
  catKey === 'regulation' ? '📄 Thêm văn bản' : catKey === 'form' ? '🗂 Thêm mục' : '📁 Thêm gói thầu'

import { useAuth }        from './context/AuthContext'
import { useProjects }    from './hooks/useProjects'
import { useDocuments }   from './hooks/useDocuments'
import { usePackages }    from './hooks/usePackages'
import { useAI }          from './hooks/useAI'
import { useMonthlyReport } from './hooks/useMonthlyReport'
import DocModal           from './components/DocModal'
import DocDetail          from './components/DocDetail'
import HistoryView        from './components/HistoryView'
import AdminUsers         from './components/AdminUsers'
import LoginRegister      from './components/LoginRegister'
import ChangePassword     from './components/ChangePassword'
import { useActivityLog } from './hooks/useActivityLog'
import { useCloudinaryStorage } from './hooks/useCloudinaryStorage'
import { UploadProvider, useUploadCtx } from './contexts/UploadContext'

const pad2 = (n) => String(n).padStart(2, '0')

const normDate = (raw = '') => {
  if (!raw) return '—'
  let s = raw.replace(/^[^,]+,\s*/i, '').trim()
  const m1 = s.match(/(?:ngày\s*)?(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m1) return `${pad2(m1[1])}/${pad2(m1[2])}/${m1[3]}`
  const m2 = s.match(/tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m2) return `${pad2(m2[1])}/${m2[2]}`
  const m3 = s.match(/năm\s*(\d{4})/i)
  if (m3) return m3[1]
  const m4 = s.match(/(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/)
  if (m4) return `${pad2(m4[1])}/${pad2(m4[2])}/${m4[3].length===2?'20'+m4[3]:m4[3]}`
  const nums = s.match(/\d+/g)
  if (nums && nums.length >= 3) return `${pad2(nums[0])}/${pad2(nums[1])}/${nums[2]}`
  if (nums && nums.length === 2) return `${pad2(nums[0])}/${nums[1]}`
  return s.slice(0, 15)
}

const SM = {
  done:    { label: 'Hoàn thành',     bg: '#f0fdf4', color: '#15803d', dot: '#22c55e' },
  pending: { label: 'Đang thực hiện', bg: '#fffbeb', color: '#b45309', dot: '#f59e0b' },
  prep:    { label: 'Chưa thực hiện', bg: '#f5f5f5', color: '#666',    dot: '#aaa' },
}

const fmtSize = (bytes) => {
  if (!bytes) return ''
  if (bytes >= 1024*1024) return ` · ${(bytes/1024/1024).toFixed(1)}MB`
  return ` · ${(bytes/1024).toFixed(0)}KB`
}

function SpinIcon() {
  return (
    <div style={{ width:16, height:16, border:'2.5px solid rgba(255,255,255,.3)',
      borderTopColor:'#fff', borderRadius:'50%', animation:'spin .7s linear infinite' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}

function PendingScreen({ userDoc, logout }) {
  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#e8f4fd 0%,#bdd9f0 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:24, padding:'48px 40px', textAlign:'center', boxShadow:'0 16px 48px rgba(0,0,0,.12)', maxWidth:440, width:'90%' }}>
        <div style={{ fontSize:56, marginBottom:16 }}>⏳</div>
        <h2 style={{ fontSize:20, fontWeight:700, marginBottom:8, color:'#0a2342' }}>Đang chờ phê duyệt</h2>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.8, marginBottom:16 }}>
          Tài khoản <strong>@{userDoc?.username}</strong> đã đăng ký thành công.<br/>
          Quản trị viên sẽ xét duyệt trong thời gian sớm nhất.
        </p>
        <div style={{ background:'#f9fafb', borderRadius:12, padding:'14px 18px', marginBottom:8, border:'0.5px solid #e5e7eb', textAlign:'left' }}>
          <div style={{ fontSize:12, color:'#888', marginBottom:4 }}>Thông tin đăng ký</div>
          <div style={{ fontSize:14, fontWeight:600, color:'#0a2342' }}>{userDoc?.name || '—'}</div>
          <div style={{ fontSize:12, color:'#555' }}>{userDoc?.unit || '—'}</div>
        </div>
        <div style={{ background:'#fef9c3', borderRadius:12, padding:'12px 16px', marginBottom:24, border:'0.5px solid #fde047', fontSize:12, color:'#854d0e' }}>
          📧 Liên hệ nhanh: <strong>hoangductudhbk@gmail.com</strong>
        </div>
        <button onClick={logout} style={{ fontSize:12, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', padding:'8px 20px' }}>Đăng xuất</button>
      </div>
    </div>
  )
}

function RejectedScreen({ userDoc, logout }) {
  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#fde8e8 0%,#fecaca 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:24, padding:'48px 40px', textAlign:'center', boxShadow:'0 16px 48px rgba(0,0,0,.12)', maxWidth:440, width:'90%' }}>
        <div style={{ fontSize:56, marginBottom:16 }}>❌</div>
        <h2 style={{ fontSize:20, fontWeight:700, marginBottom:8, color:'#991b1b' }}>Tài khoản bị từ chối</h2>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.8, marginBottom:24 }}>
          Tài khoản <strong>@{userDoc?.username}</strong> không được cấp quyền truy cập.<br/>
          Vui lòng liên hệ quản trị viên để biết thêm thông tin.
        </p>
        <a href="mailto:hoangductudhbk@gmail.com" style={{ display:'block', fontSize:13, color:'#2563eb', marginBottom:24, textDecoration:'none' }}>
          📧 hoangductudhbk@gmail.com
        </a>
        <button onClick={logout} style={{ fontSize:12, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', padding:'8px 20px' }}>Đăng xuất</button>
      </div>
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
    <div style={{ position:'fixed', bottom:20, right:20, zIndex:9999, display:'flex', alignItems:'center', gap:10, background:'#fff', borderRadius:14, boxShadow:'0 4px 24px rgba(0,0,0,.18)', padding:'10px 14px', minWidth:280, maxWidth:360, border:'1px solid #eee' }}>
      <div style={{ width:34, height:34, borderRadius:8, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, background: isDone ? '#1D9E75' : isErr ? '#e74c3c' : '#1a1a1a' }}>
        {isDone ? '✅' : isErr ? '⚠️' : <SpinIcon />}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:13, fontWeight:600, color:'#1a1a1a', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{short}</div>
        <div style={{ fontSize:11, color:'#888', marginTop:2, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
          {draft.loading ? (draft.status||'').replace(/^⏳\s*/,'') || 'Đang xử lý...' : isDone ? 'Xong! Nhấn để xem kết quả' : (draft.status||'').replace(/^⚠️\s*/,'') || 'Có lỗi xảy ra'}
        </div>
      </div>
      {!draft.loading && (
        <button onClick={() => onOpen(draft.projectId)} style={{ flexShrink:0, padding:'5px 12px', border:'none', borderRadius:7, color:'#fff', cursor:'pointer', fontSize:12, fontWeight:500, background: isDone ? '#1D9E75' : '#e74c3c' }}>Mở</button>
      )}
      <button onClick={clearDraft} style={{ flexShrink:0, background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:14, padding:'2px 4px' }}>✕</button>
    </div>
  )
}

function KeyModal({ onClose }) {
  // Keys được quản lý trên Vercel (Settings → Environment Variables), không lưu ở browser.
  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.5)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:9999 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:460, boxShadow:'0 8px 32px rgba(0,0,0,.2)' }}>
        <h3 style={{ fontSize:15, fontWeight:600, marginBottom:8 }}>⚙️ Cài đặt API Key AI</h3>
        <p style={{ fontSize:13, color:'#555', lineHeight:1.6, marginBottom:16 }}>
          API key được lưu an toàn trên server (Vercel), không lưu trong trình duyệt.<br/>
          Để cập nhật key mới, vào <b>Vercel → Settings → Environment Variables</b> và điền:
        </p>
        <ul style={{ fontSize:12, color:'#444', lineHeight:2, paddingLeft:20, marginBottom:16 }}>
          <li><code>GROQ_API_KEY</code> — lấy tại <a href="https://console.groq.com" target="_blank" rel="noreferrer">console.groq.com</a></li>
          <li><code>GROQ_API_KEY_2</code>, <code>GROQ_API_KEY_3</code> (tùy chọn, dự phòng)</li>
          <li><code>GEMINI_API_KEY</code> — lấy tại <a href="https://aistudio.google.com" target="_blank" rel="noreferrer">aistudio.google.com</a></li>
        </ul>
        <div style={{ display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onClose} style={{ padding:'8px 20px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>Đóng</button>
        </div>
      </div>
    </div>
  )
}

// Mục I "Thông tin chung dự án" trong Báo cáo đầu tư hầu như không đổi suốt đời
// dự án (tổng mức đầu tư, nguồn vốn, người quyết định đầu tư...) — nhập 1 lần ở
// đây, sửa được bất cứ lúc nào. useMonthlyReport.js sẽ lấy đúng các trường đã
// điền ở đây ĐÈ LÊN kết quả AI tự dò từ văn bản (đáng tin hơn, không tốn quota,
// không rủi ro AI đọc lẫn/bịa số liệu như đã gặp thực tế).
// Đọc trực tiếp 1 file Word/PDF/TXT được đính kèm (KHÔNG qua bộ nhớ AI đã phân
// tích của dự án) — dùng cho "📎 Nạp thông tin" trong InvestmentInfoModal, vì
// Tony muốn đính kèm ĐÚNG 1 văn bản có sẵn các trường Mục I (vd: file mẫu báo
// cáo gửi ban KHĐT) để lấy chính xác, không phụ thuộc văn bản đó đã được "Phân
// tích sâu" trong dự án hay chưa — tránh thiếu sót đã gặp với "✨ AI tự điền".
const loadScript = (src, check) => new Promise((res, rej) => {
  if (check()) { res(); return }
  const s = document.createElement('script')
  s.src = src; s.onload = res; s.onerror = rej
  document.head.appendChild(s)
})

const extractDocxTextForInfo = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js', () => window.mammoth)
  return (await window.mammoth.extractRawText({ arrayBuffer: buf })).value
}

const loadPdfJsForInfo = () => new Promise((res, rej) => {
  if (window.pdfjsLib) { res(window.pdfjsLib); return }
  const s = document.createElement('script')
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'; res(window.pdfjsLib) }
  s.onerror = rej
  document.head.appendChild(s)
})

const extractPdfTextForInfo = async (buf) => {
  const lib = await loadPdfJsForInfo()
  const pdf = await lib.getDocument({ data: buf }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map(it => it.str).join(' ') + '\n'
  }
  return text.trim()
}

const bufToBase64 = (buf) => {
  const bytes = new Uint8Array(buf)
  let binary = ''
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// .doc (OLE binary cũ) — mammoth chỉ đọc được .docx, nên .doc phải xử lý qua
// server bằng word-extractor (api/misc.js action='extract-doc' — gộp chung
// với lookup-user vào 1 file để không vượt giới hạn 12 Serverless Functions
// của Vercel Hobby).
const extractDocViaServer = async (buf) => {
  const res = await fetch('/api/misc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'extract-doc', base64: bufToBase64(buf) }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Lỗi server (${res.status})`)
  return data.text || ''
}

// PDF scan (không có lớp chữ) — pdf.js không đọc được gì, fallback gửi nguyên
// file cho Gemini qua /api/gemini-proxy (cùng cách DocDetail.jsx đang dùng để
// OCR PDF scan) — Gemini đọc trực tiếp ảnh các trang PDF, không cần convert.
const ocrPdfViaGemini = async (buf, fileName) => {
  const parts = [
    { inline_data: { mime_type: 'application/pdf', data: bufToBase64(buf) } },
    { text: `Trích xuất TOÀN BỘ nội dung văn bản nhìn thấy trong file PDF này (tên file: ${fileName}). Giữ nguyên 100% số liệu, ngày, tên, số hiệu văn bản — không tóm tắt, chỉ trả về nội dung văn bản thuần túy.` },
  ]
  const res = await fetch('/api/gemini-proxy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts, maxTokens: 8192 }),
  })
  if (!res.ok) throw new Error(`Gemini proxy lỗi: ${res.status}`)
  const data = await res.json()
  return data.text || ''
}

function InvestmentInfoModal({ proj, onClose, askRaw }) {
  const info = proj.investmentInfo || {}
  const [form, setForm] = useState({
    tongMucDauTu:        info.tongMucDauTu        || '',
    nguoiQuyetDinhDauTu:  info.nguoiQuyetDinhDauTu  || '',
    chuDauTu:             info.chuDauTu             || 'Tổng công ty Quản lý bay Việt Nam',
    hinhThucToChucQuanLy: info.hinhThucToChucQuanLy || '',
    nguonVon:             info.nguonVon             || '',
    thoiGianThucHien:     info.thoiGianThucHien     || '',
    mucTieuDauTu:         (info.mucTieuDauTu || []).join('\n'),
  })
  const [saving, setSaving] = useState(false)
  const [loadingFile, setLoadingFile] = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // "📎 Nạp thông tin" — Tony đính kèm 1 file Word/PDF/TXT có sẵn các trường
  // Mục I (vd: file mẫu báo cáo gửi ban KHĐT) → đọc trực tiếp nội dung CHỮ
  // trong CHÍNH file đó (không qua bộ nhớ dự án) → AI trích 7 trường, điền vào
  // form để Tony XEM LẠI/SỬA rồi mới bấm Lưu — KHÔNG tự lưu thẳng.
  const fillFromExtractedText = async (text) => {
    const prompt = `Bạn là trợ lý đọc văn bản dự án đầu tư. Dựa trên TOÀN VĂN văn bản dưới đây, hãy trích đúng 7 trường "Thông tin chung dự án". CHỈ trả về JSON hợp lệ, KHÔNG kèm dấu \`\`\`, KHÔNG giải thích gì thêm. Đúng cấu trúc:

{
  "tongMucDauTu": "số tiền + VNĐ — CHỈ lấy số được ghi rõ là TỔNG MỨC ĐẦU TƯ DỰ ÁN, KHÔNG lấy nhầm dự toán của 1 gói thầu con. Nếu không thấy rõ, để 'Chưa có thông tin'.",
  "nguoiQuyetDinhDauTu": "...",
  "chuDauTu": "...",
  "hinhThucToChucQuanLy": "hình thức TỔ CHỨC QUẢN LÝ dự án (vd: Chủ đầu tư trực tiếp quản lý dự án) — KHÁC HẲN hình thức LỰA CHỌN NHÀ THẦU (đấu thầu/chỉ định thầu), không lấy nhầm.",
  "nguonVon": "...",
  "thoiGianThucHien": "...",
  "mucTieuDauTu": ["điểm 1", "điểm 2"] hoặc []
}

Số tiền/ngày/số hiệu văn bản PHẢI chép ĐÚNG NGUYÊN VĂN, KHÔNG đoán/suy diễn nếu không thấy rõ — để "Chưa có thông tin" thay vì bịa.

NỘI DUNG VĂN BẢN:
${text}`

    const raw = await askRaw(prompt, 3000)
    const noFence = (raw || '').replace(/```json|```/g, '').trim()
    const start = noFence.indexOf('{')
    const end = noFence.lastIndexOf('}')
    if (start === -1 || end === -1) throw new Error('AI không trả JSON hợp lệ, thử lại sau.')
    const data = JSON.parse(noFence.slice(start, end + 1))

    const clean = (v) => (!v || /chưa có thông tin/i.test(v)) ? '' : v
    setForm(f => ({
      tongMucDauTu:         clean(data.tongMucDauTu)        || f.tongMucDauTu,
      nguoiQuyetDinhDauTu:  clean(data.nguoiQuyetDinhDauTu)  || f.nguoiQuyetDinhDauTu,
      chuDauTu:             clean(data.chuDauTu)             || f.chuDauTu,
      hinhThucToChucQuanLy: clean(data.hinhThucToChucQuanLy) || f.hinhThucToChucQuanLy,
      nguonVon:             clean(data.nguonVon)             || f.nguonVon,
      thoiGianThucHien:     clean(data.thoiGianThucHien)     || f.thoiGianThucHien,
      mucTieuDauTu:         data.mucTieuDauTu?.length ? data.mucTieuDauTu.join('\n') : f.mucTieuDauTu,
    }))
  }

  const handleAttachFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = '' // cho phép chọn lại đúng file đó lần sau nếu cần
    if (!file) return
    setLoadingFile(true)
    try {
      const ext = file.name.split('.').pop().toLowerCase()
      if (file.size > 8 * 1024 * 1024) throw new Error('File quá lớn (>8MB) — thử file nhỏ hơn hoặc cắt riêng phần có thông tin cần.')
      const buf = await file.arrayBuffer()
      let text = ''
      if (ext === 'docx') {
        text = await extractDocxTextForInfo(buf)
      } else if (ext === 'doc') {
        setLoadingStep('⏳ Đang đọc file .doc (qua server)...')
        text = await extractDocViaServer(buf)
      } else if (ext === 'pdf') {
        text = await extractPdfTextForInfo(buf)
        if (!text || text.trim().length < 100) {
          // Không có lớp chữ → khả năng là PDF scan → để Gemini đọc trực tiếp
          setLoadingStep('🔍 PDF có vẻ là file scan — đang nhận dạng bằng AI...')
          text = await ocrPdfViaGemini(buf, file.name)
        }
      } else if (['txt', 'md'].includes(ext)) {
        text = new TextDecoder('utf-8').decode(buf)
      } else {
        throw new Error('Chỉ hỗ trợ file Word (.doc/.docx), PDF (kể cả PDF scan) hoặc TXT/MD.')
      }
      if (!text.trim() || text.trim().length < 30) {
        throw new Error('Không đọc được nội dung chữ trong file này. Hãy dùng file Word/PDF có chữ, hoặc nhập tay.')
      }
      setLoadingStep('✨ Đang trích thông tin...')
      await fillFromExtractedText(text.slice(0, 50000))
    } catch (err) {
      alert('Nạp thông tin lỗi: ' + err.message)
    } finally {
      setLoadingFile(false)
      setLoadingStep('')
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const { doc, updateDoc } = await import('firebase/firestore')
      const { db } = await import('./firebase')
      await updateDoc(doc(db, 'projects', proj.id), {
        investmentInfo: {
          tongMucDauTu:         form.tongMucDauTu.trim(),
          nguoiQuyetDinhDauTu:  form.nguoiQuyetDinhDauTu.trim(),
          chuDauTu:             form.chuDauTu.trim(),
          hinhThucToChucQuanLy: form.hinhThucToChucQuanLy.trim(),
          nguonVon:             form.nguonVon.trim(),
          thoiGianThucHien:     form.thoiGianThucHien.trim(),
          mucTieuDauTu:         form.mucTieuDauTu.split('\n').map(s => s.trim()).filter(Boolean),
        },
      })
      onClose()
    } catch (e) {
      alert('Lỗi lưu thông tin dự án: ' + e.message)
    } finally { setSaving(false) }
  }

  const inputStyle = { width:'100%', padding:'8px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', boxSizing:'border-box', marginBottom:12, fontFamily:'inherit' }
  const labelStyle = { fontSize:12, fontWeight:600, color:'#555', marginBottom:4, display:'block' }

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:200, padding:20 }}>
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:520, maxWidth:'100%', maxHeight:'85vh', overflowY:'auto', boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:12 }}>
          <h3 style={{ fontSize:15, fontWeight:600, marginBottom:4 }}>ℹ️ Thông tin chung dự án</h3>
          <label style={{ flexShrink:0, fontSize:12, padding:'6px 12px', background: loadingFile ? '#e5e4e0' : '#eef2ff', border:'0.5px solid #c7d2fe', borderRadius:20, cursor: loadingFile ? 'default' : 'pointer', color:'#3730a3', whiteSpace:'nowrap' }}>
            <input type="file" accept=".docx,.doc,.pdf,.txt,.md" onChange={handleAttachFile} disabled={loadingFile} style={{ display:'none' }} />
            {loadingFile ? (loadingStep || '⏳ Đang đọc file...') : '📎 Nạp thông tin'}
          </label>
        </div>
        <p style={{ fontSize:12, color:'#888', marginBottom:16, lineHeight:1.5 }}>
          8 trường này hầu như không đổi suốt đời dự án. Nhấn <b>"📎 Nạp thông tin"</b> → đính kèm 1 file Word (.doc/.docx) hoặc PDF (kể cả PDF scan) có sẵn các thông tin này (vd: file báo cáo/quyết định phê duyệt) → AI đọc đúng file đó và điền sẵn — nhớ <b>xem lại/sửa cho đúng</b> rồi mới Lưu. Sau khi Lưu, báo cáo đầu tư sẽ luôn lấy đúng từ đây, không để AI tự dò lại mỗi lần bấm tạo báo cáo.
        </p>


        <label style={labelStyle}>Tổng mức đầu tư</label>
        <input style={inputStyle} value={form.tongMucDauTu} onChange={e => set('tongMucDauTu', e.target.value)} placeholder="VD: 19.046.769.000 VNĐ" />

        <label style={labelStyle}>Người quyết định đầu tư</label>
        <input style={inputStyle} value={form.nguoiQuyetDinhDauTu} onChange={e => set('nguoiQuyetDinhDauTu', e.target.value)} placeholder="VD: Hội đồng thành viên Tổng công ty Quản lý bay Việt Nam" />

        <label style={labelStyle}>Chủ đầu tư</label>
        <input style={inputStyle} value={form.chuDauTu} onChange={e => set('chuDauTu', e.target.value)} />

        <label style={labelStyle}>Hình thức tổ chức quản lý dự án</label>
        <input style={inputStyle} value={form.hinhThucToChucQuanLy} onChange={e => set('hinhThucToChucQuanLy', e.target.value)} placeholder="VD: Chủ đầu tư trực tiếp thực hiện dự án" />

        <label style={labelStyle}>Nguồn vốn</label>
        <input style={inputStyle} value={form.nguonVon} onChange={e => set('nguonVon', e.target.value)} placeholder="VD: Vốn của Tổng công ty Quản lý bay Việt Nam" />

        <label style={labelStyle}>Thời gian thực hiện dự án</label>
        <input style={inputStyle} value={form.thoiGianThucHien} onChange={e => set('thoiGianThucHien', e.target.value)} placeholder="VD: QII/2026–QII/2027" />

        <label style={labelStyle}>Mục tiêu đầu tư (mỗi dòng 1 điểm)</label>
        <textarea style={{ ...inputStyle, minHeight:110, resize:'vertical' }} value={form.mucTieuDauTu} onChange={e => set('mucTieuDauTu', e.target.value)} placeholder={'Trang bị hệ thống...\nNâng cao năng lực...'} />

        <div style={{ display:'flex', gap:8, justifyContent:'flex-end', marginTop:8 }}>
          <button onClick={onClose} disabled={saving} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
          <button onClick={save} disabled={saving} style={{ padding:'8px 20px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            {saving ? 'Đang lưu...' : '✓ Lưu'}
          </button>
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
  const [val,     setVal]     = useState(doc.status || 'prep')
  const s = SM2[doc.status || 'prep']
  if (!editing) return (
    <span onClick={() => { if(admin) { setVal(doc.status||'prep'); setEditing(true) } }}
      style={{ fontSize:11, padding:'4px 10px', borderRadius:20, background:s.bg, color:s.color, cursor:admin?'pointer':'default', display:'inline-flex', alignItems:'center', gap:5, whiteSpace:'nowrap', border:'0.5px solid '+s.color }}
      title={admin ? 'Nhấn để đổi trạng thái' : ''}>
      {s.label}{admin ? ' ✎' : ''}
    </span>
  )
  const sv = SM2[val]
  return (
    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
      <select value={val} onChange={e => setVal(e.target.value)} style={{ fontSize:11, padding:'4px 8px', borderRadius:20, background:sv.bg, color:sv.color, border:'0.5px solid '+sv.color, cursor:'pointer', outline:'none', fontWeight:500 }}>
        <option value="done">✅ Hoàn thành</option>
        <option value="pending">🔄 Đang thực hiện</option>
        <option value="prep">⬜ Chưa thực hiện</option>
      </select>
      <button onClick={() => { updateDocument(doc.id, { status: val }); setEditing(false) }} style={{ padding:'3px 8px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:6, cursor:'pointer', fontSize:11, fontWeight:600 }}>✓</button>
      <button onClick={() => setEditing(false)} style={{ padding:'3px 6px', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', fontSize:11, color:'#888' }}>✕</button>
    </div>
  )
}

function AppInner() {
  const { user, userDoc, status, isAdmin, isApproved, logout } = useAuth()
  const { projects, loading: pLoad, addProject, deleteProject } = useProjects(user?.uid)

  // Tách 1 mục con (gói thầu/văn bản) thành 1 mục lớn riêng, cùng nhóm với mục cha,
  // tự chuyển hết văn bản đang gắn trong đó theo — không mất dữ liệu.
  const promotePackageToProject = async (pkg, parentProjectId) => {
    if (!confirm(`Tách "${pkg.name}" thành 1 mục lớn riêng? Toàn bộ văn bản trong đó sẽ tự chuyển theo.`)) return
    const parent = projects.find(p => p.id === parentProjectId)
    const cat = parent ? getCategory(parent) : 'project'

    const newProjRef = await addProject({ name: pkg.name, code:'', budget:'Đang lập', period:'2026–2030', address:'', category: cat })

    const snap = await getDocs(query(
      collection(db, 'documents'),
      where('projectId', '==', parentProjectId),
      where('packageId', '==', pkg.id),
    ))
    await Promise.all(snap.docs.map(d =>
      updateDoc(fsDoc(db, 'documents', d.id), { projectId: newProjRef.id, packageId: null })
    ))

    await deletePackage(pkg.id)
    alert(`✅ Đã tách "${pkg.name}" — chuyển ${snap.docs.length} văn bản theo.`)
  }
  const { packages, addPackage, deletePackage } = usePackages()
  const { logLogin, logLogout, logViewDoc, logAddDoc, logEditDoc, logDeleteDoc,
          logAddProj, logDeleteProj, logExportReport } = useActivityLog(user, userDoc)
  const { draft } = useUploadCtx()

  const [selProj, setSelProj]         = useState('home')
  const [selPkg,  setSelPkg]          = useState(null)
  const [expandedProjs, setExpandedProjs] = useState(new Set())
  const [expandedCats,  setExpandedCats]  = useState(new Set()) // mặc định ẩn hết, bấm vào tên nhóm mới hiện

  const proj = selProj === 'home' ? null : (projects.find(p => p.id === selProj) || null)
  const selPkgObj = selPkg ? packages.find(p => p.id === selPkg) : null

  const { docs, allDocs, addDocument, updateDocument, deleteDocument } = useDocuments(proj?.id, user?.uid, selPkg)
  const { deleteFile }    = useCloudinaryStorage()
  const { ask, askRaw } = useAI()
  const { generateReport, generating: generatingReport } = useMonthlyReport()

  // Load memories của tất cả văn bản trong dự án
  const [projMemories, setProjMemories] = useState({})
  useEffect(() => {
    if (!proj?.id || !allDocs?.length) return
    const loadMemories = async () => {
      const { collection, getDocs } = await import('firebase/firestore')
      const { db } = await import('./firebase')
      const snap = await getDocs(collection(db, 'documentMemory'))
      const mem = {}
      snap.docs.forEach(d => { mem[d.id] = d.data() })
      setProjMemories(mem)
    }
    loadMemories()
  }, [proj?.id, allDocs?.length])

  // Trạng thái "cấp 1" — đang xem tổng quan cả nhóm (DỰ ÁN/QUY ĐỊNH/BIỂU MẪU),
  // chưa chọn dự án/quy định cụ thể nào bên trong.
  const [selCategory, setSelCategory] = useState(null)

  // Toàn bộ văn bản hệ thống — chỉ tải khi cần tổng hợp ở cấp 1 (tải lười, tránh
  // tải dư khi người dùng chỉ xem 1 dự án cụ thể như bình thường).
  const [allSystemDocs, setAllSystemDocs] = useState([])
  useEffect(() => {
    if (!selCategory) return
    const loadAll = async () => {
      const snap = await getDocs(collection(db, 'documents'))
      setAllSystemDocs(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    }
    loadAll()
  }, [selCategory])

  const [tab,         setTab]         = useState('docs')
  const [search,      setSearch]      = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')

  const handleSearchChange = (val) => {
    setSearch(val)
    // Nếu xóa hết → reset ngay
    if (!val.trim()) setSearchDebounced('')
  }

  const handleSearchEnter = (e) => {
    if (e.key === 'Enter') setSearchDebounced(search)
  }
  const [filter,      setFilter]      = useState('all')
  const [modal,       setModal]       = useState(null)
  const [editDoc,     setEditDoc]     = useState(null)
  const [detailDoc,   setDetailDoc]   = useState(null)
  const [chat,        setChat]        = useState([])
  const [chatInput,   setChatInput]   = useState('')
  const [aiLoading,   setAiLoad]      = useState(false)
  const [showAddProj, setShowAddProj] = useState(false)
  const [showAddPkg,  setShowAddPkg]  = useState(null) // null hoặc projectId
  const [showKeyModal,  setShowKeyModal]  = useState(false)
  const [showInvestInfo, setShowInvestInfo] = useState(false) // modal "Thông tin chung dự án" (Mục I báo cáo đầu tư)
  const [renameTarget,  setRenameTarget]  = useState(null) // { type:'project'|'package', id, currentName }
  const [renameInput,   setRenameInput]   = useState('')
  const [showChangePw,  setShowChangePw]  = useState(false)
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const [loggedIn,      setLoggedIn]      = useState(false)
  const [newProjName,   setNewProjName]   = useState('')
  const [newPkgName,    setNewPkgName]    = useState('')
  const [projPage,      setProjPage]      = useState(0)
  const chatEndRef = useRef(null)

  useEffect(() => {
    if (user && userDoc && !loggedIn) { logLogin(); setLoggedIn(true) }
  }, [user, userDoc])

  const toggleExpand = (projId) => {
    setExpandedProjs(prev => {
      const next = new Set(prev)
      if (next.has(projId)) next.delete(projId)
      else next.add(projId)
      return next
    })
  }

  const selectProject = (projId) => {
    setSelProj(projId); setSelPkg(null); setTab('docs'); setSelCategory(null)
    setExpandedProjs(prev => { const next = new Set(prev); next.add(projId); return next })
  }

  const selectPackage = (projId, pkgId) => {
    setSelProj(projId); setSelPkg(pkgId); setTab('docs'); setSelCategory(null)
  }

  const openFromDraft = (projectId) => {
    if (projectId) setSelProj(projectId)
    setEditDoc(null); setModal('add')
  }

  if (user === undefined) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:14, color:'#888' }}>⏳ Đang tải...</div>
  if (!user) return <LoginRegister />
  if (status === null) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:14, color:'#888' }}>⏳ Đang kiểm tra quyền truy cập...</div>
  if (status === 'pending')  return <PendingScreen  userDoc={userDoc} logout={logout} />
  if (status === 'rejected') return <RejectedScreen userDoc={userDoc} logout={logout} />
  if (pLoad) return <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontSize:14, color:'#888' }}>⏳ Đang tải dự án...</div>

  const safeDocs = docs || []
  const filtered = safeDocs.filter(d => {
    const q = searchDebounced.toLowerCase()
    const toStr = v => Array.isArray(v) ? v.join(' ') : (v || '')
    const matchS = !q || toStr(d.code).toLowerCase().includes(q) || toStr(d.subject).toLowerCase().includes(q) || toStr(d.org).toLowerCase().includes(q) || toStr(d.docType).toLowerCase().includes(q) || toStr(d.detail).toLowerCase().includes(q)
    return matchS && (filter === 'all' || d.status === filter)
  })
  const stats = {
    total:   safeDocs.length,
    done:    safeDocs.filter(d => d.status === 'done').length,
    pending: safeDocs.filter(d => d.status === 'pending').length,
    prep:    safeDocs.filter(d => !d.status || d.status === 'prep').length,
  }
  const progress = stats.total ? Math.round((stats.done / stats.total) * 100) : 0

  const handleSave = async (data, silent = false) => {
    if (editDoc) {
      await updateDocument(editDoc.id, data)
      logEditDoc(data.code||editDoc.code, data.subject||editDoc.subject, proj?.name, editDoc.id)
    } else {
      const ref = await addDocument(data, silent)
      logAddDoc(data.code, data.subject, proj?.name, ref?.id)
    }
    if (!silent) { setModal(null); setEditDoc(null) }
  }

  // Lấy toàn văn (rawText đầy đủ, ưu tiên hơn markdown đã tóm tắt) cho 1 danh sách
  // văn bản — dùng để Trợ lý AI hiểu SÂU từng văn bản trong phạm vi, không chỉ tóm tắt
  // ngắn (lý do trước đây hỏi sâu — tên người, số tiền hợp đồng... — không trả lời được).
  // Giới hạn mỗi văn bản tối đa 30K ký tự để tránh 1 văn bản quá dài chiếm hết context
  // khi phạm vi có nhiều văn bản (cấp 2/cấp 1).
  const buildFullTextContext = async (docsInScope, labelFn) => {
    const parts = await Promise.all(docsInScope.map(async d => {
      const label = labelFn(d)
      try {
        const mdSnap = await getDoc(fsDoc(db, 'documentMarkdown', d.id))
        if (mdSnap.exists()) {
          const data = mdSnap.data()
          const full = (data.rawText || data.markdown || '').slice(0, 30000)
          if (full) return `=== ${label} ===\n${full}`
        }
      } catch {}
      // Chưa có bộ nhớ đầy đủ (văn bản chưa được phân tích sâu) → dùng tạm metadata cơ bản
      const mem = projMemories[d.id]
      if (mem?.summary) return `=== ${label} ===\n${mem.summary}`
      return `=== ${label} ===\n${d.subject || ''} (${d.status})`
    }))
    return parts.join('\n\n')
  }

  // Nguồn riêng cho BÁO CÁO THÁNG — lấy bộ nhớ ĐÃ PHÂN TÍCH SÂU (collection
  // documentMemory: summary/keyPoints/financial/legal/deadlines/members/...)
  // làm nguồn CHÍNH, vì các nhóm thông tin đó đã khớp gần như 1:1 với các mục
  // mẫu báo cáo cần (tài chính, pháp lý, tiến độ...) — không cần AI tự mò lại
  // từ đầu trong rawText mỗi lần bấm nút. Gọn hơn rawText rất nhiều lần (rawText
  // tối đa 30K ký tự/văn bản, cộng dồn nhiều văn bản từng gây JSON output bị cắt
  // cụt). Văn bản nào CHƯA có trong documentMemory (chưa phân tích sâu) → CHỈ
  // dùng tóm tắt cơ bản đã có sẵn lúc upload (subject/detail/note/org/docType),
  // KHÔNG tự động lấy rawText — giữ prompt luôn gọn và ổn định bất kể văn bản đó
  // dài/ngắn.
  const buildReportContext = async (docsInScope, labelFn) => {
    const parts = await Promise.all(docsInScope.map(async d => {
      const label = labelFn(d)
      const mem = projMemories[d.id]
      const hasMem = mem && (mem.summary || mem.financial?.length || mem.legal?.length || mem.deadlines?.length || mem.keyPoints?.length)
      if (hasMem) {
        const lines = [
          mem.summary && `Tóm tắt: ${mem.summary}`,
          mem.keyPoints?.length && `Điểm quan trọng: ${mem.keyPoints.join('; ')}`,
          mem.financial?.length && `Tài chính: ${mem.financial.join('; ')}`,
          mem.legal?.length && `Pháp lý: ${mem.legal.join('; ')}`,
          mem.deadlines?.length && `Tiến độ/mốc thời gian: ${mem.deadlines.join('; ')}`,
          mem.members?.length && `Thành viên/đơn vị liên quan: ${mem.members.join('; ')}`,
          mem.requirements && `Yêu cầu: ${mem.requirements}`,
          mem.risks && `Rủi ro/vướng mắc: ${mem.risks}`,
        ].filter(Boolean).join('\n')
        return `=== ${label} ===\n${lines}`
      }
      // Chưa phân tích sâu → CHỈ dùng tóm tắt cơ bản đã có sẵn từ lúc upload
      // (d.subject/d.detail/d.note/d.org/d.docType — lấy thẳng từ object đã có,
      // không gọi thêm Firestore). KHÔNG tự động lấy rawText ở đây nữa — rawText
      // không giới hạn tốt theo từng văn bản trong nhóm nhiều văn bản, từng là
      // nguyên nhân khiến prompt phình to gây lỗi JSON.
      const basic = [
        d.subject && `Về việc: ${d.subject}`,
        d.detail && `Tóm tắt: ${d.detail}`,
        d.note && `Ghi chú: ${d.note}`,
        d.org && `Cơ quan ban hành: ${d.org}`,
        d.docType && `Loại văn bản: ${d.docType}`,
      ].filter(Boolean).join('\n')
      return `=== ${label} (chưa phân tích sâu) ===\n${basic || `${d.subject || ''} (${d.status})`}`
    }))
    return parts.join('\n\n')
  }

  const handleAsk = async (q) => {
    if (!q.trim() || aiLoading) return
    setChat(c => [...c, { role:'user', content:q }])
    setChatInput(''); setAiLoad(true)
    setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior:'smooth' }), 100)
    try {
      let ctx = ''
      if (selCategory && !proj) {
        // Cấp 1 — hiểu sâu TOÀN BỘ văn bản của TẤT CẢ dự án/quy định/biểu mẫu trong nhóm
        const catLabel = { project:'DỰ ÁN', regulation:'QUY ĐỊNH', form:'BIỂU MẪU' }[selCategory] || selCategory
        const catProjects = projects.filter(p => getCategory(p) === selCategory)

        // Nếu câu hỏi nhắc rõ tên 1 mục cụ thể trong nhóm (vd "dự án Hộp đen có...")
        // → THU HẸP phạm vi về đúng mục đó, như đang hỏi ở cấp 2 — loại bỏ hoàn toàn
        // rủi ro AI lẫn dữ liệu với các mục khác trong nhóm khi nhóm có nhiều mục.
        const qLower = q.toLowerCase()
        const mentionedProject = catProjects.find(p => qLower.includes(p.name.toLowerCase()))

        if (mentionedProject) {
          const scopedDocs = allSystemDocs.filter(d => d.projectId === mentionedProject.id)
          const fullCtx = await buildFullTextContext(scopedDocs, d => `[${d.code || d.subject || '—'}]`)
          ctx = `Dự án/mục: ${mentionedProject.name} (thuộc nhóm ${catLabel})
Tổng: ${scopedDocs.length} văn bản — CHỈ trả lời về đúng mục "${mentionedProject.name}" này, không nhắc các mục khác trong nhóm trừ khi được hỏi.

NỘI DUNG ĐẦY ĐỦ TỪNG VĂN BẢN:
${fullCtx || '(chưa có văn bản nào)'}`
        } else {
          const catDocs = allSystemDocs.filter(d => catProjects.some(p => p.id === d.projectId))
          const fullCtx = await buildFullTextContext(catDocs, d => {
            const projName = catProjects.find(p => p.id === d.projectId)?.name || '—'
            return `[${projName} › ${d.code || d.subject || '—'}]`
          })
          const breakdown = catProjects.map(p => `- ${p.name}: ${catDocs.filter(d => d.projectId === p.id).length} văn bản`).join('\n')
          ctx = `Nhóm: ${catLabel}
QUAN TRỌNG — 2 con số khác nhau, KHÔNG nhầm lẫn:
- Số MỤC (dự án/quy định) trong nhóm này: ĐÚNG ${catProjects.length} mục, tên đầy đủ: ${catProjects.map(p => p.name).join(', ') || '(chưa có mục nào)'}
- Số VĂN BẢN trong toàn nhóm (cộng tất cả các mục): ${catDocs.length} văn bản

Chi tiết số văn bản theo từng mục:
${breakdown || '(chưa có mục nào)'}

NỘI DUNG ĐẦY ĐỦ TỪNG VĂN BẢN:
${fullCtx || '(chưa có văn bản nào)'}`
        }
      } else {
        // Cấp 2 (dự án/quy định, xem hết các gói thầu) hoặc cấp 3 (1 gói thầu cụ thể)
        // — đều hiểu sâu TOÀN BỘ văn bản trong đúng phạm vi đang chọn (safeDocs đã tự
        // lọc theo selPkg nếu có, hoặc cả dự án nếu chưa chọn gói thầu).
        const fullCtx = await buildFullTextContext(safeDocs, d => `[${d.code || d.subject || '—'}]`)
        ctx = `Dự án: ${proj?.name}${selPkgObj ? ' › ' + selPkgObj.name : ''}
Tổng: ${stats.total} văn bản | Hoàn thành: ${stats.done} | Đang thực hiện: ${stats.pending}

NỘI DUNG ĐẦY ĐỦ TỪNG VĂN BẢN:
${fullCtx}`
      }
      const res = await ask(q, ctx)
      setChat(c => [...c, { role:'ai', content:res }])
    } catch {
      setChat(c => [...c, { role:'ai', content:'❌ AI đang bận. Thử lại sau 1 phút!' }])
    } finally { setAiLoad(false) }
  }

  // Tạo báo cáo tháng theo mẫu chuẩn (Word) — chỉ áp dụng ở cấp dự án/gói thầu cụ
  // thể (cần proj), không áp dụng ở cấp 1 (tổng quan nhóm) vì mẫu này là cho 1 dự án.
  const handleGenerateMonthlyReport = async () => {
    if (!proj || generatingReport) return
    try {
      const fullCtx = await buildReportContext(safeDocs, d => `[${d.code || d.subject || '—'}]`)
      await generateReport({ projectName: proj.name, fullCtx, askRaw, investmentInfo: proj.investmentInfo || null })
    } catch (e) {
      alert('Không tạo được báo cáo: ' + e.message)
    }
  }

  const exportReport = () => {
    const now = new Date()
    const ngay = now.toLocaleDateString('vi-VN')
    const s2 = (n) => String(n).padStart(2,'0')
    const dd=s2(now.getDate()), mm=s2(now.getMonth()+1), hh=s2(now.getHours()), min=s2(now.getMinutes())
    const rows = safeDocs.map((d,i) => {
      const s = SM[d.status] || SM.prep
      return `<tr><td style="padding:6px 10px;border:1px solid #ddd;text-align:center">${i+1}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;font-weight:bold">${d.code||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${normDate(d.date)}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.docType||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.org||'—'}</td>
        <td style="padding:6px 10px;border:1px solid #ddd">${d.subject||''}</td>
        <td style="padding:6px 10px;border:1px solid #ddd;color:${s.color};font-weight:bold">${s.label}</td></tr>`
    }).join('')
    const title = selPkgObj ? `${proj?.name} > ${selPkgObj.name}` : (proj?.name||'')
    const html = `<html><head><meta charset='utf-8'><style>body{font-family:'Times New Roman',serif;font-size:14pt}h1{font-size:16pt;font-weight:bold;text-align:center}table{border-collapse:collapse;width:100%}th{background:#1a1a1a;color:#fff;padding:6pt 8pt;border:1px solid #333}td{padding:5pt 8pt;border:1px solid #ccc}</style></head><body>
    <h1>BÁO CÁO TỔNG HỢP VĂN BẢN</h1><h1>${title}</h1>
    <p style="text-align:center">Ngày xuất: ${ngay} | Tổng: ${stats.total} | Tiến độ: ${progress}%</p>
    <table><thead><tr><th>STT</th><th>Số hiệu</th><th>Ngày</th><th>Loại</th><th>Cơ quan ban hành</th><th>Nội dung</th><th>Trạng thái</th></tr></thead><tbody>${rows}</tbody></table></body></html>`
    logExportReport(proj?.name)
    const blob = new Blob(['\uFEFF' + html], { type:'application/msword;charset=utf-8' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    const pn = title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').replace(/[^a-zA-Z0-9]/g,'_')
    a.download = `BaoCao_${pn}_${dd}-${mm}-${now.getFullYear()}_${hh}h${min}.doc`; a.click()
  }

  // Thống kê dạng excel — cùng dữ liệu với bản Word, xuất .xlsx bằng thư viện
  // xlsx (đã có sẵn trong package.json, không cần thêm dependency).
  const exportReportExcel = () => {
    const now = new Date()
    const s2 = (n) => String(n).padStart(2,'0')
    const dd=s2(now.getDate()), mm=s2(now.getMonth()+1)
    const title = selPkgObj ? `${proj?.name} > ${selPkgObj.name}` : (proj?.name||'')
    const rows = safeDocs.map((d,i) => ({
      'STT': i + 1,
      'Số hiệu': d.code || '—',
      'Ngày': normDate(d.date),
      'Loại': d.docType || '—',
      'Cơ quan ban hành': d.org || '—',
      'Nội dung / Về việc': d.subject || '',
      'Trạng thái': (SM[d.status] || SM.prep).label,
    }))
    const ws = XLSX.utils.json_to_sheet(rows)
    ws['!cols'] = [{ wch: 5 }, { wch: 22 }, { wch: 12 }, { wch: 16 }, { wch: 28 }, { wch: 60 }, { wch: 16 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Thống kê')
    logExportReport(proj?.name)
    const pn = title.normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/đ/gi,'d').replace(/[^a-zA-Z0-9]/g,'_')
    XLSX.writeFile(wb, `ThongKe_${pn}_${dd}-${mm}-${now.getFullYear()}.xlsx`)
  }

  return (
    <div style={{ display:'flex', position:'fixed', inset:0, fontFamily:'Times New Roman,serif' }}>

      {/* ── Sidebar ── */}
      <div style={{ width:220, background:'#fff', borderRight:'0.5px solid #e5e4e0', display:'flex', flexDirection:'column', flexShrink:0, height:'100vh', overflow:'hidden' }}>
        <div style={{ padding:'0 8px', flex:'none', marginTop:12 }}>
          {[['home','🏠','Trang chủ','docs'],['home','📖','Hướng dẫn sử dụng','guide']].map(([p_,icon,label,t]) => (
            <button key={label} onClick={() => { setSelProj(p_); setSelPkg(null); setSelCategory(null); setTab(t) }}
              style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', background:tab===t&&selProj==='home'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
              <span style={{ fontSize:14 }}>{icon}</span> {label}
            </button>
          ))}
          {isAdmin && (
            <button onClick={() => { setSelProj('home'); setSelPkg(null); setSelCategory(null); setTab('history') }}
              style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', background:tab==='history'&&selProj==='home'?'#f0f0ec':'transparent', color:'#1a1a1a', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
              <span style={{ fontSize:14 }}>📋</span> Lịch sử truy cập
            </button>
          )}
          {isAdmin && (
            <button onClick={() => { setSelProj('home'); setSelPkg(null); setSelCategory(null); setTab('admin') }}
              style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', background:tab==='admin'?'#fef3c7':'transparent', color:'#92400e', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:6, marginBottom:2 }}>
              <span style={{ fontSize:14 }}>👥</span> Quản lý người dùng
            </button>
          )}
        </div>

        {/* Danh sách dự án theo 3 nhóm: Dự án / Quy định / Biểu mẫu */}
        <div style={{ padding:'0 8px', borderTop:'0.5px solid #f0f0ec', marginTop:4, flex:1, overflowY:'auto' }}>
          {(() => {
            const renderProjectRow = (p, catKey) => {
              const pkgsForProj = packages.filter(pkg => pkg.projectId === p.id)
              const isExpanded  = expandedProjs.has(p.id)
              const isProjSel   = proj?.id === p.id

              return (
                <div key={p.id} style={{ marginBottom:2 }}>
                  {/* Dòng dự án */}
                  <div style={{ display:'flex', alignItems:'center', borderRadius:8, background: isProjSel && !selPkg ? '#f0f0ec' : 'transparent' }}>
                    {/* Nút expand */}
                    <button onClick={() => toggleExpand(p.id)}
                      style={{ padding:'4px 4px 4px 6px', background:'none', border:'none', cursor:'pointer', color:'#aaa', fontSize:9, flexShrink:0, lineHeight:1 }}>
                      {isExpanded ? '▼' : '▶'}
                    </button>
                    <button onClick={() => selectProject(p.id)}
                      style={{ flex:1, textAlign:'left', padding:'6px 4px', border:'none', cursor:'pointer', background:'transparent', color:'#1a1a1a', fontSize:13, fontWeight:600, display:'flex', alignItems:'center', gap:4, minWidth:0 }}>
                      <span style={{ fontSize:13, flexShrink:0 }}>📋</span>
                      <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{p.name}</span>
                    </button>
                    <button onClick={() => { setRenameInput(p.name); setRenameTarget({ type:'project', id:p.id, currentName:p.name }) }}
                        style={{ padding:'4px 4px', background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:11, flexShrink:0 }} title="Đổi tên">✎</button>
                    <button onClick={() => { if (confirm('Xác nhận xóa?')) { deleteProject(p.id); logDeleteProj(p.name); if (selProj===p.id) { setSelProj('home'); setSelPkg(null) } } }}
                        style={{ padding:'4px 6px', background:'none', border:'none', cursor:'pointer', color:'#ccc', fontSize:11, flexShrink:0 }}>✕</button>
                  </div>

                  {/* Gói thầu (khi mở rộng) */}
                  {isExpanded && (
                    <div style={{ paddingLeft:22, paddingBottom:4 }}>
                      {pkgsForProj.map(pkg => (
                        <div key={pkg.id} style={{ display:'flex', alignItems:'center', borderRadius:6, marginBottom:1, background: selPkg===pkg.id ? '#e8f0fe' : 'transparent' }}>
                          <button onClick={() => selectPackage(p.id, pkg.id)}
                            style={{ flex:1, textAlign:'left', padding:'5px 6px', border:'none', cursor:'pointer', background:'transparent', color: selPkg===pkg.id ? '#1a56db' : '#444', fontSize:12, fontWeight: selPkg===pkg.id ? 600 : 400, display:'flex', alignItems:'center', gap:4, minWidth:0 }}>
                            <span style={{ fontSize:12 }}>📁</span>
                            <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{pkg.name}</span>
                          </button>
                          <button onClick={() => { setRenameInput(pkg.name); setRenameTarget({ type:'package', id:pkg.id, currentName:pkg.name }) }}
                              style={{ padding:'2px 4px', background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:10, flexShrink:0 }} title="Đổi tên">✎</button>
                          <button onClick={() => promotePackageToProject(pkg, p.id)}
                              style={{ padding:'2px 4px', background:'none', border:'none', cursor:'pointer', color:'#bbb', fontSize:10, flexShrink:0 }} title="Tách thành mục lớn riêng">⬆</button>
                          <button onClick={() => { if (confirm('Xác nhận xóa?')) { deletePackage(pkg.id); if (selPkg===pkg.id) setSelPkg(null) } }}
                              style={{ padding:'2px 6px', background:'none', border:'none', cursor:'pointer', color:'#ccc', fontSize:10, flexShrink:0 }}>✕</button>
                        </div>
                      ))}
                      {/* Nút thêm gói thầu (chỉ DỰ ÁN mới có lớp thứ 3 này) / thêm văn bản trực tiếp (Quy định, Biểu mẫu) */}
                      {catKey === 'project' ? (
                        <button onClick={() => setShowAddPkg(p.id)}
                          style={{ fontSize:11, color:'#888', background:'none', border:'none', cursor:'pointer', padding:'4px 6px', width:'100%', textAlign:'left' }}>
                          {subItemLabel(catKey)}
                        </button>
                      ) : (
                        <button onClick={() => { setSelProj(p.id); setSelPkg(null); setTab('docs'); setEditDoc(null); setModal('add') }}
                          style={{ fontSize:11, color:'#888', background:'none', border:'none', cursor:'pointer', padding:'4px 6px', width:'100%', textAlign:'left' }}>
                          {subItemLabel(catKey)}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            }

            const groups = [
              { key:'project',    label:'DỰ ÁN',    addLabel:'+ Thêm dự án' },
              { key:'regulation', label:'QUY ĐỊNH', addLabel:'+ Thêm quy định' },
              { key:'form',       label:'BIỂU MẪU', addLabel:'+ Thêm biểu mẫu' },
            ]

            return groups.map((g, idx) => {
              const catProjects = projects.filter(p => getCategory(p) === g.key)
              const catOpen = expandedCats.has(g.key)
              return (
                <div key={g.key} style={{
                  marginBottom:10, paddingTop: idx>0?10:0,
                  borderTop: idx>0 ? '1px solid #e5e4e0' : 'none',
                }}>
                  <button
                    onClick={() => {
                      setExpandedCats(s => { const n=new Set(s); n.has(g.key)?n.delete(g.key):n.add(g.key); return n })
                      // Chuyển sang cấp 1 thật — xem tổng quan cả nhóm, không nhảy thẳng
                      // vào 1 dự án/quy định cụ thể, để Trợ lý AI biết được TOÀN BỘ
                      // các mục bên trong nhóm, không chỉ mục đầu tiên.
                      setSelCategory(g.key); setSelProj(null); setSelPkg(null); setTab('docs')
                    }}
                    style={{ width:'100%', textAlign:'left', display:'flex', alignItems:'center', gap:6, padding:'8px 8px 4px', background:'none', border:'none', cursor:'pointer' }}>
                    <span style={{ fontSize:9, color:'#aaa' }}>{catOpen ? '▼' : '▶'}</span>
                    <span style={{ fontSize:13, color:'#1a1a1a', fontWeight:600 }}>{g.label}</span>
                  </button>
                  {catOpen && <>
                    {catProjects.map(p => renderProjectRow(p, g.key))}
                    <button onClick={() => setShowAddProj(g.key)}
                      style={{ width:'100%', textAlign:'left', padding:'8px 10px', borderRadius:8, border:'none', cursor:'pointer', background:'transparent', color:'#888', fontSize:12, marginTop:2, fontWeight:600 }}>
                      {g.addLabel}
                    </button>
                  </>}
                </div>
              )
            })
          })()}
        </div>

        <div style={{ padding:'12px 16px', borderTop:'0.5px solid #e5e4e0', flexShrink:0, background:'#fff' }}>
          <div onClick={() => setAccountMenuOpen(v => !v)} style={{ cursor:'pointer' }}>
            <div style={{ fontSize:12, fontWeight:700, color:'#0a2342' }}>{userDoc?.name || 'Người dùng'}</div>
            <div style={{ fontSize:11, color:'#888' }}>@{userDoc?.username}</div>
            {userDoc?.email && <div style={{ fontSize:10, color:'#aaa', marginBottom:4, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{userDoc.email}</div>}
            {isAdmin && <div style={{ fontSize:10, color:'#92400e', background:'#fef3c7', padding:'2px 8px', borderRadius:10, display:'inline-block', marginBottom:6 }}>👑 Admin</div>}
          </div>
          {accountMenuOpen && (
            <>
              <br/>
              <button onClick={() => setShowChangePw(true)} style={{ fontSize:11, color:'#0a2342', background:'none', border:'0.5px solid #0a2342', borderRadius:6, cursor:'pointer', padding:'4px 10px', marginBottom:6, width:'100%' }}>
                🔑 Đổi mật khẩu
              </button>
              <button onClick={() => { logLogout().then(() => logout()) }} style={{ fontSize:11, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', padding:'4px 10px', width:'100%' }}>
                Đăng xuất
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Main ── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>

        {tab === 'admin' && isAdmin && <div style={{ flex:1, overflowY:'auto' }}><AdminUsers /></div>}

        {selCategory && !proj && tab !== 'history' && tab !== 'guide' && tab !== 'admin' && (() => {
          const catLabel = { project:'DỰ ÁN', regulation:'QUY ĐỊNH', form:'BIỂU MẪU' }[selCategory] || selCategory
          const catProjects = projects.filter(p => getCategory(p) === selCategory)
          const catDocs = allSystemDocs.filter(d => catProjects.some(p => p.id === d.projectId))
          return (
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding:'12px 24px', borderBottom:'0.5px solid #e5e4e0', background:'#fff', flexShrink:0 }}>
              <div style={{ fontSize:15, fontWeight:700, color:'#0a2342' }}>{catLabel} — Tổng quan</div>
              <div style={{ fontSize:12, color:'#888', marginTop:2 }}>{catProjects.length} mục · {catDocs.length} văn bản</div>
            </div>
            <div style={{ padding:'10px 24px', overflowY:'auto', flexShrink:0, maxHeight:160 }}>
              {catProjects.map(p => (
                <button key={p.id} onClick={() => selectProject(p.id)}
                  style={{ width:'100%', textAlign:'left', display:'flex', justifyContent:'space-between', alignItems:'center', padding:'7px 14px', marginBottom:4, background:'#fafaf8', border:'0.5px solid #e5e4e0', borderRadius:10, cursor:'pointer' }}>
                  <span style={{ fontWeight:600, fontSize:13, color:'#1a1a1a' }}>📋 {p.name}</span>
                  <span style={{ fontSize:11, color:'#888' }}>{allSystemDocs.filter(d => d.projectId === p.id).length} văn bản</span>
                </button>
              ))}
              {catProjects.length === 0 && <div style={{ fontSize:12, color:'#888', padding:'10px 0' }}>Chưa có mục nào trong nhóm này.</div>}
            </div>
            <div style={{ padding:'12px 24px', borderTop:'0.5px solid #e5e4e0', background:'#fff', flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minHeight:0 }}>
              <div style={{ display:'flex', alignItems:'center', marginBottom:8, flexShrink:0 }}>
                <div style={{ fontSize:12, color:'#888' }}>✨ Trợ lý AI — hỏi về toàn bộ {catLabel.toLowerCase()}</div>
                {chat.length > 0 && <button onClick={() => setChat([])} style={{ fontSize:11, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', padding:'2px 8px', marginLeft:'auto' }}>🗑️ Xóa chat</button>}
              </div>
              <div style={{ flex:1, overflowY:'auto', marginBottom:8, minHeight:0 }}>
                {chat.map((m,i) => (
                  <div key={i} style={{ display:'flex', justifyContent: m.role==='user'?'flex-end':'flex-start', marginBottom:8 }}>
                    <div style={{ maxWidth:'85%', padding:'8px 12px', borderRadius:10, fontSize:12, whiteSpace:'pre-wrap', background: m.role==='user' ? '#0a2342' : '#f5f5f3', color: m.role==='user' ? '#fff' : '#1a1a1a' }}>{m.content}</div>
                  </div>
                ))}
                {aiLoading && <div style={{ display:'flex' }}><div style={{ padding:'8px 12px', borderRadius:10, fontSize:12, background:'#f5f5f3', color:'#888' }}>⏳ Đang trả lời...</div></div>}
                <div ref={chatEndRef}/>
              </div>
              <div style={{ display:'flex', gap:8, flexShrink:0 }}>
                <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
                  onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
                  placeholder={`Hỏi về ${catLabel.toLowerCase()}... (Enter để gửi)`}
                  style={{ flex:1, padding:'8px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13 }}/>
                <button onClick={() => handleAsk(chatInput)} disabled={aiLoading||!chatInput.trim()}
                  style={{ padding:'8px 16px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer' }}>▶</button>
              </div>
            </div>
          </div>
          )
        })()}

        {!proj && !selCategory && tab !== 'history' && tab !== 'guide' && tab !== 'admin' && (
          <div style={{ flex:1, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:48, background:'linear-gradient(135deg, #e8f4fd 0%, #bdd9f0 100%)', position:'relative' }}>
            <img src="/vatm-logo.png" alt="VATM" style={{ width:200, height:200, borderRadius:'50%', objectFit:'cover', marginBottom:24 }}/>
            <h2 style={{ fontSize:24, fontWeight:700, color:'#0a2342', marginBottom:12 }}>Chào mừng đến VATM-PMU</h2>
            <p style={{ position:'absolute', bottom:16, right:24, fontSize:11, color:'#333' }}>Mọi ý kiến đóng góp xin gửi về: <a href="mailto:hoangductudhbk@gmail.com" style={{ color:'#0a2342', textDecoration:'none', fontWeight:600 }}>hoangductudhbk@gmail.com</a></p>
          </div>
        )}

        {tab === 'history' && <div style={{ flex:1, overflow:'hidden', display:'flex', flexDirection:'column' }}><HistoryView user={user}/></div>}

        {tab === 'guide' && (() => {
          const guideItems = [
            { num:'1', title:'Thêm, sửa, xóa văn bản', icon:'📁', content:'Nhấn <b>+ Thêm văn bản</b> → <b>✨ AI tự điền</b> (tự trích Số, Ngày, Cơ quan...) hoặc <b>✏️ Nhập thủ công</b>. <b>Luôn kiểm tra lại</b> trước khi lưu vì AI có thể sai/thiếu. Nhấn vào văn bản để <b>✏️ sửa</b> hoặc <b>🗑️ xóa</b>.' },
            { num:'2', title:'Phân tích văn bản', icon:'🤖', content:'Mở văn bản → Bấm <b>📊 Phân tích tài liệu</b>. Nên <b>phân tích sâu</b> văn bản quan trọng — đây là nền cho Hỏi đáp và Trợ lý AI/Báo cáo sau này.' },
            { num:'3', title:'Trợ lý AI', icon:'✨', content:'Nhấn <b>💬 Hỏi đáp tài liệu</b> để hỏi các thông tin chính được AI ghi nhớ lại trong văn bản.' },
            { num:'4', title:'Thống kê văn bản', icon:'📥', content:'Vào tab <b>Thống kê văn bản</b> → nhấn <b>📥 Word</b> hoặc <b>📊 Excel</b> để tải danh sách văn bản trong phạm vi đang chọn.' },
            { num:'5', title:'Xuất báo cáo đầu tư', icon:'📄', content:'Mục DỰ ÁN: nhấn <b>ℹ️ Thông tin dự án</b> để nhập/nạp thông tin chung (1 lần) → nhấn <b>📄 Báo cáo đầu tư</b> để AI tự tổng hợp, xuất file Word.' },
            { num:'6', title:'Thông tin chung', icon:'👥', content:'Mọi hoạt động (thêm/sửa/xóa, báo cáo...) đều lưu ở <b>Lịch sử truy cập</b>. <b>Hạn chế xóa nhầm</b> — ảnh hưởng cả nhóm.' },
          ]
          const renderCard = (item) => (
            <div key={item.num} style={{ flex:1, display:'flex', gap:16, padding:'16px 21px', background:'#fafaf8', borderRadius:13, border:'0.5px solid #e5e4e0' }}>
              <div style={{ flexShrink:0, width:42, height:42, borderRadius:9, background:'#0a2342', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center', fontWeight:700, fontSize:19.5 }}>{item.num}</div>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:19, color:'#0a2342', marginBottom:4 }}>{item.icon} {item.title}</div>
                <div style={{ fontSize:17, color:'#555', lineHeight:1.45 }} dangerouslySetInnerHTML={{ __html: item.content }}/>
              </div>
            </div>
          )
          return (
          <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
            <div style={{ padding:'8px 20px 6px', borderBottom:'0.5px solid #e5e4e0', background:'#fff', flexShrink:0 }}>
              <h2 style={{ fontSize:16, fontWeight:700, margin:0 }}>📖 Hướng dẫn sử dụng</h2>
            </div>
            <div style={{ flex:1, padding:'12px 20px', overflowY:'auto', display:'flex', flexDirection:'column' }}>
              <div style={{ flex:1, display:'flex', gap:10 }}>
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:10 }}>
                  {guideItems.slice(0,3).map(renderCard)}
                </div>
                <div style={{ flex:1, display:'flex', flexDirection:'column', gap:10 }}>
                  {guideItems.slice(3,6).map(renderCard)}
                </div>
              </div>
              <div style={{ textAlign:'center', marginTop:10, padding:'9px 16px', background:'#fef9c3', borderRadius:10, border:'0.5px solid #fde047', fontSize:12.5, color:'#854d0e', flexShrink:0 }}>
                ⚠️ <b>Lưu ý:</b> Trợ lý AI miễn phí nên hạn chế về tính năng và số lượt sử dụng, mong quý vị thông cảm.
              </div>
            </div>
          </div>
          )
        })()}

        {proj && tab !== 'history' && tab !== 'guide' && tab !== 'admin' && <>
          {(() => { const projCat = getCategory(proj); const needsPkg = projCat === 'project' && !selPkg; return (
          <div style={{ padding:'12px 24px 10px', borderBottom:'0.5px solid #e5e4e0', background:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontSize:15, fontWeight:700, color:'#0a2342' }}>
                {proj?.name}
                {selPkgObj && <span style={{ color:'#888', fontWeight:400 }}> › <span style={{ color:'#1a56db', fontWeight:600 }}>📁 {selPkgObj.name}</span></span>}
              </div>
              {selPkg && (
                <button onClick={() => setSelPkg(null)} style={{ fontSize:11, color:'#888', background:'none', border:'none', cursor:'pointer', padding:0, marginTop:2 }}>
                  ← Xem tất cả văn bản dự án
                </button>
              )}
            </div>
            <button onClick={() => { setEditDoc(null); setModal('add') }} disabled={needsPkg}
              title={needsPkg ? 'Chọn hoặc tạo gói thầu/thư mục con trước khi thêm văn bản' : ''}
              style={{ padding:'8px 16px', background: needsPkg ? '#f5f5f3' : '#fff', border:'0.5px solid #ddd', borderRadius:8, cursor: needsPkg ? 'not-allowed' : 'pointer', fontSize:13, color: needsPkg ? '#aaa' : '#1a1a1a' }}>+ Thêm văn bản</button>
          </div>
          )})()}
          <div style={{ padding:'12px 24px', background:'#fff', borderBottom:'0.5px solid #e5e4e0', display:'flex', gap:12 }}>
            {getCategory(proj) === 'project' ? (
              <>
                {[['Tổng văn bản',stats.total,'#1a1a1a'],['Hoàn thành',stats.done,'#15803d'],['Đang thực hiện',stats.pending,'#b45309'],['Chưa thực hiện',stats.prep,'#888']].map(([l,v,c]) => (
                  <div key={l} style={{ flex:1, padding:'10px 14px', background:'#fafaf8', borderRadius:10, border:'0.5px solid #e5e4e0' }}>
                    <div style={{ fontSize:11, color:'#888', marginBottom:2 }}>{l}</div>
                    <div style={{ fontSize:18, fontWeight:700, color:c }}>{v}</div>
                  </div>
                ))}
                <div style={{ flex:2, padding:'10px 14px', background:'#fafaf8', borderRadius:10, border:'0.5px solid #e5e4e0' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'#888', marginBottom:6 }}>
                    <span>Tỷ lệ hoàn thành</span><span style={{ fontWeight:600 }}>{progress}%</span>
                  </div>
                  <div style={{ height:8, background:'#e5e4e0', borderRadius:4, overflow:'hidden' }}>
                    <div style={{ height:'100%', width:progress+'%', background:'#22c55e', borderRadius:4 }}/>
                  </div>
                </div>
              </>
            ) : (
              // Quy định/Biểu mẫu không có khái niệm "tiến độ thực hiện" như Dự án
              // — chỉ hiện Tổng văn bản, bỏ Hoàn thành/Đang thực hiện/Chưa thực
              // hiện/Tỷ lệ hoàn thành (vốn chỉ có ý nghĩa với khối Dự án).
              <div style={{ padding:'10px 14px', background:'#fafaf8', borderRadius:10, border:'0.5px solid #e5e4e0', minWidth:160 }}>
                <div style={{ fontSize:11, color:'#888', marginBottom:2 }}>Tổng văn bản</div>
                <div style={{ fontSize:18, fontWeight:700, color:'#1a1a1a' }}>{stats.total}</div>
              </div>
            )}
          </div>
          <div style={{ padding:'0 24px', background:'#fff', borderBottom:'0.5px solid #e5e4e0', display:'flex', alignItems:'center' }}>
            {[['docs','Văn bản'],['report','Thống kê văn bản']].map(([v,l]) => (
              <button key={v} onClick={() => setTab(v)}
                style={{ padding:'12px 16px', border:'none', borderBottom:tab===v?'2px solid #1a1a1a':'2px solid transparent', background:'transparent', cursor:'pointer', fontSize:13, fontWeight:tab===v?600:400, color:tab===v?'#1a1a1a':'#888' }}>{l}</button>
            ))}
            {getCategory(proj) === 'project' && (
              <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
                <button onClick={() => setShowInvestInfo(true)}
                  style={{ fontSize:12, padding:'6px 14px', background:'#fff', border:'0.5px solid #ddd', borderRadius:20, cursor:'pointer', color:'#555' }}>
                  ℹ️ Thông tin dự án
                </button>
                <button onClick={handleGenerateMonthlyReport} disabled={generatingReport}
                  style={{ fontSize:12, padding:'6px 14px', background: generatingReport ? '#e5e4e0' : '#0a2342', border:'none', borderRadius:20, cursor: generatingReport ? 'default' : 'pointer', color:'#fff' }}>
                  {generatingReport ? '⏳ Đang tạo...' : '📄 Báo cáo đầu tư'}
                </button>
              </div>
            )}
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>
            {tab === 'docs' && (
              <div>
                <div style={{ display:'flex', gap:10, marginBottom:16 }}>
                  <div style={{ flex:1, position:'relative' }}>
                    <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', color:'#aaa' }}>🔍</span>
                    <input value={search} onChange={e => handleSearchChange(e.target.value)} onKeyDown={handleSearchEnter} placeholder="Tìm văn bản..."
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
                      {['Số hiệu văn bản','Ngày','Loại','Cơ quan ban hành','Nội dung / Về việc','Trạng thái',''].map(h => (
                        <th key={h} style={{ textAlign:'left', padding:'8px 12px', fontSize:14, color:'#888', fontWeight:500 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} style={{ padding:'40px', textAlign:'center', color:'#888', fontSize:13 }}>
                        {(selPkg || getCategory(proj) !== 'project') ? 'Chưa có văn bản nào' : (
                          <>
                            Chưa có gói thầu/thư mục con nào được chọn.<br/>
                            <span style={{ fontSize:12 }}>Mở rộng dự án ở menu bên trái và chọn (hoặc tạo) 1 gói thầu để thêm văn bản — tránh văn bản bị thêm lẫn ở cấp dự án.</span>
                          </>
                        )}
                      </td></tr>
                    )}
                    {filtered.map(d => (
                      <tr key={d.id} onClick={() => { setDetailDoc(d); logViewDoc(d.code, d.subject, proj?.name, d.id) }}
                        style={{ borderBottom:'0.5px solid #f0f0ec', cursor:'pointer' }}
                        onMouseEnter={e => e.currentTarget.style.background='#fafaf8'}
                        onMouseLeave={e => e.currentTarget.style.background=''}>
                        <td style={{ padding:'10px 12px', fontSize:15, fontWeight:700, whiteSpace:'nowrap' }}>{d.code||'—'}</td>
                        <td style={{ padding:'10px 12px', fontSize:14, color:'#888', whiteSpace:'nowrap' }}>{normDate(d.date)}</td>
                        <td style={{ padding:'10px 12px' }}><span style={{ fontSize:13, padding:'4px 10px', borderRadius:12, background:'#f0f0ec', color:'#555' }}>{d.docType||'Khác'}</span></td>
                        <td style={{ padding:'10px 12px', fontSize:13, color:'#666', maxWidth:160, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{d.org||'—'}</td>
                        <td style={{ padding:'10px 12px', fontSize:15, maxWidth:280 }}>
                          <span style={{ overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', display:'block' }}>{d.subject||''}</span>
                          {(d.fileUrl||d.downloadUrl) && (
                            <span style={{ fontSize:12, color:'#2563eb', display:'block', marginTop:2 }}>
                              📎 {d.fileName||'file'}{fmtSize(d.fileSize)}
                            </span>
                          )}
                        </td>
                        <td style={{ padding:'6px 12px' }} onClick={e => e.stopPropagation()}>
                          <StatusCell doc={d} updateDocument={updateDocument} admin={true}/>
                        </td>
                        <td style={{ padding:'10px 8px', whiteSpace:'nowrap' }} onClick={e => e.stopPropagation()}>
                          <button onClick={() => { setEditDoc(d); setModal('edit') }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, padding:'2px 6px', color:'#888' }}>✏️</button>
                          <button onClick={async () => {
                            if (!confirm('Xác nhận xóa?')) return
                            try {
                              await deleteFile(d)
                              await deleteDocument(d.id)
                            } catch (e) {
                              alert('❌ Xóa thất bại: ' + e.message)
                            }
                          }} style={{ background:'none', border:'none', cursor:'pointer', fontSize:15, padding:'2px 6px', color:'#e53e3e' }}>🗑️</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {tab === 'report' && (
              <div style={{ maxWidth:600 }}>
                <div style={{ padding:'20px', background:'#fff', border:'0.5px solid #e5e4e0', borderRadius:12 }}>
                  <p style={{ fontSize:13, color:'#555', marginBottom:16 }}>
                    Thống kê văn bản: <strong>{selPkgObj ? `${proj?.name} › ${selPkgObj.name}` : proj?.name}</strong> ({stats.total} văn bản).
                  </p>
                  <div style={{ display:'flex', gap:10 }}>
                    <button onClick={exportReport} style={{ padding:'10px 20px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>📥 Thống kê dạng word</button>
                    <button onClick={exportReportExcel} style={{ padding:'10px 20px', background:'#15803d', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>📊 Thống kê dạng excel</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </>}

        {proj && tab !== 'history' && tab !== 'guide' && tab !== 'admin' && (
          <div style={{ borderTop:'0.5px solid #e5e4e0', background:'#fff', flexShrink:0, display:'flex', flexDirection:'column', maxHeight:'40vh' }}>
            <div style={{ padding:'8px 24px 0', flexShrink:0 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
                <span style={{ fontSize:12, color:'#888' }}>✨ Trợ lý AI</span>
                {chat.length > 0 && <button onClick={() => setChat([])} style={{ fontSize:11, color:'#888', background:'none', border:'0.5px solid #ddd', borderRadius:6, cursor:'pointer', padding:'2px 8px', marginLeft:'auto' }}>🗑️ Xóa chat</button>}
              </div>
            </div>
            {chat.length > 0 && (
              <div style={{ flex:1, overflowY:'auto', padding:'0 24px 6px', display:'flex', flexDirection:'column', gap:6 }}>
                {chat.map((m,i) => (
                  <div key={i} style={{ display:'flex', justifyContent:m.role==='user'?'flex-end':'flex-start' }}>
                    <div style={{ maxWidth:'80%', padding:'8px 12px', borderRadius:10, fontSize:12, lineHeight:1.5, background:m.role==='user'?'#1a1a1a':'#f5f5f3', color:m.role==='user'?'#fff':'#1a1a1a' }}>{m.content}</div>
                  </div>
                ))}
                {aiLoading && <div style={{ display:'flex' }}><div style={{ padding:'8px 12px', borderRadius:10, fontSize:12, background:'#f5f5f3', color:'#888' }}>⏳ Đang trả lời...</div></div>}
                <div ref={chatEndRef}/>
              </div>
            )}
            <div style={{ padding:'6px 24px 10px', flexShrink:0 }}>
              <div style={{ display:'flex', gap:8 }}>
                <input value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => e.key==='Enter' && !e.shiftKey && handleAsk(chatInput)}
                  placeholder={`Hỏi về ${({ project:'dự án', regulation:'quy định', form:'biểu mẫu' }[getCategory(proj)] || 'dự án')}... (Enter để gửi)`}
                  style={{ flex:1, padding:'9px 14px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none' }}/>
                <button onClick={() => handleAsk(chatInput)} disabled={aiLoading||!chatInput.trim()}
                  style={{ padding:'9px 16px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>▶</button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Modals */}
      {(modal==='add'||modal==='edit') && (
        <DocModal project={proj} doc={editDoc} onSave={handleSave} onClose={() => { setModal(null); setEditDoc(null) }}/>
      )}
      {detailDoc && (
        <DocDetail doc={detailDoc} onEdit={() => { setEditDoc(detailDoc); setDetailDoc(null); setModal('edit') }} onClose={() => setDetailDoc(null)}/>
      )}
      {showChangePw && <ChangePassword onClose={() => setShowChangePw(false)} />}

      {/* Modal thêm dự án */}
      {showAddProj && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}>
          <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:400, boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>
            <h3 style={{ fontSize:15, fontWeight:600, marginBottom:16 }}>
              Thêm {showAddProj==='regulation'?'quy định':showAddProj==='form'?'biểu mẫu':'dự án'} mới
            </h3>
            <input value={newProjName} onChange={e => setNewProjName(e.target.value)} placeholder="Tên" autoFocus
              style={{ width:'100%', padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', marginBottom:12, boxSizing:'border-box' }}/>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setShowAddProj(false)} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
              <button onClick={async () => {
                if (newProjName.trim()) {
                  await addProject({ name:newProjName.trim(), code:'', budget:'Đang lập', period:'2026–2030', address:'', category: showAddProj })
                  logAddProj(newProjName.trim()); setNewProjName(''); setShowAddProj(false)
                }
              }} style={{ padding:'8px 16px', background:'#1a1a1a', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>Thêm</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal thêm gói thầu */}
      {showAddPkg && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100 }}>
          <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:400, boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>
            <h3 style={{ fontSize:15, fontWeight:600, marginBottom:16 }}>
              {subItemModalTitle(getCategory(projects.find(pr => pr.id === showAddPkg) || {}))}
            </h3>
            <input value={newPkgName} onChange={e => setNewPkgName(e.target.value)} placeholder="Tên" autoFocus
              onKeyDown={async e => {
                if (e.key==='Enter' && newPkgName.trim()) {
                  await addPackage(newPkgName.trim(), showAddPkg)
                  setNewPkgName(''); setShowAddPkg(null)
                }
              }}
              style={{ width:'100%', padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', marginBottom:12, boxSizing:'border-box' }}/>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => { setShowAddPkg(null); setNewPkgName('') }} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
              <button onClick={async () => {
                if (newPkgName.trim()) {
                  await addPackage(newPkgName.trim(), showAddPkg)
                  setNewPkgName(''); setShowAddPkg(null)
                }
              }} style={{ padding:'8px 16px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13 }}>📁 Thêm</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal đổi tên dự án / gói thầu */}
      {renameTarget && (
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:200 }}>
          <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:400, boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>
            <h3 style={{ fontSize:15, fontWeight:600, marginBottom:4 }}>
              {renameTarget.type === 'project' ? '📋 Đổi tên dự án' : '📁 Đổi tên gói thầu'}
            </h3>
            <div style={{ fontSize:12, color:'#888', marginBottom:12 }}>Hiện tại: <em>{renameTarget.currentName}</em></div>
            <input value={renameInput} onChange={e => setRenameInput(e.target.value)} autoFocus
              onKeyDown={async e => {
                if (e.key === 'Enter' && renameInput.trim()) {
                  const { doc, updateDoc } = await import('firebase/firestore')
                  const { db } = await import('./firebase')
                  const col = renameTarget.type === 'project' ? 'projects' : 'packages'
                  await updateDoc(doc(db, col, renameTarget.id), { name: renameInput.trim() })
                  setRenameTarget(null)
                }
              }}
              placeholder="Tên mới..."
              style={{ width:'100%', padding:'9px 12px', border:'0.5px solid #ddd', borderRadius:8, fontSize:13, outline:'none', marginBottom:16, boxSizing:'border-box' }}/>
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <button onClick={() => setRenameTarget(null)} style={{ padding:'8px 16px', border:'0.5px solid #ddd', borderRadius:8, cursor:'pointer', background:'#fff', fontSize:13 }}>Hủy</button>
              <button onClick={async () => {
                if (!renameInput.trim()) return
                const { doc, updateDoc } = await import('firebase/firestore')
                const { db } = await import('./firebase')
                const col = renameTarget.type === 'project' ? 'projects' : 'packages'
                await updateDoc(doc(db, col, renameTarget.id), { name: renameInput.trim() })
                setRenameTarget(null)
              }} style={{ padding:'8px 20px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                ✓ Lưu
              </button>
            </div>
          </div>
        </div>
      )}

      {showKeyModal && <KeyModal onClose={() => setShowKeyModal(false)}/>}
      {showInvestInfo && proj && (
        <InvestmentInfoModal
          proj={proj}
          onClose={() => setShowInvestInfo(false)}
          askRaw={askRaw}
        />
      )}
      <FloatingUpload onOpen={openFromDraft}/>
    </div>
  )
}

export default function App() {
  return <UploadProvider><AppInner /></UploadProvider>
}
