// src/context/AuthContext.jsx
import { createContext, useContext, useEffect, useState } from 'react'
import {
  onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from 'firebase/auth'
import { doc, getDoc, setDoc, serverTimestamp, addDoc, collection } from 'firebase/firestore'
import { auth, db } from '../firebase'
import emailjs from '@emailjs/browser'

const Ctx = createContext(null)
const ADMIN_USERNAMES = ['hoangductu']
const FAKE_DOMAIN     = '@vatm-pmu.local'
const toFakeEmail     = (u) => `${u.trim().toLowerCase()}${FAKE_DOMAIN}`

// Tra cứu user theo username/email KHÔNG cần đăng nhập — gọi qua server
// (api/lookup-user.js, đọc Firestore bằng quyền admin) thay vì getDocs() thẳng
// từ client. Lý do: rule Firestore /users/{userId} yêu cầu isAuth() để đọc —
// đúng cho bảo mật — nhưng login bằng email / đăng ký kiểm tra trùng / quên
// mật khẩu đều cần đọc TRƯỚC khi có auth, nên trước đây bị lỗi
// "permission-denied" khi gọi getDocs() trực tiếp.
// mode='exists': chỉ trả {found}, không lộ thông tin cá nhân người khác (dùng
// cho register kiểm tra trùng). mode='full' (mặc định): trả thêm uid/username/
// name/unit/email (dùng cho login bằng email + quên mật khẩu, lúc này đang xác
// nhận đúng tài khoản của chính người gọi nên cần dữ liệu để tiếp tục xử lý).
const lookupUser = async (field, value, mode = 'full') => {
  const res = await fetch('/api/lookup-user', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ field, value, mode }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Lỗi server (${res.status})`)
  return data
}

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

  // ── Đăng nhập (username hoặc email) ──
  const login = async (usernameOrEmail, password) => {
    try {
      const input = usernameOrEmail.trim().toLowerCase()

      // Nếu có @ và domain thật → đăng nhập bằng email thật
      if (input.includes('@') && !input.endsWith(FAKE_DOMAIN)) {
        // Tìm username tương ứng với email này — qua server (xem lookupUser ở trên)
        const found = await lookupUser('email', input, 'full')
        if (!found.found) throw new Error('Email không tồn tại trong hệ thống.')
        await signInWithEmailAndPassword(auth, toFakeEmail(found.username), password)
      } else {
        // Đăng nhập bằng username
        await signInWithEmailAndPassword(auth, toFakeEmail(input), password)
      }
    } catch (e) {
      if (['auth/user-not-found','auth/wrong-password','auth/invalid-credential'].includes(e.code))
        throw new Error('Tên đăng nhập/email hoặc mật khẩu không đúng.')
      if (e.message.includes('không tồn tại')) throw e
      throw new Error('Đăng nhập thất bại. Vui lòng thử lại.')
    }
  }

  // ── Đăng ký ──
  const register = async ({ username, password, name, unit, email }) => {
    const uname = username.trim().toLowerCase()
    const exists1 = await lookupUser('username', uname, 'exists')
    if (exists1.found) throw new Error('Tên đăng nhập đã được sử dụng. Vui lòng chọn tên khác.')

    const emailLower = email.trim().toLowerCase()
    const exists2 = await lookupUser('email', emailLower, 'exists')
    if (exists2.found) throw new Error('Email này đã được dùng để đăng ký tài khoản khác.')

    const cred = await createUserWithEmailAndPassword(auth, toFakeEmail(uname), password)
    const isAdmin = ADMIN_USERNAMES.includes(uname)

    await setDoc(doc(db, 'users', cred.user.uid), {
      uid:       cred.user.uid,
      username:  uname,
      name:      name.trim(),
      unit:      unit.trim(),
      email:     emailLower,
      status:    isAdmin ? 'admin' : 'pending',
      createdAt: serverTimestamp(),
    })
    await loadUserDoc(cred.user.uid)
  }

  // ── Quên mật khẩu (username hoặc email) ──
  const requestReset = async (input) => {
    const val = input.trim().toLowerCase()

    // Tìm theo username trước, không thấy thì tìm theo email — qua server
    let userData = await lookupUser('username', val, 'full')
    if (!userData.found) userData = await lookupUser('email', val, 'full')
    if (!userData.found) throw new Error('Không tìm thấy tài khoản với thông tin này.')

    // Lưu vào Firestore (collection resetRequests cho phép write công khai, xem firestore.rules)
    await addDoc(collection(db, 'resetRequests'), {
      uid:          userData.uid,
      username:     userData.username,
      name:         userData.name,
      unit:         userData.unit,
      email:        userData.email || '',
      contactEmail: userData.email || '',
      fakeEmail:    toFakeEmail(userData.username),
      status:       'pending',
      requestAt:    serverTimestamp(),
    })

    // Gửi email thông báo cho admin
    try {
      await emailjs.send(
        import.meta.env.VITE_EMAILJS_SERVICE_ID,
        import.meta.env.VITE_EMAILJS_TEMPLATE_ID,
        {
          username:      userData.username,
          name:          userData.name || '—',
          unit:          userData.unit || '—',
          contact_email: userData.email || '—',
          time:          new Date().toLocaleString('vi-VN'),
        },
        import.meta.env.VITE_EMAILJS_PUBLIC_KEY
      )
    } catch(e) {
      console.warn('EmailJS error:', e)
    }

    return userData.email || ''
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
