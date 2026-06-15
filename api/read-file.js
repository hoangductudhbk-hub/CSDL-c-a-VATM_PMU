// api/read-file.js — Vercel serverless proxy đọc file từ GitHub
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET')

  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'No URL' })

  try {
    const ghToken = process.env.VITE_GH_TOKEN
    const response = await fetch(decodeURIComponent(url), {
      headers: ghToken ? {
        'Authorization': `token ${ghToken}`,
        'Accept': 'application/vnd.github.v3.raw',
      } : {}
    })

    if (!response.ok) return res.status(response.status).json({ error: `Fetch failed: ${response.status}` })

    const buffer = await response.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    const contentType = response.headers.get('content-type') || 'application/octet-stream'

    res.json({ base64, contentType, size: buffer.byteLength })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
}
