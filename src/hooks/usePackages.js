import { useState, useEffect } from 'react'
import { collection, onSnapshot, addDoc, deleteDoc, doc, serverTimestamp, query } from 'firebase/firestore'
import { db } from '../firebase'

export function usePackages() {
  const [packages, setPackages] = useState([])

  useEffect(() => {
    const q = query(collection(db, 'packages'))
    return onSnapshot(q, snap => {
      const list = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.createdAt?.seconds || 0) - (b.createdAt?.seconds || 0))
      setPackages(list)
    })
  }, [])

  const addPackage    = (name, projectId) => addDoc(collection(db, 'packages'), { name, projectId, createdAt: serverTimestamp() })
  const deletePackage = (id) => deleteDoc(doc(db, 'packages', id))

  return { packages, addPackage, deletePackage }
}
