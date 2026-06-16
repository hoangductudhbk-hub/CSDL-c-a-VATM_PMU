import { useState } from 'react'

const K = { owner:'gh_owner', repo:'gh_repo', token:'gh_token' }
const getOwner = () => localStorage.getItem(K.owner) || import.meta.env.VITE_GH_OWNER || ''
const getRepo  = () => localStorage.getItem(K.repo)  || import.meta.env.VITE_GH_REPO  || ''
const getToken = () => localStorage.getItem(K.token) || import.meta.env.VITE_GH_TOKEN  || ''
const save = (k,v) => localStorage.setItem(k, v)

const fileToBase64 = (file, onProgress) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result)
    let str = ''
    const chunk = 8192
    for (let i = 0; i < bytes.length; i += chunk) {
      str += String.fromCharCode(...bytes.subarray(i, Math.min(i+chunk, bytes.length)))
      if (onProgress) onProgress(Math.round(i / bytes.length * 30))
    }
    resolve(btoa(str))
  }
  reader.onerror = reject
  reader.readAsArrayBuffer(file)
})

const ensureConfig = () => {
  let owner = getOwner(), repo = getRepo(), token = getToken()
  if (!owner) { owner = prompt('GitHub username:')?.trim(); if (!owner) throw new Error('Chưa có username'); save(K.owner, owner) }
  if (!repo)  { repo  = prompt('Tên repo GitHub:')?.trim(); if (!repo)  throw new Error('Chưa có repo');    save(K.repo,  repo)  }
  if (!token) { token = prompt('GitHub Token (ghp_...):')?.trim(); if (!token) throw new Error('Chưa có token'); save(K.token, token) }
  return { owner, repo, token }
}

export function useCloudinaryStorage() {
  const [uploading,      setUploading] = useState(false)
  const [uploadProgress, setProgress]  = useState(0)

  const getCloudName  = () => getOwner()
  const saveCloudName = () => {}

  // ── Upload file lên GitHub ────────────────────────────────────
  const uploadFile = (file, onProgress) => new Promise(async (resolve, reject) => {
    try {
      const { owner, repo, token } = ensureConfig()
      setUploading(true); setProgress(0)
      const notify = (pct) => { setProgress(pct); if (onProgress) onProgress(pct) }

      notify(5)
      const base64   = await fileToBase64(file, notify)
      notify(30)

      // Giữ nguyên tên file gốc (kể cả tiếng Việt), chỉ bỏ ký tự nguy hiểm
      const safeName = `${Date.now()}_${file.name.replace(/[/\\:*?"<>|]/g,'_')}`
      const path     = `docs/${safeName}`
      const body     = JSON.stringify({ message:`Upload: ${file.name}`, content: base64 })

      const xhr = new XMLHttpRequest()
      xhr.open('PUT', `https://api.github.com/repos/${owner}/${repo}/contents/${path}`)
      xhr.setRequestHeader('Authorization',  `token ${token}`)
      xhr.setRequestHeader('Content-Type',   'application/json')
      xhr.setRequestHeader('Accept',         'application/vnd.github.v3+json')

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) notify(30 + Math.round(e.loaded / e.total * 65))
      }
      xhr.onload = () => {
        setUploading(false)
        if (xhr.status === 201 || xhr.status === 200) {
          notify(100)
          resolve({
            fileUrl:     `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
            downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
            fileName:    file.name,
            fileSize:    file.size,
            publicId:    path,   // lưu path để dùng khi xóa
          })
        } else {
          let msg = `Lỗi GitHub ${xhr.status}`
          try { msg = JSON.parse(xhr.responseText)?.message || msg } catch {}
          if (xhr.status === 401 || xhr.status === 403) { save(K.token,''); msg = 'Token không hợp lệ — thử lại' }
          reject(new Error(msg))
        }
      }
      xhr.onerror = () => { setUploading(false); reject(new Error('Lỗi mạng')) }
      xhr.send(body)
    } catch(e) { setUploading(false); reject(e) }
  })

  // ── Xóa file khỏi GitHub ────────────────────────────────────
  // doc: object văn bản (có thể có publicId, filePath, hoặc fileName)
  const deleteFile = async (doc = {}) => {
    // Xác định path trên GitHub
    const path = doc.publicId || doc.filePath || null
    if (!path && !doc.fileName) return  // không đủ thông tin

    try {
      const { owner, repo, token } = ensureConfig()
      const headers = { Authorization:`token ${token}`, Accept:'application/vnd.github.v3+json' }

      const tryDeletePath = async (p) => {
        const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`, { headers })
        if (!getRes.ok) return false
        const { sha } = await getRes.json()
        await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type':'application/json' },
          body: JSON.stringify({ message:`Delete: ${p}`, sha }),
        })
        return true
      }

      // Thử path trực tiếp
      if (path) {
        const ok = await tryDeletePath(path)
        if (ok) return
      }

      // Fallback: tìm trong thư mục docs/ bằng tên file gốc
      if (doc.fileName) {
        const listRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/docs`, { headers })
        if (listRes.ok) {
          const files = await listRes.json()
          // Tìm file có tên chứa tên gốc (bỏ qua timestamp prefix)
          const safeName = doc.fileName.replace(/[^\w._-]/g,'_')
          const match = files.find(f => f.name.endsWith('_' + safeName) || f.name.includes(safeName))
          if (match) await tryDeletePath(match.path)
        }
      }
    } catch(e) {
      console.warn('Xóa file GitHub thất bại:', e.message)
    }
  }

  return { uploadFile, deleteFile, uploading, uploadProgress, getCloudName, saveCloudName }
}