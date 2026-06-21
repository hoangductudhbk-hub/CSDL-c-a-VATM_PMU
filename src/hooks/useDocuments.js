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
    // Lấy thông tin văn bản để biết fileUrl
    const docData = allDocs.find(d => d.id === id)

    // Xóa file trên GitHub nếu có
    if (docData?.fileUrl?.includes('raw.githubusercontent.com')) {
      try {
        // Trích path từ URL: .../main/docs/filename.pdf → docs/filename.pdf
        const match = docData.fileUrl.match(/\/main\/(.+)$/)
        if (match) {
          await fetch(`/api/delete-file?path=${encodeURIComponent(match[1])}`, {
            method: 'DELETE'
          })
        }
      } catch(e) {
        console.warn('Không xóa được file GitHub:', e.message)
      }
    }

    // Xóa văn bản trong Firestore
    await deleteDoc(doc(db, 'documents', id))

    // Xóa bộ nhớ AI trong Firestore
    try { await deleteDoc(doc(db, 'documentMemory', id)) } catch {}

    // Xóa markdown đầy đủ (lưu ở record riêng, tham chiếu qua markdownRef)
    if (docData?.markdownRef) {
      try { await deleteDoc(doc(db, 'documentMarkdown', docData.markdownRef)) } catch {}
    }

    // Xóa job xử lý tự động (nếu còn dở/đã xong)
    try { await deleteDoc(doc(db, 'processingJobs', id)) } catch {}

    // Xóa các chunk cũ (nếu có, từ pipeline cũ) — query theo docId vì lưu ID tự sinh
    try {
      const chunksSnap = await getDocs(query(collection(db, 'documentChunks'), where('docId', '==', id)))
      await Promise.all(chunksSnap.docs.map(c => deleteDoc(doc(db, 'documentChunks', c.id))))
    } catch (e) {
      console.warn('Không xóa được documentChunks:', e.message)
    }

    // Xóa nhật ký hoạt động liên quan tới văn bản này — không giữ lại dấu vết
    try {
      const logsSnap = await getDocs(query(collection(db, 'activityLogs'), where('docId', '==', id)))
      await Promise.all(logsSnap.docs.map(l => deleteDoc(doc(db, 'activityLogs', l.id))))
    } catch (e) {
      console.warn('Không xóa được activityLogs:', e.message)
    }
  }

  return { docs, allDocs, loading, addDocument, updateDocument, deleteDocument }
}
