import { useState, useEffect } from 'react'
import {
  collection, query, where,
  onSnapshot, addDoc, updateDoc, deleteDoc,
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
    // Xóa văn bản
    await deleteDoc(doc(db, 'documents', id))
    // Xóa luôn bộ nhớ AI để không làm đầy Firestore
    try { await deleteDoc(doc(db, 'documentMemory', id)) } catch {}
  }

  return { docs, allDocs, loading, addDocument, updateDocument, deleteDocument }
}