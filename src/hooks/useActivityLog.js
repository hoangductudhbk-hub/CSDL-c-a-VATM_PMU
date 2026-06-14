import { useRef } from 'react'
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

export function useActivityLog(user, userDoc) {
  const loginTimeRef = useRef(null)

  const log = async (action, details) => {
    if (!user?.uid) return
    try {
      await addDoc(collection(db, 'activityLogs'), {
        userId:    user.uid,
        userEmail: userDoc?.email || '',
        userName:  userDoc?.name || userDoc?.username || user.uid,
        username:  userDoc?.username || '',
        action,
        details,
        timestamp: serverTimestamp(),
      })
    } catch (e) {
      console.warn('Không ghi được log:', e.message)
    }
  }

  const logLogin = () => {
    loginTimeRef.current = Date.now()
    return log('login', 'Đăng nhập vào hệ thống')
  }
  const logLogout = () => {
    const mins = loginTimeRef.current
      ? Math.round((Date.now() - loginTimeRef.current) / 60000)
      : 0
    return log('logout', `Đăng xuất — thời gian sử dụng: ${mins} phút`)
  }

  const logViewDoc    = (code, subject, projName) =>
    log('view_doc',      `Mở đọc văn bản: [${code||'Chưa có số'}] "${subject||'—'}" trong dự án "${projName||'—'}"`)
  const logAddDoc     = (code, subject, projName) =>
    log('add_doc',       `Thêm văn bản mới: [${code||'Chưa có số'}] "${subject||'—'}" vào dự án "${projName||'—'}"`)
  const logEditDoc    = (code, subject, projName) =>
    log('edit_doc',      `Chỉnh sửa văn bản: [${code||'Chưa có số'}] "${subject||'—'}" trong dự án "${projName||'—'}"`)
  const logDeleteDoc  = (code, subject, projName) =>
    log('delete_doc',    `⚠️ Xóa văn bản: [${code||'Chưa có số'}] "${subject||'—'}" khỏi dự án "${projName||'—'}"`)
  const logStatus     = (code, oldStatus, newStatus, projName) =>
    log('status',        `Đổi trạng thái [${code||'—'}] từ "${oldStatus}" → "${newStatus}" trong dự án "${projName||'—'}"`)
  const logUploadFile = (code, fileName, projName) =>
    log('upload_file',   `Upload file đính kèm: "${fileName||'—'}" cho văn bản [${code||'—'}] trong dự án "${projName||'—'}"`)
  const logAddProj    = (name) =>
    log('add_project',   `Tạo dự án mới: "${name}"`)
  const logDeleteProj = (name) =>
    log('delete_project',`⚠️ Xóa dự án: "${name}"`)
  const logExportReport = (projName) =>
    log('export_report', `Xuất báo cáo Word cho dự án "${projName||'—'}"`)

  const loadLogs = (callback, currentUserId, isAdmin) => {
    const q = query(collection(db, 'activityLogs'), orderBy('timestamp', 'desc'), limit(500))
    return onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // Admin thấy tất cả, user thường chỉ thấy của mình
      const filtered = isAdmin ? all : all.filter(l => l.userId === currentUserId)
      callback(filtered)
    })
  }

  return {
    logLogin, logLogout,
    logViewDoc, logAddDoc, logEditDoc, logDeleteDoc, logStatus, logUploadFile,
    logAddProj, logDeleteProj, logExportReport,
    loadLogs,
  }
}
