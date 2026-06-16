// api/cleanup-files.js — Dùng Firestore REST API (không cần firebase-admin)
export default async function handler(req, res) {
  if (req.query.secret !== 'vatm2026') {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const token     = process.env.VITE_GH_TOKEN
  const projectId = 'vatm-pmu'
  const owner     = 'hoangductudhbk-hub'
  const repo      = 'VATM-PMU'
  const ghHeaders = {
    Authorization: `token ${token}`,
    'User-Agent': 'VATM-PMU',
    'Content-Type': 'application/json',
  }

  try {
    // Bước 1: Lấy danh sách file trong docs/ trên GitHub
    const ghRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/contents/docs`,
      { headers: ghHeaders }
    )
    if (!ghRes.ok) throw new Error('Không lấy được file GitHub: ' + ghRes.status)
    const ghFiles = await ghRes.json()
    const allGhPaths = ghFiles.map(f => f.path)

    // Bước 2: Lấy tất cả documents từ Firestore REST API
    const fsUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/documents?pageSize=300`
    const fsRes = await fetch(fsUrl)
    if (!fsRes.ok) throw new Error('Không lấy được Firestore: ' + fsRes.status)
    const fsData = await fsRes.json()

    // Trích fileUrl từ Firestore documents
    const usedPaths = new Set()
    for (const doc of (fsData.documents || [])) {
      const fields = doc.fields || {}
      const url = fields.fileUrl?.stringValue || fields.downloadUrl?.stringValue || ''
      if (url) {
        const match = url.match(/\/main\/(.+)$/)
        if (match) usedPaths.add(match[1])
      }
    }

    // Bước 3: Tìm file mồ côi
    const orphans = allGhPaths.filter(p => !usedPaths.has(p))

    if (orphans.length === 0) {
      return res.status(200).json({
        message: '✅ GitHub đã sạch! Không có file thừa.',
        totalGitHub: allGhPaths.length,
        totalUsed: usedPaths.size,
        deleted: 0,
      })
    }

    // Bước 4: Xóa file mồ côi
    const results = []
    for (const path of orphans) {
      try {
        // Lấy SHA
        const infoRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          { headers: ghHeaders }
        )
        if (!infoRes.ok) { results.push({ path, status: 'skip - not found' }); continue }
        const { sha } = await infoRes.json()

        // Xóa
        const delRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
          {
            method: 'DELETE',
            headers: ghHeaders,
            body: JSON.stringify({ message: `Cleanup: ${path}`, sha, branch: 'main' }),
          }
        )
        results.push({ path, status: delRes.ok ? '✅ Đã xóa' : '❌ Lỗi xóa' })
        await new Promise(r => setTimeout(r, 500))
      } catch(e) {
        results.push({ path, status: '❌ ' + e.message })
      }
    }

    const deleted = results.filter(r => r.status.includes('✅')).length
    return res.status(200).json({
      message: `✅ Dọn xong! Đã xóa ${deleted}/${orphans.length} file thừa`,
      totalGitHub: allGhPaths.length,
      totalUsed: usedPaths.size,
      deleted,
      results,
    })

  } catch(e) {
    return res.status(500).json({ error: e.message })
  }
}