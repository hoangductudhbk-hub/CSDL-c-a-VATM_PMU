import { useState, useEffect } from 'react'
import {
  collection, query, where,
  onSnapshot, addDoc, updateDoc, deleteDoc, getDocs,
  doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase'

// Trường `date` (ngày văn bản được ký/ban hành) là TEXT TỰ DO — AI trích xuất
// ra dạng "D/M/YYYY" (không pad số 0, vd "5/1/2026"), người dùng nhập tay có
// thể gõ "08/2025" (chỉ tháng/năm) hoặc bất kỳ format khác. Vì vậy phải parse
// linh hoạt nhiều dạng rồi quy về 1 số có thể so sánh được (YYYYMMDD), thay vì
// chỉ string-compare (sẽ sai vì không pad số 0 và không cùng số chữ số).
// Trả về null nếu không parse được — các văn bản này bị đẩy xuống cuối danh
// sách (không có ngày ký thì không thể đặt đúng vị trí trên dòng thời gian).
const dateSortValue = (raw) => {
  if (!raw) return null
  const s = String(raw).trim()

  // "ngày D tháng M năm YYYY"
  let m = s.match(/ngày\s*(\d{1,2})\s*tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i)
  if (m) return Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1])

  // "D/M/YYYY" hoặc "D-M-YYYY" (đúng thứ tự AI đang lưu: ngày/tháng/năm)
  m = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])
    return y * 10000 + Number(m[2]) * 100 + Number(m[1])
  }

  // "tháng M năm YYYY" hoặc "M/YYYY" — chỉ có tháng/năm, không có ngày cụ thể
  m = s.match(/tháng\s*(\d{1,2})\s*năm\s*(\d{4})/i) || s.match(/^(\d{1,2})[\/-](\d{4})$/)
  if (m) return Number(m[2]) * 10000 + Number(m[1]) * 100 + 1

  // chỉ có năm
  m = s.match(/(\d{4})/)
  if (m) return Number(m[1]) * 10000 + 100 + 1

  return null
}

export function useDocuments(projectId, userId, packageId = null) {
  const [allDocs, setAllDocs] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId || !userId) return
    const q = query(
      collection(db, 'documents'),
      where('projectId', '==', projectId)
    )
    const unsub = onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      // Sắp xếp theo NGÀY VĂN BẢN ĐƯỢC KÝ/BAN HÀNH (trường `date`), không phải
      // ngày upload lên hệ thống (createdAt) — để đúng dòng thời gian thực hiện
      // dự án/quy định/biểu mẫu. Cũ nhất lên trước (đọc trên→dưới = quá khứ→
      // hiện tại). Văn bản không có ngày ký hợp lệ bị đẩy xuống cuối, sắp xếp
      // phụ theo thời gian upload để vẫn ổn định (không nhảy lung tung mỗi lần
      // render lại).
      list.sort((a, b) => {
        const va = dateSortValue(a.date)
        const vb = dateSortValue(b.date)
        if (va == null && vb == null) return (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0)
        if (va == null) return 1
        if (vb == null) return -1
        return va - vb
      })
      setAllDocs(list)
      setLoading(false)
    })
    return unsub
  }, [projectId, userId])

  // Lọc theo gói thầu nếu có
  const docs = packageId
    ? allDocs.filter(d => d.packageId === packageId)
    : allDocs

  const addDocument = (data, silent) =>
    addDoc(collection(db, 'documents'), {
      ...data,
      projectId,
      packageId: packageId || null,
      uploadedBy: userId,
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
    })

  const updateDocument = (id, data) =>
    updateDoc(doc(db, 'documents', id), {
      ...data,
      updatedAt: serverTimestamp(),
    })

  const deleteDocument = async (id) => {
    // Xóa văn bản trong Firestore
    await deleteDoc(doc(db, 'documents', id))

    // Xóa bộ nhớ AI + markdown + job xử lý — không catch silently, để lỗi lan ra ngoài
    await Promise.allSettled([
      deleteDoc(doc(db, 'documentMemory', id)),
      deleteDoc(doc(db, 'documentMarkdown', id)),
      deleteDoc(doc(db, 'processingJobs', id)),
    ])

    // Xóa nhật ký hoạt động
    try {
      const logsSnap = await getDocs(query(collection(db, 'activityLogs'), where('docId', '==', id)))
      await Promise.all(logsSnap.docs.map(l => deleteDoc(doc(db, 'activityLogs', l.id))))
    } catch {}
  }

  return { docs, allDocs, loading, addDocument, updateDocument, deleteDocument }
}