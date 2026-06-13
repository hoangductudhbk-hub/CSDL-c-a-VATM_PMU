import { useState, useEffect } from 'react'
import {
  collection, query, where,
  onSnapshot, addDoc, updateDoc, deleteDoc,
  doc, serverTimestamp,
} from 'firebase/firestore'
import { db } from '../firebase'

export function useDocuments(projectId, userId) {
  const [docs, setDocs]       = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!projectId || !userId) return
    // ✅ Lấy văn bản theo projectId (không lọc userId — mọi người đều thấy)
    const q = query(
      collection(db, 'documents'),
      where('projectId', '==', projectId)
    )
    const unsub = onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0))
      setDocs(list)
      setLoading(false)
    })
    return unsub
  }, [projectId, userId])

  const addDocument = (data, silent) =>
    addDoc(collection(db, 'documents'), {
      ...data,
      projectId,
      uploadedBy: userId,   // lưu ai upload
      createdAt:  serverTimestamp(),
      updatedAt:  serverTimestamp(),
    })

  const updateDocument = (id, data) =>
    updateDoc(doc(db, 'documents', id), {
      ...data,
      updatedAt: serverTimestamp(),
    })

  const deleteDocument = (id) => deleteDoc(doc(db, 'documents', id))

  return { docs, loading, addDocument, updateDocument, deleteDocument }
}
