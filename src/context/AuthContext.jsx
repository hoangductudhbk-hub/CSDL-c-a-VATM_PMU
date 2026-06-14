// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from 'firebase/auth'
import { doc, getDoc, setDoc, collection, query, where, getDocs, serverTimestamp, addDoc } from 'firebase/firestore'
import emailjs from '@emailjs/browser'

// Khởi tạo EmailJS
emailjs.init(import.meta.env.VITE_EMAILJS_PUBLIC_KEY)
import { auth, db } from '../firebase'

const Ctx = createContext(null)
const ADMIN_USERNAMES = ['hoangductu']
const FAKE_DOMAIN     = '@vatm-pmu.local'
const toFakeEmail     = (u) => `${u.trim().toLowerCase()}${FAKE_DOMAIN}`

export function AuthProvider({ children }) {
  const [user,    setUser]    = useState(undefined)
  const [userDoc, setUserDoc] = useState(null)

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

  // ── Đăng nhập ──
  const login = async (username, password) => {
    try {
      await signInWithEmailAndPassword(auth, toFakeEmail(username), password)
    } catch (e) {
      if (['auth/user-not-found','auth/wrong-password','auth/invalid-credential'].includes(e.code))
        throw new Error('Tên đăng nhập hoặc mật khẩu không đúng.')
      throw new Error('Đăng nhập thất bại. Vui lòng thử lại.')
    }
  }

  // ── Đăng ký ──
  const register = async ({ username, password, name, unit, email }) => {
    const uname = username.trim().toLowerCase()
    // Kiểm tra username đã tồn tại chưa
    const q    = query(collection(db, 'users'), where('username', '==', uname))
    const snap = await getDocs(q)
    if (!snap.empty) throw new Error('Tên đăng nhập đã được sử dụng. Vui lòng chọn tên khác.')

    // Kiểm tra email đã đăng ký chưa
    const emailLower = email.trim().toLowerCase()
    const qEmail = query(collection(db, 'users'), where('email', '==', emailLower))
    const snapEmail = await getDocs(qEmail)
    if (!snapEmail.empty) throw new Error('Email này đã được dùng để đăng ký tài khoản khác.')

    const cred = await createUserWithEmailAndPassword(auth, toFakeEmail(uname), password)
    const isAdmin = ADMIN_USERNAMES.includes(uname)

    await setDoc(doc(db, 'users', cred.user.uid), {
      uid:       cred.user.uid,
      username:  uname,
      name:      name.trim(),
      unit:      unit.trim(),
      email:     email.trim().toLowerCase(),
      status:    isAdmin ? 'admin' : 'pending',
      createdAt: serverTimestamp(),
    })
    await loadUserDoc(cred.user.uid)
  }

  // ── Quên mật khẩu — gửi yêu cầu ──
  const requestReset = async (username, contactEmail) => {
    const uname = username.trim().toLowerCase()
    const q    = query(collection(db, 'users'), where('username', '==', uname))
    const snap = await getDocs(q)
    if (snap.empty) throw new Error('Tên đăng nhập không tồn tại.')

    const userData = snap.docs[0].data()

    // Lưu vào Firestore
    await addDoc(collection(db, 'resetRequests'), {
      uid:          userData.uid,
      username:     uname,
      name:         userData.name,
      unit:         userData.unit,
      email:        userData.email || contactEmail,
      contactEmail: contactEmail,
      fakeEmail:    toFakeEmail(uname),
      status:       'pending',
      requestAt:    serverTimestamp(),
    })

    // Gửi email thông báo cho admin qua EmailJS
    try {
      await emailjs.send(
        import.meta.env.VITE_EMAILJS_SERVICE_ID,
        import.meta.env.VITE_EMAILJS_TEMPLATE_ID,
        {
          username:      uname,
          name:          userData.name || '—',
          unit:          userData.unit || '—',
          contact_email: contactEmail,
          time:          new Date().toLocaleString('vi-VN'),
        },
      )
    } catch(e) {
      console.warn('EmailJS error:', e)
      // Không throw — Firestore đã lưu rồi, email fail không sao
    }
  }

  const logout = () => { signOut(auth); setUserDoc(null) }

  const status     = ADMIN_USERNAMES.includes(userDoc?.username) ? 'admin' : (userDoc?.status || null)
  const isAdmin    = status === 'admin'
  const isApproved = status === 'approved' || status === 'admin'

  return (
    <Ctx.Provider value={{ user, userDoc, status, isAdmin, isApproved, login, register, logout, requestReset }}>
      {children}
    </Ctx.Provider>
  )
}

export const useAuth = () => useContext(Ctx)
