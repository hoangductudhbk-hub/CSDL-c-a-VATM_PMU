// src/components/ChangePassword.jsx
import { useState } from 'react'
import { updatePassword, reauthenticateWithCredential, EmailAuthProvider } from 'firebase/auth'
import { auth } from '../firebase'
import { useAuth } from '../context/AuthContext'

const FAKE_DOMAIN = '@vatm-pmu.local'

export default function ChangePassword({ onClose }) {
  const { userDoc } = useAuth()
  const [oldPw,  setOldPw]  = useState('')
  const [newPw,  setNewPw]  = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [loading, setLoading] = useState(false)
  const [err,    setErr]    = useState('')
  const [ok,     setOk]     = useState(false)

  const handleSubmit = async () => {
    setErr('')
    if (!oldPw || !newPw || !newPw2) return setErr('Vui lòng điền đầy đủ thông tin.')
    if (newPw.length < 6) return setErr('Mật khẩu mới phải có ít nhất 6 ký tự.')
    if (newPw !== newPw2) return setErr('Mật khẩu mới không khớp.')
    if (newPw === oldPw) return setErr('Mật khẩu mới phải khác mật khẩu cũ.')

    setLoading(true)
    try {
      const user      = auth.currentUser
      const fakeEmail = `${userDoc.username}${FAKE_DOMAIN}`
      const cred      = EmailAuthProvider.credential(fakeEmail, oldPw)

      // Xác thực lại với mật khẩu cũ
      await reauthenticateWithCredential(user, cred)

      // Đổi mật khẩu mới
      await updatePassword(user, newPw)

      setOk(true)
    } catch (e) {
      if (e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential')
        setErr('Mật khẩu hiện tại không đúng.')
      else if (e.code === 'auth/too-many-requests')
        setErr('Thử quá nhiều lần. Vui lòng thử lại sau.')
      else
        setErr('Lỗi: ' + e.message)
    } finally {
      setLoading(false)
    }
  }

  const iSt = {
    width: '100%', padding: '11px 14px', border: '0.5px solid #ddd',
    borderRadius: 10, fontSize: 13, outline: 'none',
    boxSizing: 'border-box', fontFamily: 'inherit',
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 9999,
    }}>
      <div style={{
        background: '#fff', borderRadius: 20, padding: '32px 36px',
        boxShadow: '0 20px 60px rgba(0,0,0,0.2)', maxWidth: 420, width: '90%',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: '#111' }}>🔑 Đổi mật khẩu</div>
            <div style={{ fontSize: 12, color: '#888', marginTop: 3 }}>@{userDoc?.username}</div>
          </div>
          {onClose && (
            <button onClick={onClose} style={{
              background: 'none', border: 'none', fontSize: 20,
              cursor: 'pointer', color: '#aaa', padding: '0 4px',
            }}>✕</button>
          )}
        </div>

        {ok ? (
          <div style={{ textAlign: 'center', padding: '16px 0' }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: '#065f46', marginBottom: 8 }}>
              Đổi mật khẩu thành công!
            </div>
            <div style={{ fontSize: 13, color: '#888', marginBottom: 24 }}>
              Lần đăng nhập tiếp theo dùng mật khẩu mới nhé.
            </div>
            <button onClick={onClose} style={{
              padding: '11px 32px', borderRadius: 12, border: 'none',
              background: '#0a2342', color: '#fff', fontWeight: 700,
              fontSize: 14, cursor: 'pointer',
            }}>Đóng</button>
          </div>
        ) : (
          <>
            {err && (
              <div style={{
                fontSize: 12, color: '#dc2626', marginBottom: 14,
                padding: '9px 12px', background: '#fef2f2',
                borderRadius: 8, border: '0.5px solid #fecaca',
              }}>⚠️ {err}</div>
            )}

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
                Mật khẩu hiện tại
              </label>
              <input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)}
                placeholder="Nhập mật khẩu hiện tại" style={iSt} />
            </div>

            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
                Mật khẩu mới
              </label>
              <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)}
                placeholder="Ít nhất 6 ký tự" style={iSt} />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: '#374151', display: 'block', marginBottom: 5 }}>
                Xác nhận mật khẩu mới
              </label>
              <input type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)}
                placeholder="Nhập lại mật khẩu mới" style={iSt}
                onKeyDown={e => e.key === 'Enter' && handleSubmit()} />
            </div>

            <div style={{ display: 'flex', gap: 10 }}>
              <button onClick={handleSubmit} disabled={loading} style={{
                flex: 1, padding: '12px', borderRadius: 12, border: 'none',
                background: loading ? '#9ca3af' : '#0a2342',
                color: '#fff', fontWeight: 700, fontSize: 14,
                cursor: loading ? 'not-allowed' : 'pointer',
              }}>
                {loading ? '⏳ Đang xử lý...' : '🔑 Đổi mật khẩu'}
              </button>
              {onClose && (
                <button onClick={onClose} style={{
                  padding: '12px 20px', borderRadius: 12,
                  border: '1px solid #e5e7eb', background: '#f9fafb',
                  color: '#6b7280', fontWeight: 600, fontSize: 14, cursor: 'pointer',
                }}>Hủy</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
