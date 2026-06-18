const fixUrl = (url) => {
  if (!url || !url.includes('cloudinary.com')) return url
  const ext = url.split('?')[0].split('.').pop().toLowerCase()
  const rawExts = ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','zip']
  if (rawExts.includes(ext) && url.includes('/image/upload/'))
    return url.replace('/image/upload/', '/raw/upload/')
  return url
}

const downloadFile = async (url, fileName) => {
  try {
    const res  = await fetch(fixUrl(url))
    const blob = await res.blob()
    const a    = document.createElement('a')
    a.href     = URL.createObjectURL(blob)
    a.download = fileName || 'tài liệu'
    document.body.appendChild(a); a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(a.href)
  } catch { window.open(fixUrl(url), '_blank') }
}

// Map field tiếng Việt (code cũ) sang tiếng Anh (code mới)
const get = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined && doc[k] !== '') return doc[k]
  return ''
}

export default function DocDetail({ doc, onEdit, onClose }) {
  if (!doc) return null

  // Đọc các field — hỗ trợ cả tên cũ (tiếng Việt) và tên mới (tiếng Anh)
  const code     = get(doc, 'code', 'mã số', 'so hieu', 'số hiệu')
  const date     = get(doc, 'date', 'ngày', 'ngay')
  const org      = get(doc, 'org', 'tổ chức', 'to chuc', 'cơ quan')
  const docType  = get(doc, 'docType', 'loại', 'loai', 'loại văn bản')
  const subject  = get(doc, 'subject', 'chủ thể', 'chu the', 'nội dung', 'noi dung')
  const detail   = get(doc, 'detail', 'chi tiết', 'chi tiet')
  const note     = get(doc, 'note', 'ghi chú', 'ghi chu')
  const fileName = get(doc, 'fileName', 'tên tệp', 'ten tep', 'driveFileName')
  const fileSize = doc.fileSize || doc['kích thước'] || 0
  const fileUrl  = get(doc,
    'fileUrl', 'downloadUrl', 'secureUrl',
    'liên kết tệp', 'lien ket tep',
    'url tệp', 'url tep',
    'liên kết', 'lien ket',
    'driveWebViewLink', 'driveDownloadUrl',
    'file_url', 'download_url'
  )

  const SM = {
    done:              { label:'✅ Hoàn thành',     bg:'#f0fdf4', color:'#15803d' },
    pending:           { label:'🔄 Đang thực hiện', bg:'#fffbeb', color:'#b45309' },
    prep:              { label:'⬜ Chưa thực hiện', bg:'#f5f5f5', color:'#666'    },
    'chưa giải quyết': { label:'⬜ Chưa thực hiện', bg:'#f5f5f5', color:'#666'    },
    'đang xử lý':      { label:'🔄 Đang thực hiện', bg:'#fffbeb', color:'#b45309' },
    'đã xong':         { label:'✅ Hoàn thành',     bg:'#f0fdf4', color:'#15803d' },
    'đang chờ':        { label:'🔄 Đang thực hiện', bg:'#fffbeb', color:'#b45309' },
  }
  const s = SM[doc.status] || SM['chưa giải quyết']

  const Row = ({ label, value }) => value ? (
    <div style={{ marginBottom:12 }}>
      <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:3 }}>{label}</div>
      <div style={{ fontSize:13, color:'#1a1a1a', lineHeight:1.6 }}>{value}</div>
    </div>
  ) : null

  const fIcon = (n='') => {
    const e = n.split('.').pop().toLowerCase()
    if (e==='pdf') return '📕'
    if (['doc','docx'].includes(e)) return '📘'
    if (['xls','xlsx'].includes(e)) return '📗'
    if (['ppt','pptx'].includes(e)) return '📙'
    return '📄'
  }

  const viewUrl = fixUrl(fileUrl)
  const hasFile = fileUrl.length > 5

  return (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.4)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:100, padding:20 }}
      onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{ background:'#fff', borderRadius:14, padding:'24px 28px', width:'100%', maxWidth:560, maxHeight:'85vh', overflowY:'auto', boxShadow:'0 8px 32px rgba(0,0,0,.15)' }}>

        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:16 }}>
          <div>
            <div style={{ fontSize:15, fontWeight:700, color:'#1a1a1a', marginBottom:6 }}>
              {code || subject || '(Chưa có số ký hiệu)'}
            </div>
            <span style={{ fontSize:11, padding:'3px 10px', borderRadius:20, fontWeight:500, background:s.bg, color:s.color }}>{s.label}</span>
          </div>
          <button onClick={onClose} style={{ background:'none', border:'none', cursor:'pointer', fontSize:18, color:'#888' }}>✕</button>
        </div>

        <div style={{ borderTop:'0.5px solid #e5e4e0', paddingTop:14 }}>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 20px' }}>
            <Row label="Ngày ban hành"    value={date}/>
            <Row label="Loại văn bản"     value={docType}/>
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

          {hasFile ? (
            <div style={{ marginBottom:12, padding:'14px', borderRadius:10, background:'#f8faff', border:'0.5px solid #c7d7f5' }}>
              <div style={{ fontSize:11, color:'#9b9b9b', marginBottom:10 }}>📎 Tài liệu đính kèm</div>
              <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                <span style={{ fontSize:28, flexShrink:0 }}>{fIcon(fileName)}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:'#1a1a1a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{fileName || 'tài liệu'}</div>
                  {fileSize > 0 && <div style={{ fontSize:11, color:'#9b9b9b', marginTop:2 }}>{(fileSize/1024).toFixed(0)} KB</div>}
                </div>
                <div style={{ display:'flex', gap:8, flexShrink:0 }}>
                  <a href={viewUrl} target="_blank" rel="noreferrer noopener" onClick={e=>e.stopPropagation()}
                    style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:600, textDecoration:'none', background:'#eff6ff', border:'0.5px solid #bfdbfe', color:'#1d4ed8', cursor:'pointer' }}>
                    👁️ Xem
                  </a>
                  <button onClick={e=>{e.stopPropagation();downloadFile(fileUrl, fileName)}}
                    style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:600, background:'#f0fdf4', border:'0.5px solid #bbf7d0', color:'#15803d', cursor:'pointer' }}>
                    📥 Tải về
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div style={{ marginBottom:12, padding:'12px 14px', borderRadius:10, background:'#fafaf8', border:'0.5px solid #e5e7eb', fontSize:12, color:'#9b9b9b', textAlign:'center' }}>
              📂 Chưa có file đính kèm — nhấn Chỉnh sửa để upload
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
