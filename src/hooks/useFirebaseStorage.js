// src/hooks/useCloudinaryStorage.js
// Sửa: dùng resource_type='raw' cho PDF/Word → giới hạn 100MB thay vì 10MB

import { useState } from 'react'

const KEY_NAME   = 'vatm_cloud_name'
const KEY_PRESET = 'vatm_cloud_preset'

export function useCloudinaryStorage() {
  const [uploading,      setUploading] = useState(false)
  const [uploadProgress, setProgress]  = useState(0)

  const getCloudName = () => localStorage.getItem(KEY_NAME)   || ''
  const getPreset    = () => localStorage.getItem(KEY_PRESET) || 'vatm_pmu'
  const saveCloudName = (v) => localStorage.setItem(KEY_NAME, v)
  const savePreset    = (v) => localStorage.setItem(KEY_PRESET, v)

  const uploadFile = (file) => new Promise((resolve, reject) => {
    let cloudName = getCloudName()
    if (!cloudName) {
      cloudName = prompt('Nhập Cloudinary Cloud Name:')
      if (!cloudName?.trim()) { reject(new Error('Chưa có Cloud Name')); return }
      saveCloudName(cloudName.trim())
    }

    setUploading(true)
    setProgress(0)

    // ── KEY FIX: PDF/Word/ZIP → resource_type='raw' (giới hạn 100MB) ──
    // ảnh → 'image' (10MB), còn lại → 'raw' (100MB)
    const isImage      = /\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(file.name)
    const resourceType = isImage ? 'image' : 'raw'

    const fd = new FormData()
    fd.append('file',           file)
    fd.append('upload_preset',  getPreset())

    const url = `https://api.cloudinary.com/v1_1/${cloudName.trim()}/${resourceType}/upload`
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        setProgress(Math.round(e.loaded / e.total * 100))
    }

    xhr.onload = () => {
      setUploading(false)
      if (xhr.status === 200) {
        const d = JSON.parse(xhr.responseText)
        setProgress(100)
        resolve({
          fileUrl:     d.secure_url,
          downloadUrl: d.secure_url,
          fileName:    file.name,
          fileSize:    file.size,
          filePath:    d.public_id,
          resourceType,
        })
      } else {
        let msg = 'Upload lỗi'
        try { msg = JSON.parse(xhr.responseText)?.error?.message || msg } catch {}
        reject(new Error(msg))
      }
    }

    xhr.onerror = () => { setUploading(false); reject(new Error('Lỗi mạng')) }
    xhr.send(fd)
  })

  return { uploadFile, uploading, uploadProgress, getCloudName, saveCloudName }
}
