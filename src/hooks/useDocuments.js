import { useState, useEffect } from 'react'
import {
  collection, query, where,
  onSnapshot, addDoc, updateDoc, deleteDoc, getDocs,
  doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase'

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
      list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
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

    // Xóa bộ nhớ AI + markdown — không catch silently, để lỗi lan ra ngoài
    await Promise.allSettled([
      deleteDoc(doc(db, 'documentMemory', id)),
      deleteDoc(doc(db, 'documentMarkdown', id)),
    ])

    // Xóa nhật ký hoạt động
    try {
      const logsSnap = await getDocs(query(collection(db, 'activityLogs'), where('docId', '==', id)))
      await Promise.all(logsSnap.docs.map(l => deleteDoc(doc(db, 'activityLogs', l.id))))
    } catch {}
  }

  return { docs, allDocs, loading, addDocument, updateDocument, deleteDocument }
}
