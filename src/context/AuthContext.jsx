// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from 'firebase/auth'
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp } from 'firebase/firestore'
import { auth, db } from '../firebase'

const Ctx = createContext(null)

// Username admin cứng — không cần duyệt
const ADMIN_USERNAMES = ['hoangductu']
const FAKE_DOMAIN     = '@vatm-pmu.local'
const toFakeEmail     = (u) => `${u.trim().toLowerCase()}${FAKE_DOMAIN}`

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(undefined)  // Firebase user
  const [userDoc, setUserDoc] = useState(null)        // Firestore doc
  const [authErr, setAuthErr] = useState('')

  const loadUserDoc = async (uid) => {
    const snap = await getDoc(doc(db, 'users', uid))
    if (snap.exists()) setUserDoc(snap.data())
  }

  useEffect(() => {
    return onAuthStateChanged(auth, async (u) => {
      if (!u) { setUser(null); setUserDoc(null); return }
      setUser(u)
      await loadUserDoc(u.uid)
    })
  }, [])

  // ── Đăng nhập ──────────────────────────────────────────────
  const login = async (username, password) => {
    setAuthErr('')
    try {
      await signInWithEmailAndPassword(auth, toFakeEmail(username), password)
    } catch (e) {
      if (e.code === 'auth/user-not-found' || e.code === 'auth/wrong-password' || e.code === 'auth/invalid-credential')
        throw new Error('Tên đăng nhập hoặc mật khẩu không đúng.')
      throw new Error('Đăng nhập thất bại. Vui lòng thử lại.')
    }
  }

  // ── Đăng ký ────────────────────────────────────────────────
  const register = async ({ username, password, name, unit }) => {
    setAuthErr('')
    const uname = username.trim().toLowerCase()

    // Kiểm tra username đã tồn tại chưa
    const q    = query(collection(db, 'users'), where('username', '==', uname))
    const snap = await getDocs(q)
    if (!snap.empty) throw new Error('Tên đăng nhập đã được sử dụng. Vui lòng chọn tên khác.')

    // Tạo tài khoản Firebase Auth
    const cred = await createUserWithEmailAndPassword(auth, toFakeEmail(uname), password)

    const isAdmin = ADMIN_USERNAMES.includes(uname)

    // Lưu vào Firestore
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid:       cred.user.uid,
      username:  uname,
      name:      name.trim(),
      unit:      unit.trim(),
      status:    isAdmin ? 'admin' : 'pending',
      createdAt: serverTimestamp(),
    })

    // Gửi email thông báo cho admin (qua EmailJS nếu đã cấu hình)
    try {
      if (window.emailjs && !isAdmin) {
        await window.emailjs.send('vatm_service', 'vatm_notify', {
          to_email: 'hoangductudhbk@gmail.com',
          username:  uname,
          name:      name.trim(),
          unit:      unit.trim(),
          time:      new Date().toLocaleString('vi-VN'),
        })
      }
    } catch(_) { /* email fail không ảnh hưởng đăng ký */ }

    await loadUserDoc(cred.user.uid)
  }

  const logout = () => { signOut(auth); setUserDoc(null) }

  const status    = ADMIN_USERNAMES.includes(userDoc?.username) ? 'admin' : (userDoc?.status || null)
  const isAdmin   = status === 'admin'
  const isApproved = status === 'approved' || status === 'admin'

  return (
    <Ctx.Provider value={{ user, userDoc, status, isAdmin, isApproved, login, register, logout, authErr }}>
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
