// src/contexts/UploadContext.jsx
// Đặt file này vào: src/contexts/UploadContext.jsx
// Sau đó wrap App.jsx: <UploadProvider><App/></UploadProvider>

import React, { createContext, useContext, useState, useCallback } from 'react'

const Ctx = createContext(null)

export function UploadProvider({ children }) {
  // draft: trạng thái đang xử lý toàn cục
  const [draft, setDraft] = useState(null)
  // draft = { file, form, status, loading, projectId, docId }

  const startDraft = useCallback((projectId, file, docId = null) => {
    setDraft({ projectId, docId, file, form: {}, status: '', loading: true })
  }, [])

  const updateDraft = useCallback((patch) => {
    setDraft(d => d ? { ...d, ...patch } : d)
  }, [])

  const clearDraft = useCallback(() => setDraft(null), [])

  return (
    <Ctx.Provider value={{ draft, startDraft, updateDraft, clearDraft }}>
      {children}
    </Ctx.Provider>
  )
}

export const useUploadCtx = () => useContext(Ctx)
