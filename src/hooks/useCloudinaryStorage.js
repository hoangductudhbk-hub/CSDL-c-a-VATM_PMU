// src/hooks/useCloudinaryStorage.js
// Upload/xóa file trên GitHub
// FIX: env var ưu tiên hơn localStorage (tránh token cũ từ localStorage ghi đè token mới trên Vercel)

import { useState } from 'react'

const K = { owner: 'gh_owner', repo: 'gh_repo', token: 'gh_token' }

// ── Priority: env var (build-time) TRƯỚC, localStorage SAU ──────
// Lý do: VITE_ vars được nhúng vào bundle khi deploy — đây là nguồn chính xác nhất.
// localStorage chỉ dùng khi không có env var (dev local hoặc self-hosted).
const getOwner = () => import.meta.env.VITE_GH_OWNER || localStorage.getItem(K.owner) || ''
const getRepo  = () => import.meta.env.VITE_GH_REPO  || localStorage.getItem(K.repo)  || ''
const getToken = () => import.meta.env.VITE_GH_TOKEN  || localStorage.getItem(K.token) || ''
const save = (k, v) => localStorage.setItem(k, v)

const fileToBase64 = (file, onProgress) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => {
    const bytes = new Uint8Array(reader.result)
    let str = ''
    const chunk = 8192
    for (let i = 0; i < bytes.length; i += chunk) {
      str += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))
      if (onProgress) onProgress(Math.round(i / bytes.length * 30))
    }
    resolve(btoa(str))
  }
  reader.onerror = reject
  reader.readAsArrayBuffer(file)
})

// ensureConfig: chỉ prompt khi CẢ env var lẫn localStorage đều trống
const ensureConfig = () => {
  let owner = getOwner(), repo = getRepo(), token = getToken()
  if (!owner) {
    owner = prompt('GitHub username (hoặc set VITE_GH_OWNER trên Vercel):')?.trim()
    if (!owner) throw new Error('Chưa có GitHub username')
    save(K.owner, owner)
  }
  if (!repo) {
    repo = prompt('Tên repo GitHub (hoặc set VITE_GH_REPO trên Vercel):')?.trim()
    if (!repo) throw new Error('Chưa có tên repo')
    save(K.repo, repo)
  }
  if (!token) {
    token = prompt('GitHub Token ghp_... (hoặc set VITE_GH_TOKEN trên Vercel):')?.trim()
    if (!token) throw new Error('Chưa có GitHub token')
    save(K.token, token)
  }
  return { owner, repo, token }
}

// ── Gọi GitHub API PUT với token cụ thể ─────────────────────────
const githubPut = (owner, repo, token, path, body, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `https://api.github.com/repos/${owner}/${repo}/contents/${path}`)
    xhr.setRequestHeader('Authorization', `token ${token}`)
    xhr.setRequestHeader('Content-Type',  'application/json')
    xhr.setRequestHeader('Accept',        'application/vnd.github.v3+json')
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(30 + Math.round(e.loaded / e.total * 65))
      }
    }
    xhr.onload  = () => resolve(xhr)
    xhr.onerror = () => reject(new Error('Lỗi mạng khi gọi GitHub'))
    xhr.send(body)
  })

export function useCloudinaryStorage() {
  const [uploading,      setUploading] = useState(false)
  const [uploadProgress, setProgress]  = useState(0)

  // Compat với code cũ dùng getCloudName()
  const getCloudName  = () => getOwner()
  const saveCloudName = () => {}

  // ── Upload file lên GitHub ──────────────────────────────────────
  const uploadFile = (file, onProgress) => new Promise(async (resolve, reject) => {
    try {
      const { owner, repo, token } = ensureConfig()
      setUploading(true)
      setProgress(0)
      const notify = (pct) => { setProgress(pct); if (onProgress) onProgress(pct) }

      notify(5)
      const base64 = await fileToBase64(file, (p) => notify(p))
      notify(30)

      const cleanName = file.name
        .replace(/[/\\:*?"<>|#%]/g, '-')
        .replace(/\s+/g, '_')
        .replace(/-+/g, '-')
      const safeName = `${Date.now()}_${cleanName}`
      const path     = `docs/${safeName}`
      const body     = JSON.stringify({ message: `Upload: ${file.name}`, content: base64 })

      const xhr = await githubPut(owner, repo, token, path, body, notify)
      setUploading(false)

      if (xhr.status === 201 || xhr.status === 200) {
        notify(100)
        resolve({
          fileUrl:     `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
          downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
          fileName:    file.name,
          fileSize:    file.size,
          publicId:    path,
        })
        return
      }

      // Xử lý lỗi
      let errMsg = `Lỗi GitHub ${xhr.status}`
      try { errMsg = JSON.parse(xhr.responseText)?.message || errMsg } catch {}

      if (xhr.status === 401 || xhr.status === 403) {
        // Log rõ token nào đang dùng để debug
        const isEnvToken = Boolean(import.meta.env.VITE_GH_TOKEN)
        const tokenSrc   = isEnvToken ? 'Vercel env var' : 'localStorage'
        console.error(`[GitHub 401] Token từ ${tokenSrc}: ${token.slice(0, 10)}...`)
        console.error('[GitHub 401] Response:', xhr.responseText)
        errMsg = `Token GitHub không hợp lệ (nguồn: ${tokenSrc}). Kiểm tra VITE_GH_TOKEN trên Vercel và quyền "repo".`
      }

      reject(new Error(errMsg))
    } catch (e) {
      setUploading(false)
      reject(e)
    }
  })

  // ── Xóa file khỏi GitHub ────────────────────────────────────────
  const deleteFile = async (docObj = {}) => {
    const path = docObj.publicId || docObj.filePath || null
    if (!path && !docObj.fileName) return

    try {
      const { owner, repo, token } = ensureConfig()
      const headers = {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      }

      const tryDeletePath = async (p) => {
        const getRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`, { headers })
        if (!getRes.ok) return false
        const { sha } = await getRes.json()
        await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${p}`, {
          method: 'DELETE',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Delete: ${p}`, sha }),
        })
        return true
      }

      if (path) {
        const ok = await tryDeletePath(path)
        if (ok) return
      }

      // Fallback: tìm trong docs/ theo tên file gốc
      if (docObj.fileName) {
        const listRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/docs`, { headers })
        if (listRes.ok) {
          const files = await listRes.json()
          const safeName = docObj.fileName.replace(/[^\w._-]/g, '_')
          const match = files.find(f => f.name.endsWith('_' + safeName) || f.name.includes(safeName))
          if (match) await tryDeletePath(match.path)
        }
      }
    } catch (e) {
      console.warn('Xóa file GitHub thất bại:', e.message)
    }
  }

  return { uploadFile, deleteFile, uploading, uploadProgress, getCloudName, saveCloudName }
}
