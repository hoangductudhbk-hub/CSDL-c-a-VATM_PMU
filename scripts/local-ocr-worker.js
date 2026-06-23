// scripts/local-ocr-worker.js
// Worker chạy trên máy tính: poll Firestore → download PDF → ABBYY OCR → upload markdown
//
// Khởi động: node scripts/local-ocr-worker.js
// Yêu cầu: node 18+, file scripts/worker.env (xem worker.env.example)

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { createInterface } from 'readline'

// ─── Load config ─────────────────────────────────────────────────────────────
const ENV_FILE = new URL('./worker.env', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')
const APP_ENV  = new URL('../.env.local', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')

function loadEnv(filePath) {
  if (!existsSync(filePath)) return {}
  return Object.fromEntries(
    readFileSync(filePath, 'utf8').split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => { const [k, ...v] = l.split('='); return [k.trim(), v.join('=').trim()] })
  )
}

const appEnv    = loadEnv(APP_ENV)
const workerEnv = loadEnv(ENV_FILE)

const FIREBASE_API_KEY  = appEnv.VITE_FIREBASE_API_KEY
const FIREBASE_PROJECT  = appEnv.VITE_FIREBASE_PROJECT_ID
const GH_TOKEN          = appEnv.VITE_GH_TOKEN || workerEnv.GH_TOKEN || ''
const WORKER_EMAIL      = workerEnv.EMAIL
const WORKER_PASSWORD   = workerEnv.PASSWORD
const POLL_INTERVAL_MS  = parseInt(workerEnv.POLL_INTERVAL || '15000')

// ─── Tìm ABBYY FineCmd.exe ────────────────────────────────────────────────────
const ABBYY_CANDIDATES = [
  'C:\\Program Files\\ABBYY FineReader PDF 16\\FineCmd.exe',
  'C:\\Program Files\\ABBYY FineReader 16\\FineCmd.exe',
  'C:\\Program Files\\ABBYY FineReader 15\\FineCmd.exe',
  'C:\\Program Files (x86)\\ABBYY FineReader 16\\FineCmd.exe',
  'C:\\Program Files (x86)\\ABBYY FineReader 15\\FineCmd.exe',
  workerEnv.ABBYY_PATH || '',
]

function findAbbyy() {
  for (const p of ABBYY_CANDIDATES) {
    if (p && existsSync(p)) return p
  }
  return null
}

const ABBYY_PATH = findAbbyy()
const TEMP_DIR   = join(tmpdir(), 'vatm-ocr')
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })

// ─── Firebase REST helpers ────────────────────────────────────────────────────
let idToken = null
let tokenExpires = 0

async function signIn() {
  const resp = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: WORKER_EMAIL, password: WORKER_PASSWORD, returnSecureToken: true }),
    }
  )
  if (!resp.ok) throw new Error('Đăng nhập Firebase thất bại: ' + resp.status)
  const data = await resp.json()
  idToken = data.idToken
  tokenExpires = Date.now() + parseInt(data.expiresIn) * 1000 - 60000
  console.log('[auth] Đăng nhập thành công')
}

