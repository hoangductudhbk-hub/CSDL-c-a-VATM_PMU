// src/components/AdminUsers.jsx
import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc, deleteDoc, query, where } from 'firebase/firestore'
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

// Tạo mật khẩu tạm ngẫu nhiên
const genTempPassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'
  const special = '!@#$'
  let pw = ''
  for (let i = 0; i < 6; i++) pw += chars[Math.floor(Math.random() * chars.length)]
  pw += special[Math.floor(Math.random() * special.length)]
  pw += Math.floor(Math.random() * 90 + 10)
  return pw
}

export default function AdminUsers() {
  const [users,    setUsers]    = useState([])
  const [resets,   setResets]   = useState([])
  const [filter,   setFilter]   = useState('pending')
  const [mainTab,  setMainTab]  = useState('users')
  const [sending,  setSending]  = useState(null) // id đang xử lý

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
  const deleteUser = (id, name)    => { if(confirm('Xóa hoàn toàn tài khoản '+name+'? Không thể hoàn tác!')) deleteDoc(doc(db,'users',id)) }

  // Đồng ý reset → tạo mật khẩu tạm → gửi email cho user
  const approveReset = async (r) => {
    if (!confirm('Đồng ý và gửi mật khẩu tạm cho @'+r.username+'?')) return
    setSending(r.id)
    try {
      const tempPw = genTempPassword()

      // Gửi email cho user
      await emailjs.send(
        import.meta.env.VITE_EMAILJS_SERVICE_ID,
        import.meta.env.VITE_EMAILJS_USER_TEMPLATE_ID,
        {
          name:          r.name || r.username,
          username:      r.username,
          temp_password: tempPw,
          user_email:    r.contactEmail,
        },
        import.meta.env.VITE_EMAILJS_PUBLIC_KEY
      )

      // Lưu mật khẩu tạm vào Firestore để admin tham khảo
      await updateDoc(doc(db,'resetRequests',r.id), {
        status:       'done',
        tempPassword: tempPw,
        resolvedAt:   new Date(),
      })

      alert('✅ Đã gửi mật khẩu tạm "' + tempPw + '" đến email: ' + r.contactEmail)
    } catch(e) {
      console.error(e)
      alert('❌ Lỗi gửi email: ' + e.message)
    } finally {
      setSending(null)
    }
  }

  // Từ chối reset
  const rejectReset = async (r) => {
    if (!confirm('Từ chối yêu cầu của @'+r.username+'?')) return
    await updateDoc(doc(db,'resetRequests',r.id), { status: 'rejected' })
  }

  const counts = {
    pending:  users.filter(u=>u.status==='pending').length,
    approved: users.filter(u=>u.status==='approved').length,
    rejected: users.filter(u=>u.status==='rejected').length,
  }
  const filtered = filter==='all'
    ? users.filter(u=>u.status!=='admin')
    : users.filter(u=>u.status===filter)

  return (
    <div style={{ padding:24, maxWidth:960, margin:'0 auto' }}>
      <div style={{ fontSize:20, fontWeight:700, color:'#0a2342', marginBottom:6 }}>👥 Quản lý người dùng</div>
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
            ['rejected','❌',counts.rejected,'#fee2e2','#991b1b']].map(([v,icon,n,bg,c])=>(
            <div key={v} onClick={()=>setFilter(v)}
              style={{ flex:1, background:filter===v?bg:'#f9fafb', borderRadius:12, padding:'12px 16px', textAlign:'center', cursor:'pointer',
                border:`1.5px solid ${filter===v?c:'#e5e7eb'}` }}>
              <div style={{ fontSize:22, fontWeight:700, color:c }}>{n}</div>
              <div style={{ fontSize:12, color:c, fontWeight:500 }}>{icon} {v==='pending'?'Chờ duyệt':v==='approved'?'Đã duyệt':'Từ chối'}</div>
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
                        {u.status==='approved'&&<button style={btn('red')} onClick={()=>setStatus(u.id,'rejected')}>✗ Thu hồi</button>}
                        {u.status==='rejected'&&<button style={btn('green')} onClick={()=>setStatus(u.id,'approved')}>✓ Duyệt lại</button>}
                        <button style={{...btn('gray'), marginLeft:4}} onClick={()=>deleteUser(u.id, u.username||u.name||u.id)}>🗑️</button>
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
                      <button
                        disabled={sending===r.id}
                        onClick={()=>approveReset(r)}
                        style={{ padding:'8px 16px', background: sending===r.id?'#9ca3af':'#10b981', color:'#fff', border:'none', borderRadius:8, cursor:sending===r.id?'not-allowed':'pointer', fontSize:13, fontWeight:600 }}>
                        {sending===r.id ? '⏳ Đang gửi...' : '✅ Đồng ý'}
                      </button>
                      <button
                        onClick={()=>rejectReset(r)}
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
