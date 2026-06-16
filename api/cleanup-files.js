// api/cleanup-files.js
// Gọi 1 lần để xóa các file GitHub không còn được dùng trong Firestore
// Truy cập: https://pmuvatm.vercel.app/api/cleanup-files?secret=vatm2026

import { initializeApp, getApps, cert } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

// Khởi tạo Firebase Admin
const initAdmin = () => {
  if (getApps().length) return getFirestore()
  initializeApp({
    credential: cert({
      projectId:    process.env.FIREBASE_PROJECT_ID,
      clientEmail:  process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:   process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  })
  return getFirestore()
}

export default async function handler(req, res) {
  // Bảo mật — chỉ admin mới chạy được
  if (req.query.secret !== 'vatm2026') {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token = process.env.VITE_GH_TOKEN
  const owner = 'hoangductudhbk-hub'
  const repo  = 'VATM-PMU'
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'VATM-PMU',
    'Content-Type': 'application/json',
  }

  try {
    // Bước 1: Lấy tất cả file trong thư mục docs/ trên GitHub
    res.setHeader('Content-Type', 'application/json')
    const ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/docs`,
      { headers }
    )
    if (!ghRes.ok) throw new Error('Không lấy được danh sách file GitHub')
    const ghFiles = await ghRes.json()
    const allGhPaths = ghFiles.map(f => f.path) // e.g. "docs/1781xxx_file.pdf"

    // Bước 2: Lấy tất cả fileUrl đang dùng trong Firestore
    const db = initAdmin()
    const snap = await db.collection('documents').get()
    const usedUrls = new Set()
    snap.forEach(doc => {
      const url = doc.data().fileUrl || doc.data().downloadUrl || ''
      if (url) {
        // Trích path từ URL: .../main/docs/xxx → docs/xxx
        const match = url.match(/\/main\/(.+)$/)
        if (match) usedUrls.add(match[1])
      }
    })

    // Bước 3: Tìm file mồ côi (trên GitHub nhưng không có trong Firestore)
    const orphans = allGhPaths.filter(p => !usedUrls.has(p))

    if (orphans.length === 0) {
      return res.status(200).json({
        message: '✅ GitHub đã sạch! Không có file thừa.',
        total: allGhPaths.length,
        used: usedUrls.size,
        deleted: 0,
      })
    }

    // Bước 4: Xóa từng file mồ côi
    const results = []
    for (const path of orphans) {
      try {
        // Lấy SHA
        const infoRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers }
        )
        if (!infoRes.ok) { results.push({ path, status: 'not found' }); continue }
        const { sha } = await infoRes.json()

        // Xóa
        const delRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          {
            method: 'DELETE',
            headers,
            body: JSON.stringify({ message: `Cleanup: ${path}`, sha, branch: 'main' }),
          }
        )
        results.push({ path, status: delRes.ok ? '✅ Đã xóa' : '❌ Lỗi' })

        // Delay nhỏ tránh GitHub rate limit
        await new Promise(r => setTimeout(r, 500))
      } catch(e) {
        results.push({ path, status: '❌ ' + e.message })
      }
    }

    const deleted = results.filter(r => r.status.includes('✅')).length
    return res.status(200).json({
      message: `✅ Dọn xong! Đã xóa ${deleted}/${orphans.length} file thừa`,
      total: allGhPaths.length,
      used: usedUrls.size,
      deleted,
      results,
    })

  } catch(e) {
    return res.status(500).json({ error: e.message })
  }
}
