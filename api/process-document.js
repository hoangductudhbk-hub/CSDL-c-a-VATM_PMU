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

  // Kiểm tra các key đã cấu hình chưa (server-side)
  // SỬA 22/6/2026: không block nếu thiếu Gemini — process-batch.js có Groq +
  // Tesseract.js làm fallback, pipeline vẫn chạy được mà không cần Gemini.
  const hasGemini = !!(
    process.env.VITE_GEMINI_API_KEY ||
    process.env.GEMINI_API_KEY
  )
  const hasGroq = !!(process.env.VITE_GROQ_API_KEY || process.env.VITE_GROQ_API_KEY_2)
  const hasGhToken = !!(process.env.VITE_GH_TOKEN || process.env.GH_TOKEN)

  if (!hasGroq && !hasGemini) {
    return res.status(500).json({
      error: 'Server chưa cấu hình key AI nào (cần ít nhất VITE_GROQ_API_KEY hoặc VITE_GEMINI_API_KEY).',
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
