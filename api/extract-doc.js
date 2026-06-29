// api/extract-doc.js
// Đọc file Word .doc (định dạng cũ, OLE/Compound File Binary) — mammoth.js
// (đang dùng ở client cho .docx) KHÔNG đọc được .doc vì khác hẳn cấu trúc
// (.docx là zip/XML, .doc là binary OLE). Phải xử lý server-side bằng
// word-extractor — thư viện pure JS, KHÔNG cần binary/LibreOffice ngoài, nên
// chạy được trên Vercel serverless (Hobby) không cần cấu hình gì thêm.
//
// Cần chạy 1 lần: npm install word-extractor (rồi commit package.json/lock).
import WordExtractor from 'word-extractor'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { base64 } = req.body || {}
  if (!base64) return res.status(400).json({ error: 'Thiếu base64' })

  try {
    const buffer = Buffer.from(base64, 'base64')
    const extractor = new WordExtractor()
    const doc = await extractor.extract(buffer)
    const text = (doc.getBody() || '').trim()
    if (!text) {
      return res.status(200).json({ text: '', warning: 'File đọc được nhưng không có nội dung chữ.' })
    }
    return res.status(200).json({ text })
  } catch (e) {
    console.error('[extract-doc] lỗi:', e.message)
    return res.status(500).json({ error: 'Không đọc được file .doc — file có thể bị hỏng hoặc không đúng định dạng Word: ' + e.message })
  }
}
