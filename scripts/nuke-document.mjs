// scripts/nuke-document.mjs
// Xoá sạch mọi vết của 1 tài liệu trong Firestore theo tên file — dùng khi
// nút "Xoá" trên app không dọn hết (hoặc chưa rõ nó có dọn hay không).
// Chạy: node scripts/nuke-document.mjs "3482-QD-QLB"
// (chỉ cần 1 phần tên file, không cần gõ đủ — script tự tìm theo "chứa")
//
// Cần file .env có đủ: FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// (lấy bằng: vercel env pull .env)

import { GoogleAuth } from 'google-auth-library'
import fs from 'fs'
import { fileURLToPath } from 'url'

// Đọc .env thủ công (không cần thêm package dotenv)
// SỬA: new URL(...).pathname trên Windows ra dạng "/D:/..." (sai đường dẫn) —
// phải dùng fileURLToPath để ra đúng "D:\..." mới đọc được file thật.
const envPath = fileURLToPath(new URL('../.env', import.meta.url))
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, '')
  }
}

const searchTerm = process.argv[2]
if (!searchTerm) {
  console.error('Dùng: node scripts/nuke-document.mjs "tên file hoặc 1 phần tên"')
  process.exit(1)
}

const projectId = 'vatm-pmu'
const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`

const auth = new GoogleAuth({
  credentials: {
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },
  scopes: ['https://www.googleapis.com/auth/datastore'],
})

const getHeaders = async () => {
  const client = await auth.getClient()
  const token = (await client.getAccessToken()).token
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

const fieldVal = (doc, name) => {
  const f = doc.fields?.[name]
  if (!f) return ''
  return f.stringValue || ''
}

// Liệt kê toàn bộ document trong 1 collection (phân trang nếu >300)
const listCollection = async (name, headers) => {
  const out = []
  let pageToken = null
  do {
    const url = `${base}/${name}?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`
    const res = await fetch(url, { headers })
    const data = await res.json()
    out.push(...(data.documents || []))
    pageToken = data.nextPageToken || null
  } while (pageToken)
  return out
}

const deleteDoc = async (path, headers) => {
  const res = await fetch(`https://firestore.googleapis.com/v1/${path}`, {
    method: 'DELETE', headers,
  })
  return res.ok
}

async function run() {
  const headers = await getHeaders()
  console.log(`Đang tìm mọi bản ghi có tên chứa: "${searchTerm}"\n`)

  // 1. Tìm trong "documents" để lấy đúng docId
  const documents = await listCollection('documents', headers)
  const matched = documents.filter(d =>
    fieldVal(d, 'fileName').includes(searchTerm) || d.name.includes(searchTerm)
  )

  if (!matched.length) {
    console.log('Không tìm thấy trong collection "documents". Vẫn quét tiếp documentMarkdown/documentMemory/processingJobs theo tên file (phòng trường hợp docId lệch).')
  }

  const docIds = new Set()
  for (const d of matched) {
    const id = d.name.split('/').pop()
    docIds.add(id)
    console.log(`Tìm thấy trong "documents": ${fieldVal(d, 'fileName')} (docId=${id})`)
    const ok = await deleteDoc(d.name, headers)
    console.log(`  -> xoá documents/${id}: ${ok ? '✅' : '❌'}`)
  }

  // 2. documentMarkdown — tìm theo field fileName (ID là ngẫu nhiên, không phải docId)
  const markdowns = await listCollection('documentMarkdown', headers)
  for (const d of markdowns) {
    if (fieldVal(d, 'fileName').includes(searchTerm)) {
      const id = d.name.split('/').pop()
      console.log(`Tìm thấy trong "documentMarkdown": ${fieldVal(d, 'fileName')} (id=${id})`)
      const ok = await deleteDoc(d.name, headers)
      console.log(`  -> xoá documentMarkdown/${id}: ${ok ? '✅' : '❌'}`)
    }
  }

  // 3. documentMemory + processingJobs — ID = đúng docId tìm được ở bước 1
  for (const id of docIds) {
    for (const col of ['documentMemory', 'processingJobs']) {
      const path = `projects/${projectId}/databases/(default)/documents/${col}/${id}`
      const ok = await deleteDoc(path, headers)
      console.log(`-> xoá ${col}/${id}: ${ok ? '✅' : '(không có/đã xoá)'}`)
    }
  }

  console.log('\nXong. Giờ upload lại file PDF như tài liệu mới trong app.')
}

run().catch(e => { console.error('LỖI:', e.message); process.exit(1) })
