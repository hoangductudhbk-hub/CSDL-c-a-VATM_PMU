const get = (doc, ...keys) => {
  for (const k of keys) if (doc[k] !== undefined && doc[k] !== '') return doc[k]
  return ''
}

const toAscii = (str) => {
  const map = {'à':'a','á':'a','â':'a','ã':'a','ă':'a','ắ':'a','ằ':'a','ặ':'a','ẩ':'a','ẫ':'a','ậ':'a','ấ':'a','ầ':'a','ả':'a','ạ':'a','è':'e','é':'e','ê':'e','ế':'e','ề':'e','ể':'e','ễ':'e','ệ':'e','ẻ':'e','ẽ':'e','ì':'i','í':'i','ỉ':'i','ĩ':'i','ị':'i','ò':'o','ó':'o','ô':'o','ố':'o','ồ':'o','ổ':'o','ỗ':'o','ộ':'o','ơ':'o','ớ':'o','ờ':'o','ở':'o','ỡ':'o','ợ':'o','ọ':'o','ỏ':'o','ù':'u','ú':'u','ư':'u','ứ':'u','ừ':'u','ử':'u','ữ':'u','ự':'u','ụ':'u','ủ':'u','ỳ':'y','ý':'y','ỷ':'y','ỹ':'y','ỵ':'y','đ':'d','À':'A','Á':'A','Â':'A','Ã':'A','Ă':'A','Ắ':'A','Ằ':'A','Ặ':'A','Ẩ':'A','Ẫ':'A','Ậ':'A','Ấ':'A','Ầ':'A','Ả':'A','Ạ':'A','È':'E','É':'E','Ê':'E','Ế':'E','Ề':'E','Ể':'E','Ễ':'E','Ệ':'E','Ẻ':'E','Ẽ':'E','Ì':'I','Í':'I','Ỉ':'I','Ĩ':'I','Ị':'I','Ò':'O','Ó':'O','Ô':'O','Ố':'O','Ồ':'O','Ổ':'O','Ỗ':'O','Ộ':'O','Ơ':'O','Ớ':'O','Ờ':'O','Ở':'O','Ỡ':'O','Ợ':'O','Ọ':'O','Ỏ':'O','Ù':'U','Ú':'U','Ư':'U','Ứ':'U','Ừ':'U','Ử':'U','Ữ':'U','Ự':'U','Ụ':'U','Ủ':'U','Ý':'Y','Đ':'D'}
  return str.split('').map(c => map[c] || c).join('').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').slice(0, 80)
}

// Tạo URL tải về với tên file gốc qua fl_attachment
const getDownloadUrl = (url, fileName) => {
  if (!url) return url
  // Không bỏ extension vào tên — Cloudinary tự lấy từ URL
  const baseName = (fileName || 'tailieu').replace(/\.[^.]+$/, '')
  const safeName = toAscii(baseName)
  if (url.includes('/raw/upload/'))
    return url.replace('/raw/upload/', '/raw/upload/fl_attachment:' + safeName + '/')
  if (url.includes('/image/upload/'))
    return url.replace('/image/upload/', '/image/upload/fl_attachment:' + safeName + '/')
  return url
}

export default function DocDetail({ doc, onEdit, onClose }) {
  if (!doc) return null

  const code     = get(doc, 'code', 'mã số', 'so hieu', 'số hiệu')
  const date     = get(doc, 'date', 'ngày', 'ngay')
  const org      = get(doc, 'org', 'tổ chức', 'to chuc', 'cơ quan')
  const docType  = get(doc, 'docType', 'loại', 'loai', 'loại văn bản')
  const subject  = get(doc, 'subject', 'chủ thể', 'chu the', 'nội dung', 'noi dung')
  const detail   = get(doc, 'detail', 'chi tiết', 'chi tiet')
  const note     = get(doc, 'note', 'ghi chú', 'ghi chu')
  const fileName = get(doc, 'fileName', 'tên tệp', 'ten tep', 'driveFileName')
  const fileSize = doc.fileSize || doc['kích thước'] || 0
  const fileUrl  = get(doc, 'fileUrl', 'downloadUrl', 'secureUrl', 'liên kết tệp', 'lien ket tep', 'url tệp', 'url tep', 'liên kết', 'lien ket', 'driveWebViewLink', 'driveDownloadUrl', 'file_url', 'download_url')

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


  // Tải về đúng tên file gốc (không bị đổi tên do URL)
  const handleDownload = async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!fileUrl) return
    try {
      const res  = await fetch(fileUrl)
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = fileName || 'tailieu'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch {
      window.open(fileUrl, '_blank')
    }
  }

  const hasFile    = fileUrl && fileUrl.length > 5
  const downloadUrl = getDownloadUrl(fileUrl, fileName)

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
                  <div style={{ fontSize:13, fontWeight:600, color:'#1a1a1a', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {fileName || 'tài liệu'}
                  </div>
                  {fileSize > 0 && <div style={{ fontSize:11, color:'#9b9b9b', marginTop:2 }}>{(fileSize/1024).toFixed(0)} KB</div>}
                </div>
                <div style={{ display:'flex', gap:8, flexShrink:0 }}>
                  {/* Nút Tải về — dùng fl_attachment để Cloudinary set tên file */}
                  <button onClick={handleDownload}
                    style={{ display:'inline-flex', alignItems:'center', gap:5, padding:'8px 16px', borderRadius:8, fontSize:12, fontWeight:600, textDecoration:'none', background:'#f0fdf4', border:'0.5px solid #bbf7d0', color:'#15803d', cursor:'pointer' }}>
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
