// src/hooks/useDocMemory.js
// Lưu và đọc bộ nhớ phân tích sâu từng văn bản
import { useState, useEffect } from 'react'
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

export function useDocMemory(docId) {
  const [memory,   setMemory]   = useState(null)
  const [loading,  setLoading]  = useState(true)

  useEffect(() => {
    if (!docId) { setLoading(false); return }
    getDoc(doc(db, 'documentMemory', docId))
      .then(snap => setMemory(snap.exists() ? snap.data() : null))
      .finally(() => setLoading(false))
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
