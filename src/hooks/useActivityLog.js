import { useRef, useEffect } from 'react'
import { collection, addDoc, query, orderBy, limit, onSnapshot, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

export function useActivityLog(user, userDoc) {
  const loginTimeRef = useRef(null)
  const userDocRef   = useRef(userDoc)

  // Luôn cập nhật ref khi userDoc thay đổi
  useEffect(() => { userDocRef.current = userDoc }, [userDoc])

  const log = async (action, details, docId = null) => {
    if (!user?.uid) return
    const doc = userDocRef.current
    try {
      await addDoc(collection(db, 'activityLogs'), {
        userId:    user.uid,
        userEmail: doc?.email || '',
        userName:  doc?.name || doc?.username || '',
        username:  doc?.username || '',
        action,
        details,
        docId,
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

  const logViewDoc     = (code, subject, projName, docId) =>
    log('view_doc',       `Mở đọc văn bản: [${code||'Chưa có số'}] "${subject||'—'}" trong dự án "${projName||'—'}"`, docId)
  const logAddDoc      = (code, subject, projName, docId) =>
    log('add_doc',        `Thêm văn bản mới: [${code||'Chưa có số'}] "${subject||'—'}" vào dự án "${projName||'—'}"`, docId)
  const logEditDoc     = (code, subject, projName, docId) =>
    log('edit_doc',       `Chỉnh sửa văn bản: [${code||'Chưa có số'}] "${subject||'—'}" trong dự án "${projName||'—'}"`, docId)
  const logDeleteDoc   = (code, subject, projName, docId) =>
    log('delete_doc',     `⚠️ Xóa văn bản: [${code||'Chưa có số'}] "${subject||'—'}" khỏi dự án "${projName||'—'}"`, docId)
  const logStatus      = (code, oldS, newS, projName, docId) =>
    log('status',         `Đổi trạng thái [${code||'—'}] từ "${oldS}" → "${newS}" trong dự án "${projName||'—'}"`, docId)
  const logUploadFile  = (code, fileName, projName, docId) =>
    log('upload_file',    `Upload file: "${fileName||'—'}" cho văn bản [${code||'—'}] trong dự án "${projName||'—'}"`, docId)
  const logAddProj     = (name) =>
    log('add_project',    `Tạo dự án mới: "${name}"`)
  const logDeleteProj  = (name) =>
    log('delete_project', `⚠️ Xóa dự án: "${name}"`)
  const logExportReport = (projName) =>
    log('export_report',  `Xuất báo cáo Word cho dự án "${projName||'—'}"`)

  const loadLogs = (callback, currentUserId, isAdmin) => {
    const q = query(collection(db, 'activityLogs'), orderBy('timestamp', 'desc'), limit(500))
    return onSnapshot(q, snap => {
      const all = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      callback(all)
    })
  }

  return {
    logLogin, logLogout,
    logViewDoc, logAddDoc, logEditDoc, logDeleteDoc, logStatus, logUploadFile,
    logAddProj, logDeleteProj, logExportReport,
    loadLogs,
  }
}
