// api/delete-file.js — Xóa file khỏi GitHub khi xóa văn bản
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'DELETE, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

  const { path } = req.query
  if (!path) return res.status(400).json({ error: 'Thiếu path' })

  const token = process.env.VITE_GH_TOKEN
  const owner = 'hoangductudhbk-hub'
  const repo  = 'VATM-PMU'
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`
  const headers = {
    Authorization: `token ${token}`,
    'User-Agent': 'VATM-PMU',
    'Content-Type': 'application/json',
  }

  try {
    // Bước 1: Lấy SHA của file (bắt buộc để xóa)
    const getRes = await fetch(apiUrl, { headers })
    if (!getRes.ok) return res.status(404).json({ error: 'File không tồn tại trên GitHub' })
    const { sha } = await getRes.json()

    // Bước 2: Xóa file
    const delRes = await fetch(apiUrl, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ message: `Delete ${path}`, sha, branch: 'main' }),
    })

    if (!delRes.ok) {
      const err = await delRes.json()
      return res.status(500).json({ error: err.message || 'Xóa thất bại' })
    }

    return res.status(200).json({ ok: true, deleted: path })
  } catch(e) {
    return res.status(500).json({ error: e.message })
  }
}
