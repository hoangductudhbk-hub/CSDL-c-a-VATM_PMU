// src/components/AdminUsers.jsx
import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc, deleteDoc, getDocs } from 'firebase/firestore'
import { db } from '../firebase'
import emailjs from '@emailjs/browser'

const badge = (s) => ({
  display:'inline-block', padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600,
  background: s==='admin'?'#fef3c7': s==='approved'?'#d1fae5': s==='rejected'?'#fee2e2':'#e0e7ff',
  color:       s==='admin'?'#92400e': s==='approved'?'#065f46': s==='rejected'?'#991b1b':'#3730a3',
})
const btn = (c) => ({
  padding:'5px 12px', borderRadius:8, fontSize:12, cursor:'pointer', fontWeight:600, border:'none',
  background: c==='green'?'#10b981': c==='red'?'#ef4444': c==='blue'?'#3b82f6':'#9ca3af',
  color:'#fff', marginRight:6,
})

const genTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const special = '!@#$'
  let pw = ''
  for (let i = 0; i < 6; i++) pw += chars[Math.floor(Math.random() * chars.length)]
  pw += special[Math.floor(Math.random() * special.length)]
  pw += Math.floor(Math.random() * 90 + 10)
  return pw
}

const exportUsersWord = (users) => {
  const now  = new Date()
  const ngay = now.toLocaleDateString('vi-VN')
  const s2   = (n) => String(n).padStart(2,'0')
  const dd=s2(now.getDate()), mm=s2(now.getMonth()+1), hh=s2(now.getHours()), min=s2(now.getMinutes())

  const allUsers = users.filter(u => u.status !== 'admin')
  const rows = allUsers.map((u, i) => {
    const status = u.status==='approved'?'Đã duyệt': u.status==='rejected'?'Từ chối':'Chờ duyệt'
    const ngayDK = u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString('vi-VN') : '—'
    return `<tr>
      <td style="padding:5pt 8pt;border:1px solid #ccc;text-align:center">${i+1}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc;font-weight:bold">@${u.username||'—'}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc">${u.name||'—'}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc">${u.unit||'—'}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc">${u.email||'—'}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc">${ngayDK}</td>
      <td style="padding:5pt 8pt;border:1px solid #ccc;font-weight:bold;color:${u.status==='approved'?'#065f46':u.status==='rejected'?'#991b1b':'#92400e'}">${status}</td>
    </tr>`
  }).join('')

  const approved = allUsers.filter(u=>u.status==='approved').length
  const pending  = allUsers.filter(u=>u.status==='pending').length
  const rejected = allUsers.filter(u=>u.status==='rejected').length

  const html = `<html><head><meta charset='utf-8'>
  <style>
    body{font-family:'Times New Roman',serif;font-size:13pt}
    h1{font-size:16pt;font-weight:bold;text-align:center;margin-bottom:4pt}
    p{text-align:center;font-size:12pt;margin:4pt 0 12pt}
    table{border-collapse:collapse;width:100%}
    th{background:#0a2342;color:#fff;padding:6pt 8pt;border:1px solid #333;font-size:12pt}
    td{font-size:11pt}
    .sum{margin:8pt 0;font-size:12pt}
  </style></head><body>
  <h1>THỐNG KÊ NGƯỜI DÙNG HỆ THỐNG</h1>
  <h1>VATM-PMU — Quản lý Dự án</h1>
  <p>Ngày xuất: ${ngay} ${hh}:${min} &nbsp;|&nbsp; Tổng người dùng: ${allUsers.length}</p>
  <p class="sum">✅ Đã duyệt: <b>${approved}</b> &nbsp;|&nbsp; ⏳ Chờ duyệt: <b>${pending}</b> &nbsp;|&nbsp; ❌ Từ chối: <b>${rejected}</b></p>
  <table>
    <thead>
      <tr>
        <th style="width:30pt">STT</th>
        <th>Tên đăng nhập</th>
        <th>Họ tên</th>
        <th>Đơn vị</th>
        <th>Email</th>
        <th style="width:80pt">Ngày đăng ký</th>
        <th style="width:70pt">Trạng thái</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  </body></html>`

  const blob = new Blob(['\uFEFF' + html], { type:'application/msword;charset=utf-8' })
  const a    = document.createElement('a')
  a.href     = URL.createObjectURL(blob)
  a.download = `ThongKeNguoiDung_${dd}-${mm}-${now.getFullYear()}_${hh}h${min}.doc`
  a.click()
}

