// api/read-file.js — Stream trực tiếp, không base64, không giới hạn kích thước
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'Thiếu url' })

  const decoded = decodeURIComponent(url)
  if (!decoded.startsWith('https://raw.githubusercontent.com/')) {
    return res.status(403).json({ error: 'Chỉ hỗ trợ GitHub raw URL' })
  }

  try {
    const ghToken = process.env.VITE_GH_TOKEN
    const response = await fetch(decoded, {
      headers: {
        'User-Agent': 'VATM-PMU/1.0',
        ...(ghToken ? { Authorization: `token ${ghToken}` } : {}),
      }
    })

    if (!response.ok) {
      return res.status(response.status).json({ error: `GitHub lỗi ${response.status}` })
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const contentLength = response.headers.get('content-length')

    // Set headers — stream thẳng, không buffer toàn bộ
    res.setHeader('Content-Type', contentType)
    if (contentLength) res.setHeader('Content-Length', contentLength)

    // Pipe stream trực tiếp từ GitHub → client (không giới hạn kích thước)
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()

  } catch (e) {
    res.status(500).json({ error: e.message })
  }
}