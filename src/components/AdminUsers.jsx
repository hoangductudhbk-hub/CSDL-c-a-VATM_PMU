// src/components/AdminUsers.jsx
import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'

const S = {
  wrap:    { padding:'24px', maxWidth:900, margin:'0 auto' },
  title:   { fontSize:20, fontWeight:600, marginBottom:16 },
  table:   { width:'100%', borderCollapse:'collapse', fontSize:13 },
  th:      { textAlign:'left', padding:'10px 12px', borderBottom:'1px solid #e5e7eb', color:'#6b7280', fontWeight:500 },
  td:      { padding:'10px 12px', borderBottom:'1px solid #f3f4f6', verticalAlign:'middle' },
  avatar:  { width:32, height:32, borderRadius:'50%', marginRight:8, verticalAlign:'middle' },
  badge:   (s) => ({
    display:'inline-block', padding:'2px 10px', borderRadius:20, fontSize:11, fontWeight:500,
    background: s==='approved'?'#d1fae5': s==='rejected'?'#fee2e2': '#fef3c7',
    color:       s==='approved'?'#065f46': s==='rejected'?'#991b1b': '#92400e',
  }),
  btn:     (color) => ({
    padding:'4px 12px', borderRadius:6, fontSize:12, cursor:'pointer', fontWeight:500, border:'none',
    background: color==='green'?'#10b981': color==='red'?'#ef4444': '#6b7280',
    color:'#fff', marginRight:6,
  }),
  tabs:    { display:'flex', gap:8, marginBottom:16 },
  tab:     (active) => ({
    padding:'6px 16px', borderRadius:20, fontSize:13, cursor:'pointer', border:'none', fontWeight:500,
    background: active ? '#1e40af' : '#f3f4f6',
    color:      active ? '#fff'    : '#374151',
  }),
}

export default function AdminUsers() {
  const [users,  setUsers]  = useState([])
  const [filter, setFilter] = useState('pending')

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), snap => {
      setUsers(snap.docs.map(d => ({ id: d.id, ...d.data() })))
    })
    return unsub
  }, [])

  const setStatus = async (uid, status) => {
    await updateDoc(doc(db, 'users', uid), { status })
  }

  const counts = {
    pending:  users.filter(u => u.status === 'pending').length,
    approved: users.filter(u => u.status === 'approved').length,
    rejected: users.filter(u => u.status === 'rejected').length,
  }

  const filtered = users.filter(u => u.status === filter)

  return (
    <div style={S.wrap}>
      <div style={S.title}>👥 Quản lý người dùng</div>

      <div style={S.tabs}>
        {['pending','approved','rejected'].map(t => (
          <button key={t} style={S.tab(filter===t)} onClick={() => setFilter(t)}>
            {t==='pending'?'⏳ Chờ duyệt': t==='approved'?'✅ Đã duyệt':'❌ Từ chối'}
            {' '}({counts[t]})
          </button>
        ))}
      </div>

      {filtered.length === 0
        ? <div style={{ color:'#9ca3af', fontSize:14, padding:'24px 0' }}>Không có người dùng nào</div>
        : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Người dùng</th>
                <th style={S.th}>Email</th>
                <th style={S.th}>Ngày đăng ký</th>
                <th style={S.th}>Trạng thái</th>
                <th style={S.th}>Hành động</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(u => (
                <tr key={u.id}>
                  <td style={S.td}>
                    {u.photo && <img src={u.photo} style={S.avatar} alt="" />}
                    {u.name || '—'}
                  </td>
                  <td style={S.td}>{u.email}</td>
                  <td style={S.td}>
                    {u.requestAt?.toDate
                      ? u.requestAt.toDate().toLocaleDateString('vi-VN')
                      : '—'}
                  </td>
                  <td style={S.td}>
                    <span style={S.badge(u.status)}>{u.status}</span>
                  </td>
                  <td style={S.td}>
                    {u.status !== 'approved' &&
                      <button style={S.btn('green')} onClick={() => setStatus(u.id,'approved')}>✓ Duyệt</button>}
                    {u.status !== 'rejected' &&
                      <button style={S.btn('red')}   onClick={() => setStatus(u.id,'rejected')}>✗ Từ chối</button>}
                    {u.status !== 'pending' &&
                      <button style={S.btn('gray')}  onClick={() => setStatus(u.id,'pending')}>↩ Pending</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      }
    </div>
  )
}