export default function AdminUsers() {
  const [users,   setUsers]   = useState([])
  const [resets,  setResets]  = useState([])
  const [filter,  setFilter]  = useState('pending')
  const [mainTab, setMainTab] = useState('users')
  const [sending, setSending] = useState(null)
  const [cleaning, setCleaning] = useState(false)

  // Dọn dữ liệu rác — chỉ xoá phần KHÔNG còn văn bản gốc tương ứng,
  // không động tới văn bản đang dùng thật.
  const cleanupOrphanedData = async () => {
    if (!confirm('Quét và xoá dữ liệu rác (không còn văn bản gốc) trong Firestore?\nKhông ảnh hưởng văn bản đang dùng.')) return
    setCleaning(true)
    try {
      const docsSnap = await getDocs(collection(db, 'documents'))
      const validIds = new Set(docsSnap.docs.map(d => d.id))
      const validMdRefs = new Set(docsSnap.docs.map(d => d.data().markdownRef).filter(Boolean))
      const removed = { memory: 0, markdown: 0, chunks: 0, jobs: 0 }

      const memSnap = await getDocs(collection(db, 'documentMemory'))
      for (const m of memSnap.docs) {
        if (!validIds.has(m.id)) { await deleteDoc(doc(db, 'documentMemory', m.id)); removed.memory++ }
      }

      const jobSnap = await getDocs(collection(db, 'processingJobs'))
      for (const j of jobSnap.docs) {
        if (!validIds.has(j.id)) { await deleteDoc(doc(db, 'processingJobs', j.id)); removed.jobs++ }
      }

      const mdSnap = await getDocs(collection(db, 'documentMarkdown'))
      for (const md of mdSnap.docs) {
        if (!validMdRefs.has(md.id)) { await deleteDoc(doc(db, 'documentMarkdown', md.id)); removed.markdown++ }
      }

      const chunkSnap = await getDocs(collection(db, 'documentChunks'))
      for (const c of chunkSnap.docs) {
        const parentId = c.data().docId
        if (!parentId || !validIds.has(parentId)) { await deleteDoc(doc(db, 'documentChunks', c.id)); removed.chunks++ }
      }

      alert(`✅ Đã dọn xong:\n- Bộ nhớ AI rác: ${removed.memory}\n- Markdown rác: ${removed.markdown}\n- Chunks rác: ${removed.chunks}\n- Job xử lý rác: ${removed.jobs}`)
    } catch (e) {
      alert('❌ Lỗi khi dọn: ' + e.message)
    } finally {
      setCleaning(false)
    }
  }


  useEffect(() => {
    const u1 = onSnapshot(collection(db, 'users'), snap =>
      setUsers(snap.docs.map(d=>({id:d.id,...d.data()}))
        .sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0))))
    const u2 = onSnapshot(collection(db, 'resetRequests'), snap =>
      setResets(snap.docs.map(d=>({id:d.id,...d.data()}))
        .filter(r=>r.status==='pending')
        .sort((a,b)=>(b.requestAt?.seconds||0)-(a.requestAt?.seconds||0))))
    return () => { u1(); u2() }
  }, [])

  const setStatus  = (uid, status) => updateDoc(doc(db,'users',uid),{status})
  const deleteUser = (id, name)    => { if(confirm('Xác nhận xóa?')) deleteDoc(doc(db,'users',id)) }

  const approveReset = async (r) => {
    if (!confirm('Đồng ý và gửi mật khẩu tạm cho @'+r.username+'?')) return
    setSending(r.id)
    try {
      const tempPw = genTempPassword()
      const apiRes = await fetch('/api/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: r.uid, newPassword: tempPw }),
      })
      if (!apiRes.ok) {
        const err = await apiRes.json()
        throw new Error(err.error || 'Lỗi đổi mật khẩu')
      }
      await emailjs.send(
        import.meta.env.VITE_EMAILJS_SERVICE_ID,
        import.meta.env.VITE_EMAILJS_USER_TEMPLATE_ID,
        { name: r.name||r.username, username: r.username, temp_password: tempPw, user_email: r.contactEmail },
        import.meta.env.VITE_EMAILJS_PUBLIC_KEY
      )
      await updateDoc(doc(db,'resetRequests',r.id), { status:'done', tempPassword:tempPw, resolvedAt:new Date() })
      alert('✅ Đã đổi mật khẩu và gửi email cho: ' + r.contactEmail)
    } catch(e) {
      console.error(e); alert('❌ Lỗi: ' + e.message)
    } finally { setSending(null) }
  }

  const rejectReset = async (r) => {
    if (!confirm('Từ chối yêu cầu của @'+r.username+'?')) return
    await updateDoc(doc(db,'resetRequests',r.id), { status: 'rejected' })
  }

  const SUPER_ADMIN = 'hoangductu'  // tài khoản gốc không thể thu hồi

  const promoteAdmin = (uid) => {
    if (!confirm('Bổ nhiệm người dùng này làm Admin?')) return
    updateDoc(doc(db,'users',uid), { status:'admin' })
  }
  const revokeAdmin = (uid, username) => {
    if (username === SUPER_ADMIN) return alert('Không thể thu hồi quyền Admin gốc!')
    if (!confirm('Thu hồi quyền Admin của @'+username+'?')) return
    updateDoc(doc(db,'users',uid), { status:'approved' })
  }

  const counts = {
    pending:  users.filter(u=>u.status==='pending').length,
    approved: users.filter(u=>u.status==='approved').length,
    rejected: users.filter(u=>u.status==='rejected').length,
    admin:    users.filter(u=>u.status==='admin').length,
  }
  const filtered = filter==='all'
    ? users
    : users.filter(u=>u.status===filter)

  return (
    <div style={{ padding:24, maxWidth:960, margin:'0 auto' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:6 }}>
        <div style={{ fontSize:20, fontWeight:700, color:'#0a2342' }}>👥 Quản lý người dùng</div>
        <div style={{ display:'flex', gap:8 }}>
          <button
            onClick={cleanupOrphanedData} disabled={cleaning}
            style={{ padding:'8px 18px', background:cleaning?'#9ca3af':'#dc2626', color:'#fff', border:'none', borderRadius:8, cursor:cleaning?'not-allowed':'pointer', fontSize:13, fontWeight:600 }}>
            {cleaning ? '⏳ Đang dọn...' : '🧹 Dọn dữ liệu rác'}
          </button>
          <button
            onClick={() => exportUsersWord(users)}
            style={{ padding:'8px 18px', background:'#0a2342', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
            📊 Thống kê người dùng
          </button>
        </div>
      </div>
      <p style={{ fontSize:13, color:'#888', marginBottom:20 }}>Duyệt tài khoản và xử lý yêu cầu đặt lại mật khẩu</p>

      {/* Main tabs */}
      <div style={{ display:'flex', gap:8, marginBottom:20 }}>
        {[['users','👥 Tài khoản'],['resets','🔐 Quên mật khẩu']].map(([v,l])=>(
          <button key={v} onClick={()=>setMainTab(v)}
            style={{ padding:'8px 20px', borderRadius:20, fontSize:13, cursor:'pointer', border:'none', fontWeight:600,
              background: mainTab===v?'#0a2342':'#f3f4f6', color: mainTab===v?'#fff':'#374151', position:'relative' }}>
            {l}
            {v==='resets' && resets.length>0 && (
              <span style={{ position:'absolute', top:-4, right:-4, background:'#ef4444', color:'#fff', borderRadius:10, padding:'1px 6px', fontSize:10, fontWeight:700 }}>{resets.length}</span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab Tài khoản ── */}
      {mainTab==='users' && <>
        <div style={{ display:'flex', gap:10, marginBottom:20 }}>
          {[['pending','⏳',counts.pending,'#fef3c7','#92400e'],
            ['approved','✅',counts.approved,'#d1fae5','#065f46'],
            ['rejected','❌',counts.rejected,'#fee2e2','#991b1b'],
            ['admin','👑',counts.admin,'#fef3c7','#d97706']].map(([v,icon,n,bg,c])=>(
            <div key={v} onClick={()=>setFilter(v)}
              style={{ flex:1, background:filter===v?bg:'#f9fafb', borderRadius:12, padding:'12px 16px', textAlign:'center', cursor:'pointer',
                border:`1.5px solid ${filter===v?c:'#e5e7eb'}` }}>
              <div style={{ fontSize:22, fontWeight:700, color:c }}>{n}</div>
              <div style={{ fontSize:12, color:c, fontWeight:500 }}>{icon} {v==='pending'?'Chờ duyệt':v==='approved'?'Đã duyệt':v==='rejected'?'Từ chối':'Admin'}</div>
            </div>
          ))}
        </div>

        {filtered.length===0
          ? <div style={{ padding:'40px', textAlign:'center', color:'#9ca3af', fontSize:14, background:'#f9fafb', borderRadius:12 }}>
              {filter==='pending'?'✅ Không có tài khoản nào chờ duyệt':'Không có dữ liệu'}
            </div>
          : <div style={{ background:'#fff', borderRadius:12, border:'0.5px solid #e5e7eb', overflow:'hidden' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
                <thead style={{ background:'#f9fafb' }}>
                  <tr>
                    {['Tên đăng nhập','Họ tên','Đơn vị','Email','Ngày đăng ký','Trạng thái','Hành động'].map(h=>(
                      <th key={h} style={{ textAlign:'left', padding:'12px 14px', color:'#6b7280', fontWeight:600, borderBottom:'1px solid #e5e7eb', fontSize:12 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(u=>(
                    <tr key={u.id} style={{ borderBottom:'1px solid #f3f4f6' }}
                      onMouseEnter={e=>e.currentTarget.style.background='#f9fafb'}
                      onMouseLeave={e=>e.currentTarget.style.background=''}>
                      <td style={{ padding:'12px 14px', fontWeight:600, color:'#0a2342' }}>
                        {u.username ? '@'+u.username : <span style={{color:'#aaa',fontWeight:400,fontSize:11}}>Tài khoản cũ</span>}
                      </td>
                      <td style={{ padding:'12px 14px' }}>{u.name||'—'}</td>
                      <td style={{ padding:'12px 14px', color:'#555', fontSize:12 }}>{u.unit||'—'}</td>
                      <td style={{ padding:'12px 14px', fontSize:12 }}>
                        {u.email ? <a href={`mailto:${u.email}`} style={{ color:'#2563eb', textDecoration:'none' }}>{u.email}</a> : '—'}
                      </td>
                      <td style={{ padding:'12px 14px', color:'#888', fontSize:11 }}>
                        {u.createdAt?.toDate?u.createdAt.toDate().toLocaleDateString('vi-VN'):'—'}
                      </td>
                      <td style={{ padding:'12px 14px' }}><span style={badge(u.status)}>{u.status==='pending'?'Chờ duyệt':u.status==='approved'?'Đã duyệt':u.status==='rejected'?'Từ chối':'Admin'}</span></td>
                      <td style={{ padding:'12px 14px', whiteSpace:'nowrap' }}>
                        {u.status==='pending'&&<><button style={btn('green')} onClick={()=>setStatus(u.id,'approved')}>✓ Duyệt</button><button style={btn('red')} onClick={()=>setStatus(u.id,'rejected')}>✗ Từ chối</button></>}
                        {u.status==='approved'&&<>
                          <button style={btn('red')} onClick={()=>setStatus(u.id,'rejected')}>✗ Thu hồi</button>
                          <button style={{...btn('blue'), background:'#f59e0b'}} onClick={()=>promoteAdmin(u.id)}>👑 Admin</button>
                        </>}
                        {u.status==='rejected'&&<button style={btn('green')} onClick={()=>setStatus(u.id,'approved')}>✓ Duyệt lại</button>}
                        {u.status==='admin'&&u.username!=='hoangductu'&&<button style={{...btn('red')}} onClick={()=>revokeAdmin(u.id,u.username)}>👑 Thu hồi</button>}
                        {u.status!=='admin'&&<button style={{...btn('gray'), marginLeft:4}} onClick={()=>deleteUser(u.id, u.username||u.name||u.id)}>🗑️</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
        }
      </>}

      {/* ── Tab Quên mật khẩu ── */}
      {mainTab==='resets' && <>
        {resets.length===0
          ? <div style={{ padding:'48px', textAlign:'center', color:'#9ca3af', fontSize:14, background:'#f9fafb', borderRadius:12 }}>
              ✅ Không có yêu cầu đặt lại mật khẩu nào
            </div>
          : <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {resets.map(r=>(
                <div key={r.id} style={{ background:'#fff', borderRadius:12, border:'1px solid #fde68a', padding:'16px 20px', boxShadow:'0 2px 8px rgba(0,0,0,.06)' }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', flexWrap:'wrap', gap:12 }}>
                    <div>
                      <div style={{ fontSize:15, fontWeight:700, color:'#0a2342', marginBottom:4 }}>@{r.username} — {r.name}</div>
                      <div style={{ fontSize:12, color:'#555', marginBottom:2 }}>🏢 {r.unit||'—'}</div>
                      <div style={{ fontSize:12, color:'#2563eb', marginBottom:2 }}>
                        📧 Email: <strong><a href={`mailto:${r.contactEmail}`} style={{ color:'#2563eb' }}>{r.contactEmail}</a></strong>
                      </div>
                      <div style={{ fontSize:11, color:'#aaa', marginTop:4 }}>
                        Yêu cầu lúc: {r.requestAt?.toDate?r.requestAt.toDate().toLocaleString('vi-VN'):'—'}
                      </div>
                    </div>
                    <div style={{ display:'flex', gap:8, flexShrink:0 }}>
                      <button disabled={sending===r.id} onClick={()=>approveReset(r)}
                        style={{ padding:'8px 16px', background:sending===r.id?'#9ca3af':'#10b981', color:'#fff', border:'none', borderRadius:8, cursor:sending===r.id?'not-allowed':'pointer', fontSize:13, fontWeight:600 }}>
                        {sending===r.id ? '⏳ Đang gửi...' : '✅ Đồng ý'}
                      </button>
                      <button onClick={()=>rejectReset(r)}
                        style={{ padding:'8px 16px', background:'#ef4444', color:'#fff', border:'none', borderRadius:8, cursor:'pointer', fontSize:13, fontWeight:600 }}>
                        ❌ Từ chối
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
        }
      </>}
    </div>
  )
}
