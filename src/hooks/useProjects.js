import { useState, useEffect } from 'react'
import { collection, query, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp } from 'firebase/firestore'
import { db } from '../firebase'

export function useProjects(userId) {
  const [projects, setProjects] = useState([])
  const [loading, setLoading]   = useState(true)

  useEffect(() => {
    if (!userId) return
    const q = query(collection(db, 'projects'))
    const unsub = onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0))
      setProjects(list)
      setLoading(false)
    })
    return unsub
  }, [userId])

  const addProject    = (data) => addDoc(collection(db, 'projects'), { ...data, ownerId: userId, createdAt: serverTimestamp() })
  const deleteProject = (id)   => deleteDoc(doc(db, 'projects', id))

  return { projects, loading, addProject, deleteProject }
}