async function getToken() {
  if (!idToken || Date.now() > tokenExpires) await signIn()
  return idToken
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`

async function fsGet(path) {
  const token = await getToken()
  const resp = await fetch(`${FS_BASE}/${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (resp.status === 404) return null
  if (!resp.ok) throw new Error(`Firestore GET ${path}: ${resp.status}`)
  return resp.json()
}

async function fsList(collection, filters = []) {
  const token = await getToken()
  // Dùng runQuery với StructuredQuery
  const query = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: filters.length === 1 ? {
        fieldFilter: {
          field: { fieldPath: filters[0].field },
          op: filters[0].op || 'EQUAL',
          value: { stringValue: filters[0].value },
        }
      } : undefined,
      limit: 20,
    }
  }
  const resp = await fetch(`${FS_BASE}:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(query),
  })
  if (!resp.ok) throw new Error(`Firestore query: ${resp.status}`)
  const rows = await resp.json()
  return rows.filter(r => r.document).map(r => ({
    id: r.document.name.split('/').pop(),
    ...Object.fromEntries(
      Object.entries(r.document.fields || {}).map(([k, v]) => [k, Object.values(v)[0]])
    )
  }))
}

async function fsSet(path, data) {
  const token = await getToken()
  // Chuyển object JS → Firestore fields
  const fields = {}
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string')  fields[k] = { stringValue: v }
    else if (typeof v === 'number') fields[k] = { integerValue: String(v) }
    else if (typeof v === 'boolean') fields[k] = { booleanValue: v }
  }
  const resp = await fetch(`${FS_BASE}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  })
  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Firestore PATCH ${path}: ${resp.status} ${err}`)
  }
}

// ─── Download file từ GitHub ───────────────────────────────────────────────────
async function downloadFile(url, destPath) {
  const headers = { 'User-Agent': 'VATM-OCR-Worker/1.0' }
  if (GH_TOKEN) headers['Authorization'] = `token ${GH_TOKEN}`
  const resp = await fetch(url, { headers })
  if (!resp.ok) throw new Error(`Download thất bại: ${resp.status} ${url}`)
  const buf = Buffer.from(await resp.arrayBuffer())
  writeFileSync(destPath, buf)
  return destPath
}

// ─── Chạy ABBYY FineCmd ───────────────────────────────────────────────────────
function runAbbyy(inputPath, outputDir) {
  if (!ABBYY_PATH) throw new Error('Không tìm thấy ABBYY FineCmd.exe. Cài đặt đường dẫn trong worker.env: ABBYY_PATH=...')

  const cmd = [
    `"${ABBYY_PATH}"`,
    `"${inputPath}"`,
    `/lang Vietnamese`,
    `/out "${outputDir}"`,
    `/format TXT`,
    `/quit`,
  ].join(' ')

  console.log('[abbyy] Chạy:', cmd)
  execSync(cmd, { timeout: 120000, stdio: 'pipe' })

  // ABBYY tạo file .txt cùng tên với input
  const inputName = basename(inputPath, '.pdf')
  const outputTxt = join(outputDir, inputName + '.txt')
  if (!existsSync(outputTxt)) throw new Error('ABBYY không tạo được file output: ' + outputTxt)
  return readFileSync(outputTxt, 'utf8')
}

// ─── Xử lý 1 document ────────────────────────────────────────────────────────
async function processDoc(docId, fileUrl, fileName) {
  console.log(`\n[job] Bắt đầu: ${fileName} (${docId})`)
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
  const inputPath = join(TEMP_DIR, docId + '_' + safeName)
  const outputDir = TEMP_DIR

  try {
    // Cập nhật trạng thái
    await fsSet(`processingJobs/${docId}`, { stage: 'extract', updatedAt: new Date().toISOString() })

    // Tải file
    console.log('[job] Tải file:', fileUrl.slice(-60))
    await downloadFile(fileUrl, inputPath)
    console.log('[job] File đã tải:', inputPath)

    // Chạy ABBYY
    console.log('[job] Chạy ABBYY OCR...')
    let text = ''
    try {
      text = runAbbyy(inputPath, outputDir)
      console.log(`[job] ABBYY xong: ${text.length} ký tự`)
    } catch (e) {
      console.warn('[job] ABBYY lỗi:', e.message, '→ thử extract text thủ công')
      text = `[OCR lỗi: ${e.message}. Vui lòng kiểm tra ABBYY.]`
    }

    if (!text.trim()) throw new Error('ABBYY không trích xuất được text')

    // Chuyển text → markdown đơn giản
    const markdown = text
      .split(/\r?\n/)
      .map(l => l.trimEnd())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')

    // Lưu vào Firestore
    await fsSet(`documentMarkdown/${docId}`, {
      fileName,
      markdown,
      charCount: String(markdown.length),
      engine: 'abbyy-local',
      updatedAt: new Date().toISOString(),
    })

    // Cập nhật documents/{docId}
    await fsSet(`documents/${docId}`, {
      hasMarkdown: 'true',
      extractedText: markdown.slice(0, 50000),
    })

    await fsSet(`processingJobs/${docId}`, {
      stage: 'done',
      updatedAt: new Date().toISOString(),
    })

    console.log(`[job] ✅ Hoàn tất: ${fileName}`)

  } finally {
    // Dọn dẹp file tạm
    try { if (existsSync(inputPath)) unlinkSync(inputPath) } catch {}
    const outputTxt = join(outputDir, basename(inputPath, '.pdf') + '.txt')
    try { if (existsSync(outputTxt)) unlinkSync(outputTxt) } catch {}
  }
}

// ─── Poll Firestore ───────────────────────────────────────────────────────────
const processing = new Set()

async function poll() {
  try {
    const jobs = await fsList('processingJobs', [{ field: 'stage', value: 'pending_local' }])
    for (const job of jobs) {
      if (processing.has(job.id)) continue
      if (!job.fileUrl) continue
      processing.add(job.id)
      processDoc(job.id, job.fileUrl, job.fileName || 'document.pdf')
        .catch(e => {
          console.error(`[job] ❌ Lỗi ${job.id}:`, e.message)
          fsSet(`processingJobs/${job.id}`, { stage: 'error', errorMessage: e.message })
            .catch(() => {})
        })
        .finally(() => processing.delete(job.id))
    }
  } catch (e) {
    console.warn('[poll] Lỗi:', e.message)
  }
}

// ─── Khởi động ────────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════╗')
  console.log('║   VATM Local OCR Worker (ABBYY)      ║')
  console.log('╚══════════════════════════════════════╝')

  if (!FIREBASE_API_KEY || !FIREBASE_PROJECT) {
    console.error('❌ Thiếu VITE_FIREBASE_API_KEY hoặc VITE_FIREBASE_PROJECT_ID trong .env.local')
    process.exit(1)
  }
  if (!WORKER_EMAIL || !WORKER_PASSWORD) {
    console.error('❌ Thiếu EMAIL và PASSWORD trong scripts/worker.env (xem worker.env.example)')
    process.exit(1)
  }
  if (!ABBYY_PATH) {
    console.warn('⚠️  Không tìm thấy ABBYY FineCmd.exe ở các vị trí mặc định')
    console.warn('    Thêm vào scripts/worker.env: ABBYY_PATH=C:\\...\\FineCmd.exe')
  } else {
    console.log('✅ ABBYY:', ABBYY_PATH)
  }

  console.log(`🔄 Poll Firestore mỗi ${POLL_INTERVAL_MS / 1000}s...`)
  await signIn()
  await poll()
  setInterval(poll, POLL_INTERVAL_MS)
}

main().catch(e => { console.error(e); process.exit(1) })
