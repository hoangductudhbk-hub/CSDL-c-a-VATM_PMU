// src/hooks/useDocMemory.js
// Lưu và đọc bộ nhớ phân tích sâu từng văn bản
// Dùng onSnapshot để real-time — tự cập nhật khi pipeline lưu xong
import { useState, useEffect } from 'react'
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

export function useDocMemory(docId) {
  const [memory,   setMemory]   = useState(null)
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    if (!docId) { setLoading(false); return }
    setLoading(true)
    const unsub = onSnapshot(
      doc(db, 'documentMemory', docId),
      snap => {
        setMemory(snap.exists() ? snap.data() : null)
        setLoading(false)
      },
      () => setLoading(false)   // lỗi → dừng loading
    )
    return () => unsub()
  }, [docId])

  const saveMemory = async (data) => {
    await setDoc(doc(db, 'documentMemory', docId), {
      ...data,
      analyzedAt: serverTimestamp(),
    })
    setMemory(data)
  }

  return { memory, loading, saveMemory }
}
