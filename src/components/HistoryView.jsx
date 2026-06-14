import { useState, useEffect } from 'react'
import { useActivityLog } from '../hooks/useActivityLog'
import { useAuth } from '../context/AuthContext'
import { collection, getDocs, deleteDoc, doc } from 'firebase/firestore'
import { db } from '../firebase'

const ACTION_MAP = {
  login:          { icon:'🔑', label:'Đăng nhập',       color:'#15803d', bg:'#f0fdf4' },
  logout:         { icon:'🚪', label:'Đăng xuất',       color:'#555',    bg:'#f5f5f5' },
  view_doc:       { icon:'👁️', label:'Đọc văn bản',     color:'#0891b2', bg:'#ecfeff' },
  add_doc:        { icon:'📄', label:'Thêm văn bản',    color:'#1d4ed8', bg:'#eff6ff' },
  edit_doc:       { icon:'✏️',  label:'Sửa văn bản',    color:'#b45309', bg:'#fffbeb' },
  delete_doc:     { icon:'🗑️', label:'Xóa văn bản',    color:'#b91c1c', bg:'#fef2f2' },
  status:         { icon:'🔄', label:'Đổi trạng thái', color:'#7c3aed', bg:'#f5f3ff' },
  upload_file:    { icon:'📎', label:'Upload file',     color:'#0891b2', bg:'#ecfeff' },
  add_project:    { icon:'📁', label:'Thêm dự án',      color:'#15803d', bg:'#f0fdf4' },
  delete_project: { icon:'❌', label:'Xóa dự án',      color:'#b91c1c', bg:'#fef2f2' },
  export_report:  { icon:'📊', label:'Xuất báo cáo',   color:'#854d0e', bg:'#fefce8' },
}

const fmt = (ts) => {
  if (!ts?.seconds) return '—'
  return new Date(ts.seconds * 1000).toLocaleString('vi-VN', {
    day:'2-digit', month:'2-digit', year:'numeric',
    hour:'2-digit', minute:'2-digit', second:'2-digit'
  })
}

// Kiểm tra chuỗi có phải UID Firebase không (dài, không có khoảng trắng)
const isUID = (str) => str && str.length > 20 && !str.includes(' ')

// Tính thời gian sử dụng: tìm logout gần nhất sau login của cùng userId
const getSessionDuration = (logs, loginLog) => {
  const loginTime = loginLog.timestamp?.seconds
  if (!loginTime) return null
  // Logs đã sắp xếp desc, nên logout sẽ ở index nhỏ hơn (trước) login trong mảng
  const idx = logs.indexOf(loginLog)
  // Tìm logout trước loginLog trong mảng (timestamp lớn hơn = thời gian sau)
  const logoutLog = logs.slice(0, idx).find(l =>
    l.action === 'logout' &&
    l.userId === loginLog.userId &&
    (l.timestamp?.seconds || 0) > loginTime
  )
  if (!logoutLog) return null
  const mins = Math.round((logoutLog.timestamp.seconds - loginTime) / 60)
  if (mins <= 0) return 'dưới 1 phút'
  if (mins < 60) return `${mins} phút`
  const h = Math.floor(mins / 60), m = mins % 60
  return m > 0 ? `${h} giờ ${m} phút` : `${h} giờ`
}

