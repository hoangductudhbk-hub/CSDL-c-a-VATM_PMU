import { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { auth, googleProvider, db } from '../firebase'

const Ctx = createContext(null)

// ── Email admin — đổi thành email của bạn ──
const ADMIN_EMAILS = ['hoangductudhbk@gmail.com']

export function AuthProvider({ children }) {
  const [user,      setUser]      = useState(undefined)  // undefined = đang load
  const [status,    setStatus]    = useState(null)        // 'pending' | 'approved' | 'rejected' | 'admin'
  const [error,     setError]     = useState(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) { setUser(null); setStatus(null); return }
      setUser(u)

      // Admin bypass
      if (ADMIN_EMAILS.includes(u.email)) { setStatus('admin'); return }

      // Kiểm tra trạng thái trong Firestore
      const ref  = doc(db, 'users', u.uid)
      const snap = await getDoc(ref)

      if (!snap.exists()) {
        // Lần đầu đăng nhập → tạo yêu cầu pending
        await setDoc(ref, {
          uid:        u.uid,
          email:      u.email,
          name:       u.displayName,
          photo:      u.photoURL,
          status:     'pending',
          requestAt:  serverTimestamp(),
        })
        setStatus('pending')
      } else {
        setStatus(snap.data().status || 'pending')
      }
    })
    return unsub
  }, [])

  const loginWithGoogle = async () => {
    setError(null)
    try {
      await signInWithPopup(auth, googleProvider)
    } catch (e) {
      if (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') {
        setError(e.message)
      }
    }
  }

  const logout = () => { signOut(auth); setStatus(null) }
  const isAdmin    = status === 'admin'
  const isApproved = status === 'approved' || status === 'admin'

  return (
    <Ctx.Provider value={{ user, status, isAdmin, isApproved, loginWithGoogle, logout, error }}>
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
