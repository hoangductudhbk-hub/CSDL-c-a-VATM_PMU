// api/process-document.js
// Khởi tạo job xử lý tài liệu. Client gọi 1 lần ngay sau upload.
// Trả về thông tin job để client tạo record trong Firestore và bắt đầu gọi process-batch.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { docId, fileUrl, fileName, totalPages } = req.body || {}

  // Validate
  if (!docId) return res.status(400).json({ error: 'Thiếu docId' })
  if (!fileUrl) return res.status(400).json({ error: 'Thiếu fileUrl' })

  // Kiểm tra Gemini key đã cấu hình chưa (server-side)
  const hasGemini = !!(
    process.env.VITE_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY
  )
  const hasGhToken = !!(process.env.VITE_GH_TOKEN || process.env.GH_TOKEN)

  if (!hasGemini) {
    return res.status(500).json({
      error: 'Server chưa cấu hình GEMINI_API_KEY. Set trên Vercel Environment Variables.',
    })
  }

  const PAGE_BATCH = 10 // trang mỗi lô — nhỏ để tránh timeout
  const pages = totalPages || null
  const totalBatches = pages ? Math.ceil(pages / PAGE_BATCH) : null

  return res.status(200).json({
    ok: true,
    jobId: docId,
    stage: 'extract',
    pageBatch: PAGE_BATCH,
    totalPages: pages,
    totalBatches,
    serverHasGemini: hasGemini,
    serverHasGhToken: hasGhToken,
    // Client dùng thông tin này để tạo processingJobs/{docId} trong Firestore
    jobData: {
      docId,
      fileUrl,
      fileName: fileName || '',
      totalPages: pages,
      totalBatches,
      pageBatch: PAGE_BATCH,
      stage: 'extract',
      batchesDone: 0,
      createdAt: new Date().toISOString(),
    },
  })
}
