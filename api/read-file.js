// api/read-file.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()

  const { url } = req.query
  if (!url) return res.status(400).json({ error: 'Thiếu url' })

  // Decode URL từ query param
  const decoded = decodeURIComponent(url)

  if (!decoded.startsWith('https://raw.githubusercontent.com/')) {
    return res.status(403).json({ error: 'Chỉ hỗ trợ GitHub raw URL' })
  }

  // Encode lại từng phần của path để GitHub chấp nhận Unicode
  const urlObj = new URL(decoded)
  const pathParts = urlObj.pathname.split('/')
  const encodedPath = pathParts.map(part => 
    encodeURIComponent(decodeURIComponent(part))
  ).join('/')
  const fetchUrl = `${urlObj.origin}${encodedPath}`

  try {
    const token = process.env.VITE_GH_TOKEN
    const response = await fetch(fetchUrl, {
      headers: {
        'User-Agent': 'VATM-PMU/1.0',
        ...(token ? { Authorization: `token ${token}` } : {}),
      }
    })

    if (!response.ok) {
      return res.status(response.status).json({ 
        error: `GitHub lỗi ${response.status}`,
        fetchUrl
      })
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream'
    const contentLength = response.headers.get('content-length')

    res.setHeader('Content-Type', contentType)
    if (contentLength) res.setHeader('Content-Length', contentLength)

    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      res.write(Buffer.from(value))
    }
    res.end()

  } catch (e) {
    return res.status(500).json({ error: e.message, fetchUrl })
  }
}