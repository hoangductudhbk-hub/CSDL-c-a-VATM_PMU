// src/components/FloatingUpload.jsx
// Đặt file này vào: src/components/FloatingUpload.jsx
// Render ở App.jsx hoặc layout chính: <FloatingUpload onOpen={...} />

import React from 'react'
import { useUploadCtx } from '../contexts/UploadContext'

// onOpen(projectId, docId): callback để mở lại DocModal với draft hiện có
export default function FloatingUpload({ onOpen }) {
  const { draft, clearDraft } = useUploadCtx()
  if (!draft) return null

  const name    = draft.file?.name ?? 'file'
  const short   = name.length > 28 ? name.slice(0, 25) + '...' : name
  const isDone  = !draft.loading && draft.status.startsWith('✅')
  const isError = !draft.loading && draft.status.startsWith('⚠️')

  return (
    <div style={S.wrap}>
      {/* Icon trạng thái */}
      <div style={{ ...S.icon, background: isDone ? '#1D9E75' : isError ? '#e74c3c' : '#1a1a1a' }}>
        {isDone ? '✅' : isError ? '⚠️' : <Spinner />}
      </div>

      {/* Nội dung */}
      <div style={S.info}>
        <div style={S.name}>{short}</div>
        <div style={S.sub}>
          {draft.loading
            ? draft.status.replace(/^⏳\s*/, '') || 'Đang xử lý...'
            : isDone
              ? 'Xong! Nhấn để xem kết quả'
              : draft.status.replace(/^⚠️\s*/, '') || 'Có lỗi xảy ra'}
        </div>
      </div>

      {/* Nút xem kết quả (chỉ hiện khi xong) */}
      {!draft.loading && (
        <button
          style={{ ...S.btn, background: isDone ? '#1D9E75' : '#e74c3c' }}
          onClick={() => onOpen(draft.projectId, draft.docId)}
        >
          {isDone ? 'Mở' : 'Xem'}
        </button>
      )}

      {/* Nút đóng */}
      <button style={S.close} onClick={clearDraft} title="Đóng">✕</button>
    </div>
  )
}

// Spinner nhỏ
function Spinner() {
  return (
    <div style={{
      width: 16, height: 16, border: '2.5px solid rgba(255,255,255,.3)',
      borderTopColor: '#fff', borderRadius: '50%',
      animation: 'spin .7s linear infinite',
    }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}

const S = {
  wrap: {
    position: 'fixed', bottom: 20, right: 20, zIndex: 9999,
    display: 'flex', alignItems: 'center', gap: 10,
    background: '#fff', borderRadius: 12,
    boxShadow: '0 4px 24px rgba(0,0,0,.18)',
    padding: '10px 14px', minWidth: 280, maxWidth: 360,
    border: '1px solid #eee',
  },
  icon: {
    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14,
  },
  info: { flex: 1, minWidth: 0 },
  name: { fontSize: 13, fontWeight: 600, color: '#1a1a1a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  sub:  { fontSize: 11, color: '#888', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
  btn:  { flexShrink: 0, padding: '5px 12px', border: 'none', borderRadius: 7, color: '#fff', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  close:{ flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', color: '#bbb', fontSize: 14, padding: '2px 4px' },
}
