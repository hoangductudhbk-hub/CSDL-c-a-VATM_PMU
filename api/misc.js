// api/misc.js
// Gộp các serverless function nhỏ, ít dùng vào 1 file — Vercel Hobby giới hạn
// TỐI ĐA 12 Serverless Functions/deployment, tính theo SỐ FILE trong api/ (không
// tính theo số chức năng bên trong 1 file). Thêm action mới vào đây nếu cần,
// đừng tạo file api/ mới nữa kẻo lại vượt giới hạn.
//
// action: 'extract-doc'  → đọc file Word .doc cũ (OLE binary) bằng word-extractor
// action: 'lookup-user'  → tra cứu users theo username/email, quyền admin
//   (dùng cho login bằng email / đăng ký kiểm tra trùng / quên mật khẩu —
//   những luồng cần đọc Firestore TRƯỚC khi có auth)
import WordExtractor from 'word-extractor'
import { GoogleAuth } from 'google-auth-library'

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://pmuvatm.vercel.app')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const { action } = req.body || {}
  if (action === 'extract-doc') return handleExtractDoc(req, res)
  if (action === 'lookup-user') return handleLookupUser(req, res)
  return res.status(400).json({ error: 'Thiếu hoặc sai "action" (extract-doc | lookup-user)' })
}

async function handleExtractDoc(req, res) {
  const { base64 } = req.body || {}
  if (!base64) return res.status(400).json({ error: 'Thiếu base64' })
  try {
    const buffer = Buffer.from(base64, 'base64')
    const extractor = new WordExtractor()
    const doc = await extractor.extract(buffer)
    const text = (doc.getBody() || '').trim()
    return res.status(200).json({ text })
  } catch (e) {
    console.error('[misc/extract-doc] lỗi:', e.message)
    return res.status(500).json({ error: 'Không đọc được file .doc: ' + e.message })
  }
}

async function handleLookupUser(req, res) {
  const { field, value, mode } = req.body || {}
  if (!field || !value || !['username', 'email'].includes(field)) {
    return res.status(400).json({ error: 'Thiếu field/value hợp lệ (username|email)' })
  }
  try {
    const auth = new GoogleAuth({
      credentials: {
        client_email: process.env.FIREBASE_CLIENT_EMAIL,
        private_key:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      },
      scopes: ['https://www.googleapis.com/auth/datastore'],
    })
    const client = await auth.getClient()
    const token  = (await client.getAccessToken()).token
    const projectId = process.env.FIREBASE_PROJECT_ID
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`
    const body = {
      structuredQuery: {
        from:  [{ collectionId: 'users' }],
        where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: String(value) } } },
        limit: 1,
      },
    }
    const r = await fetch(url, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.error?.message || `Firestore query lỗi (${r.status})`)

    const entry = (Array.isArray(data) ? data : [data]).find(d => d.document)
    if (!entry) return res.status(200).json({ found: false })
    if (mode === 'exists') return res.status(200).json({ found: true })

    const f = entry.document.fields || {}
    const get = (k) => f[k]?.stringValue ?? ''
    return res.status(200).json({
      found: true, uid: get('uid'), username: get('username'),
      name: get('name'), unit: get('unit'), email: get('email'),
    })
  } catch (e) {
    console.error('[misc/lookup-user] lỗi:', e.message)
    return res.status(500).json({ error: e.message })
  }
}