export default function HistoryView({ user }) {
  const { userDoc, isAdmin }  = useAuth()
  const { loadLogs }          = useActivityLog(user, userDoc)
  const [logs, setLogs]       = useState([])
  const [loading, setLoading] = useState(true)
  const [filterUser, setFU]   = useState('all')
  const [filterAct,  setFA]   = useState('all')
  const [deleting,   setDeleting] = useState(false)

  useEffect(() => {
    const unsub = loadLogs(list => { setLogs(list); setLoading(false) }, user?.uid, isAdmin)
    return unsub
  }, [user?.uid, isAdmin])

  // Lấy tên hiển thị — bỏ qua UID
  const getDisplayName = (l) => {
    if (l.userName && !isUID(l.userName)) return l.userName
    if (l.username) return l.username
    return '—'
  }

  const userNames = [...new Set(logs.map(l => getDisplayName(l)))].filter(n => n !== '—')
  const actions   = [...new Set(logs.map(l => l.action))].filter(Boolean)

  const filtered = logs.filter(l =>
    (filterUser === 'all' || getDisplayName(l) === filterUser) &&
    (filterAct  === 'all' || l.action === filterAct)
  )

  const stats = {
    logins:  logs.filter(l => l.action === 'login').length,
    views:   logs.filter(l => l.action === 'view_doc').length,
    adds:    logs.filter(l => l.action === 'add_doc').length,
    deletes: logs.filter(l => l.action === 'delete_doc').length,
  }

  const deleteAllLogs = async () => {
    if (!confirm('Xóa toàn bộ lịch sử truy cập? Hành động này không thể hoàn tác!')) return
    setDeleting(true)
    try {
      const snap = await getDocs(collection(db, 'activityLogs'))
      await Promise.all(snap.docs.map(d => deleteDoc(doc(db, 'activityLogs', d.id))))
    } catch(e) {
      alert('Lỗi khi xóa: ' + e.message)
    } finally {
      setDeleting(false)
    }
  }

  const exportWord = () => {
    const now   = new Date()
    const ngay  = now.toLocaleDateString('vi-VN')
    const s2    = (n) => String(n).padStart(2,'0')
    const dd=s2(now.getDate()), mm=s2(now.getMonth()+1), hh=s2(now.getHours()), min=s2(now.getMinutes())

    const rows = filtered.map((l, i) => {
      const a    = ACTION_MAP[l.action] || { label: l.action }
      const name = getDisplayName(l)
      const time = fmt(l.timestamp)
      return `<tr>
        <td style="padding:5pt 8pt;border:1px solid #ccc;text-align:center">${i+1}</td>
        <td style="padding:5pt 8pt;border:1px solid #ccc;font-weight:bold">${name}</td>
        <td style="padding:5pt 8pt;border:1px solid #ccc">${l.userEmail||'—'}</td>
        <td style="padding:5pt 8pt;border:1px solid #ccc">${a.label}</td>
        <td style="padding:5pt 8pt;border:1px solid #ccc">${l.details||'—'}</td>
        <td style="padding:5pt 8pt;border:1px solid #ccc;white-space:nowrap">${time}</td>
      </tr>`
    }).join('')

    const html = `<html><head><meta charset='utf-8'>
    <style>
      body{font-family:'Times New Roman',serif;font-size:13pt}
      h1{font-size:16pt;font-weight:bold;text-align:center;margin-bottom:4pt}
      p{text-align:center;font-size:12pt;margin:4pt 0 12pt}
      table{border-collapse:collapse;width:100%}
      th{background:#0a2342;color:#fff;padding:6pt 8pt;border:1px solid #333;font-size:12pt}
      td{font-size:11pt}
    </style></head><body>
    <h1>BÁO CÁO LỊCH SỬ TRUY CẬP HỆ THỐNG</h1>
    <h1>VATM-PMU — Quản lý Dự án</h1>
    <p>Ngày xuất: ${ngay} ${hh}:${min} &nbsp;|&nbsp; Tổng: ${filtered.length} bản ghi</p>
    <table>
      <thead>
        <tr>
          <th style="width:40pt">STT</th>
          <th>Họ tên</th>
          <th>Email</th>
          <th>Hành động</th>
          <th>Chi tiết</th>
          <th style="width:100pt">Thời gian</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    </body></html>`

    const blob = new Blob(['\uFEFF' + html], { type:'application/msword;charset=utf-8' })
    const a    = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = `LichSuTruyCap_${dd}-${mm}-${now.getFullYear()}_${hh}h${min}.doc`
    a.click()
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* Header */}
      <div style={{ flexShrink:0, padding:'16px 24px 12px', borderBottom:'0.5px solid #e5e4e0', background:'#fff' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:10, marginBottom:12 }}>
          <div>
            <h3 style={{ fontSize:15, fontWeight:600, margin:'0 0 4px' }}>📋 Lịch sử truy cập</h3>
            <p style={{ fontSize:12, color:'#888', margin:0 }}>
              {filtered.length} bản ghi &nbsp;·&nbsp;
              <span style={{ color:'#b91c1c' }}>Chỉ đọc — không thể xóa</span>
            </p>
          </div>
          <div style={{ display:'flex', gap:8, alignItems:'center', flexWrap:'wrap' }}>
            <button onClick={exportWord} style={{ padding:'7px 14px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:600 }}>
              📥 Xuất báo cáo Word
            </button>
            {isAdmin && (
              <button onClick={deleteAllLogs} disabled={deleting} style={{ padding:'7px 14px', background:deleting?'#9ca3af':'#dc2626', color:'#fff', border:'none', borderRadius:8, cursor:deleting?'not-allowed':'pointer', fontSize:12, fontWeight:600 }}>
                {deleting ? '⏳ Đang xóa...' : '🗑️ Xóa tất cả lịch sử'}
              </button>
            )}
            {/* Tất cả đều thấy filter theo người dùng */}
            <select value={filterUser} onChange={e => setFU(e.target.value)}
              style={{ padding:'7px 10px', border:'0.5px solid #ddd', borderRadius:8, fontSize:12, outline:'none', background:'#fff', maxWidth:200 }}>
              <option value="all">Tất cả người dùng</option>
              {userNames.map(u => <option key={u} value={u}>{u}</option>)}
            </select>
            <select value={filterAct} onChange={e => setFA(e.target.value)}
              style={{ padding:'7px 10px', border:'0.5px solid #ddd', borderRadius:8, fontSize:12, outline:'none', background:'#fff' }}>
              <option value="all">Tất cả hành động</option>
              {actions.map(a => <option key={a} value={a}>{ACTION_MAP[a]?.label || a}</option>)}
            </select>
          </div>
        </div>

        {/* Thống kê */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10 }}>
          {[
            ['🔑 Lần đăng nhập',  stats.logins,  '#15803d', '#f0fdf4'],
            ['👁️ Lần đọc văn bản', stats.views,   '#0891b2', '#ecfeff'],
            ['📄 Văn bản đã thêm', stats.adds,    '#1d4ed8', '#eff6ff'],
            ['🗑️ Văn bản đã xóa',  stats.deletes, '#b91c1c', '#fef2f2'],
          ].map(([l,v,c,bg]) => (
            <div key={l} style={{ padding:'10px 14px', background:bg, borderRadius:10, border:'0.5px solid '+c+'33' }}>
              <div style={{ fontSize:11, color:'#888', marginBottom:2 }}>{l}</div>
              <div style={{ fontSize:20, fontWeight:700, color:c }}>{v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Danh sách */}
      <div style={{ flex:1, overflowY:'auto', padding:'12px 24px' }}>
        {loading ? (
          <div style={{ padding:40, textAlign:'center', color:'#888' }}>⏳ Đang tải...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding:40, textAlign:'center', color:'#888', background:'#fff', borderRadius:12, border:'0.5px solid #e5e4e0' }}>
            Chưa có lịch sử nào
          </div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {filtered.map(l => {
              const a        = ACTION_MAP[l.action] || { icon:'•', label:l.action, color:'#555', bg:'#f5f5f5' }
              const name     = getDisplayName(l)
              const duration = l.action === 'login' ? getSessionDuration(logs, l) : null
              return (
                <div key={l.id} style={{ display:'flex', alignItems:'flex-start', gap:12, padding:'10px 14px', background:'#fff', border:'0.5px solid #e5e4e0', borderRadius:10 }}>
                  <span style={{ fontSize:18, flexShrink:0, marginTop:2 }}>{a.icon}</span>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4, flexWrap:'wrap' }}>
                      <span style={{ fontSize:11, padding:'2px 9px', borderRadius:20, background:a.bg, color:a.color, fontWeight:700, border:'0.5px solid '+a.color+'44' }}>
                        {a.label}
                      </span>
                      <span style={{ fontSize:12, fontWeight:600, color:'#1a1a1a' }}>{name}</span>
                      {isAdmin && l.userEmail && (
                        <span style={{ fontSize:11, color:'#aaa' }}>({l.userEmail})</span>
                      )}
                      {duration && (
                        <span style={{ fontSize:11, color:'#15803d', background:'#f0fdf4', padding:'2px 8px', borderRadius:20, border:'0.5px solid #bbf7d0' }}>
                          ⏱️ Phiên: {duration}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize:13, color:'#444', lineHeight:1.6 }}>{l.details}</div>
                  </div>
                  <div style={{ fontSize:11, color:'#aaa', whiteSpace:'nowrap', flexShrink:0, marginTop:2, textAlign:'right' }}>
                    {fmt(l.timestamp)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
