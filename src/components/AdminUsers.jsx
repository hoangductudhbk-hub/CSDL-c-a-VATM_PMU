// src/components/AdminUsers.jsx
import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'

const badge = (s) => ({
  display:'inline-block', padding:'3px 10px', borderRadius:20, fontSize:11, fontWeight:600,
  background: s==='admin'?'#fef3c7': s==='approved'?'#d1fae5': s==='rejected'?'#fee2e2':'#e0e7ff',
  color:       s==='admin'?'#92400e': s==='approved'?'#065f46': s==='rejected'?'#991b1b':'#3730a3',
})
const btn = (c) => ({
  padding:'5px 14px', borderRadius:8, fontSize:12, cursor:'pointer', fontWeight:600, border:'none',
  background: c==='green'?'#10b981': c==='red'?'#ef4444':'#9ca3af', color:'#fff', marginRight:6,
})

export default function AdminUsers() {
  const [users,  setUsers]  = useState([])
  const [filter, setFilter] = useState('pending')

  useEffect(() => {
    return onSnapshot(collection(db, 'users'), snap =>
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .sort((a,b) => (b.createdAt?.seconds||0) - (a.createdAt?.seconds||0)))
    )
  }, [])

  const setStatus = (uid, status) => updateDoc(doc(db, 'users', uid), { status })

  const counts = {
    pending:  users.filter(u => u.status==='pending').length,
    approved: users.filter(u => u.status==='approved').length,
    rejected: users.filter(u => u.status==='rejected').length,
  }
  const filtered = filter === 'all' ? users.filter(u=>u.status!=='admin') : users.filter(u=>u.status===filter)

  return (
    <div style={{ padding:24, maxWidth:900, margin:'0 auto' }}>
      <div style={{ fontSize:20, fontWeight:700, color:'#0a2342', marginBottom:6 }}>👥 Quản lý người dùng</div>
      <p style={{ fontSize:13, color:'#888', marginBottom:20 }}>Duyệt hoặc từ chối các tài khoản đăng ký mới</p>

      {/* Stats */}
      <div style={{ display:'flex', gap:10, marginBottom:20 }}>
        {[['⏳ Chờ duyệt', counts.pending, '#fef3c7','#92400e'],
          ['✅ Đã duyệt',  counts.approved,'#d1fae5','#065f46'],
          ['❌ Từ chối',   counts.rejected,'#fee2e2','#991b1b']].map(([l,v,bg,c])=>(
          <div key={l} style={{ flex:1, background:bg, borderRadius:12, padding:'12px 16px', textAlign:'center' }}>
            <div style={{ fontSize:22, fontWeight:700, color:c }}>{v}</div>
            <div style={{ fontSize:12, color:c, fontWeight:500 }}>{l}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div style={{ display:'flex', gap:8, marginBottom:16 }}>
        {[['pending','⏳ Chờ duyệt'],['approved','✅ Đã duyệt'],['rejected','❌ Từ chối'],['all','Tất cả']].map(([v,l])=>(
          <button key={v} onClick={()=>setFilter(v)}
            style={{ padding:'6px 16px', borderRadius:20, fontSize:13, cursor:'pointer', border:'none', fontWeight:500,
              background: filter===v?'#0a2342':'#f3f4f6', color: filter===v?'#fff':'#374151' }}>
            {l}{v!=='all'&&` (${counts[v]||0})`}
          </button>
        ))}
      </div>

      {/* Table */}
      {filtered.length === 0
        ? <div style={{ padding:'40px', textAlign:'center', color:'#9ca3af', fontSize:14, background:'#f9fafb', borderRadius:12 }}>
            {filter==='pending' ? '✅ Không có tài khoản nào chờ duyệt' : 'Không có dữ liệu'}
          </div>
        : <div style={{ background:'#fff', borderRadius:12, border:'0.5px solid #e5e7eb', overflow:'hidden' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:13 }}>
              <thead style={{ background:'#f9fafb' }}>
                <tr>
                  {['Tên đăng nhập','Họ tên','Đơn vị công tác','Ngày đăng ký','Trạng thái','Hành động'].map(h=>(
                    <th key={h} style={{ textAlign:'left', padding:'12px 16px', color:'#6b7280', fontWeight:600, borderBottom:'1px solid #e5e7eb' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(u=>(
                  <tr key={u.id} style={{ borderBottom:'1px solid #f3f4f6' }}
                    onMouseEnter={e=>e.currentTarget.style.background='#f9fafb'}
                    onMouseLeave={e=>e.currentTarget.style.background=''}>
                    <td style={{ padding:'12px 16px', fontWeight:600, color:'#0a2342' }}>
                      @{u.username||'—'}
                    </td>
                    <td style={{ padding:'12px 16px' }}>{u.name||'—'}</td>
                    <td style={{ padding:'12px 16px', color:'#555' }}>{u.unit||'—'}</td>
                    <td style={{ padding:'12px 16px', color:'#888', fontSize:11 }}>
                      {u.createdAt?.toDate ? u.createdAt.toDate().toLocaleDateString('vi-VN') : '—'}
                    </td>
                    <td style={{ padding:'12px 16px' }}>
                      <span style={badge(u.status)}>
                        {u.status==='pending'?'Chờ duyệt': u.status==='approved'?'Đã duyệt': u.status==='rejected'?'Từ chối':'Admin'}
                      </span>
                    </td>
                    <td style={{ padding:'12px 16px' }}>
                      {u.status==='pending' && <>
                        <button style={btn('green')} onClick={()=>setStatus(u.id,'approved')}>✓ Duyệt</button>
                        <button style={btn('red')}   onClick={()=>setStatus(u.id,'rejected')}>✗ Từ chối</button>
                      </>}
                      {u.status==='approved' && <button style={btn('red')}  onClick={()=>setStatus(u.id,'rejected')}>✗ Thu hồi</button>}
                      {u.status==='rejected' && <button style={btn('green')} onClick={()=>setStatus(u.id,'approved')}>✓ Duyệt lại</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      }
    </div>
  )
}
