// src/hooks/useAI.js
import { useState } from 'react'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_VISION_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct'

// ── Lấy keys ────────────────────────────────────────────────────
const getGroqKeys = () => {
  const fromEnv = [
    import.meta.env.VITE_GROQ_API_KEY,
    import.meta.env.VITE_GROQ_API_KEY_2,
    import.meta.env.VITE_GROQ_API_KEY_3,
  ].filter(Boolean)
  if (fromEnv.length) return fromEnv
  return (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
}

const getGemKeys = () => {
  const fromEnv = [
    import.meta.env.VITE_GEMINI_API_KEY,
    import.meta.env.VITE_GEMINI_API_KEY_2,
    import.meta.env.VITE_GEMINI_API_KEY_3,
  ].filter(Boolean)
  if (fromEnv.length) return fromEnv
  return (localStorage.getItem('gemini_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
}

const saveKey = (k) => {
  k = k.trim()
  if (k.startsWith('gsk_')) {
    const existing = (localStorage.getItem('groq_key') || '').split(',').map(x => x.trim()).filter(Boolean)
    if (!existing.includes(k)) existing.push(k)
    localStorage.setItem('groq_key', existing.join(','))
  } else {
    localStorage.setItem('gemini_key', k)
  }
}

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day', today)
    localStorage.setItem('ai_groq_idx', '0')
    localStorage.setItem('ai_gem_idx', '0')
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.
- "code": số ký hiệu dạng "404/NQ-HĐTV"
- "date": CHỈ dạng số D/M/YYYY hoặc M/YYYY
- "org": cơ quan BAN HÀNH
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

// ── Gọi Gemini qua /api/gemini-proxy (key nằm server, tránh CORS + AQ. key) ──
// SỬA 22/6/2026: gọi trực tiếp từ browser fail với AQ. keys (CORS + format
// key không đúng). Chuyển sang proxy server — xử lý đúng cả AIzaSy lẫn AQ.
// Nếu proxy không khả dụng (dev local, lỗi) → return null, Groq fallback.
const callGemini = async (prompt, maxTokens = 1000) => {
  try {
    const res = await fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
    })
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
}

// ── Gọi Groq ────────────────────────────────────────────────────
const callGroq = async (prompt, maxTokens = 1000, system = null) => {
  const keys = getGroqKeys()
  for (const key of keys) {
    try {
      const messages = system
        ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
        : [{ role: 'user', content: prompt }]
      const res = await fetch(GROQ_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: maxTokens, temperature: 0.1, messages }),
      })
      if (res.status === 429) continue
      if (!res.ok) continue
      const result = (await res.json()).choices?.[0]?.message?.content || ''
      if (result) return result
    } catch { continue }
  }
  return null
}

// ── Gọi AI: Gemini trước, Groq sau (tránh rate limit) ───────────
const callAI = async (prompt, maxTokens = 1000) => {
  // Gemini trước — ít rate limit hơn
  const gem = await callGemini(prompt, maxTokens)
  if (gem) return gem
  // Groq fallback
  const groq = await callGroq(prompt, maxTokens)
  if (groq) return groq
  const err = new Error('AI_RATE_LIMIT')
  err.waitSeconds = 30
  throw err
}

// ── Regex parser khi AI không khả dụng ─────────────────────────
const parseVietnameseDoc = (text, hint = '', fileName = '') => {
  const t = text.replace(/\s+/g, ' ')
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean)

  // Số ký hiệu: ưu tiên từ text, fallback từ tên file
  const codePatterns = [
    /[Ss]ố[:\s]*(\d+[\w\/\-\.]+(?:QĐ|NQ|CV|TT|BC|BB|TB|HĐ|QT|KH|CT|NĐ|TTLT)[A-Z\-\/\.]*)/,
    /(\d{1,4}[\/\-](?:QĐ|NQ|CV|TT|BC|BB|TB|HĐ|QT|KH|NĐ|TTLT)[A-Z\-\/\.]*)/i,
    /(\d{1,4}\/[\w\-\.]{3,25})/,
  ]
  let code = ''
  for (const rx of codePatterns) {
    const m = t.match(rx); if (m) { code = m[1].trim(); break }
  }
  // Fallback: thử đọc từ tên file (vd: "157-QĐ-QLDA.pdf" → "157/QĐ-QLDA")
  if (!code && fileName) {
    const fn = fileName.replace(/\.pdf$/i, '')
    const fm = fn.match(/^(\d{1,4})[_\-\/](.{2,20})$/)
    if (fm) code = `${fm[1]}/${fm[2].replace(/_/g, '-')}`
  }

  // Ngày: ngày DD tháng MM năm YYYY hoặc DD/MM/YYYY
  const dateM = t.match(/ngày\s+(\d{1,2})\s+tháng\s+(\d{1,2})\s+năm\s+(20\d\d)/i)
             || t.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d\d)/)
  const date = dateM ? `${dateM[1]}/${dateM[2]}/${dateM[3]}` : ''

  // Cơ quan ban hành: dòng ngay trước "Số:"
  const soIdx = lines.findIndex(l => /^[Ss]ố[:\s]/.test(l))
  const org = soIdx > 0
    ? lines.slice(Math.max(0, soIdx - 4), soIdx)
        .filter(l => l.length > 5 && l.length < 100 && !/^(cộng hòa|việt nam|độc lập)/i.test(l))
        .pop() || ''
    : ''

  // Loại văn bản: thử cả viết tắt (QĐ, NQ, CV...) và đầy đủ
  const docTypeMap = [
    ['Quyết định', /quyết\s*định|\bQĐ\b/i],
    ['Nghị quyết', /nghị\s*quyết|\bNQ\b/i],
    ['Công văn',   /công\s*văn|\bCV\b/i],
    ['Tờ trình',   /tờ\s*trình|\bTTr\b/i],
    ['Báo cáo',    /báo\s*cáo|\bBC\b/i],
    ['Hợp đồng',   /hợp\s*đồng|\bHĐ\b/i],
    ['Biên bản',   /biên\s*bản|\bBB\b/i],
    ['Thông báo',  /thông\s*báo|\bTB\b/i],
  ]
  // Kiểm tra cả trong code (từ filename) và trong text
  const searchIn = `${code} ${fileName} ${t}`
  const docType = docTypeMap.find(([, rx]) => rx.test(searchIn))?.[0] || 'Khác'

  // Chủ đề
  const subjM = t.match(/[Vv]\/[Vv][:\s]+(.{10,150}?)(?:\.|$)/)
             || t.match(/[Vv]ề\s+việc[:\s]+(.{10,150}?)(?:\.|$)/)
  const subject = subjM
    ? subjM[1].trim()
    : (lines.find(l => l.length > 20 && l.length < 150 && !/^(số|ngày|căn cứ|cộng hòa)/i.test(l)) || `Văn bản${hint}`)

  return JSON.stringify({ code, date, org, docType, subject,
    detail: lines.slice(0, 10).join(' ').slice(0, 300),
    note: 'Trích xuất bằng regex (AI không khả dụng)',
    status: 'done' })
}

// ── Prompt chunk trích xuất chi tiết ────────────────────────────
const buildChunkPrompt = (chunk, idx, total, fileName) => `
Bạn là chuyên gia trích xuất thông tin văn bản hành chính Việt Nam.
Đây là PHẦN ${idx}/${total} của văn bản: "${fileName}"
Trích xuất TẤT CẢ thông tin, GIỮ NGUYÊN số liệu. Trả về JSON:
{
  "summary": "mô tả ngắn phần này",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể"],
  "members": ["Họ tên - chức vụ/vai trò"],
  "technicalSpecs": ["tên thiết bị: thông số đầy đủ"],
  "financial": ["hạng mục: số tiền + đơn vị"],
  "legal": ["văn bản pháp lý - số hiệu"],
  "deadlines": ["công việc: thời hạn cụ thể"],
  "otherData": ["dữ kiện quan trọng khác"]
}
NỘI DUNG PHẦN ${idx}:
---
${chunk}
---`

const buildFinalPrompt = (allData, fileName, total) => `
Bạn vừa đọc xong TOÀN BỘ ${total} phần của văn bản: "${fileName}"
Tổng hợp thành bộ nhớ hoàn chỉnh. Trả về JSON:
{
  "summary": "Tóm tắt tổng quan 10-15 câu bao quát TOÀN BỘ văn bản",
  "keyPoints": ["điểm quan trọng với số liệu cụ thể - không giới hạn"],
  "members": ["Họ tên đầy đủ - chức vụ/vai trò/đơn vị - TẤT CẢ"],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ - TẤT CẢ"],
  "financial": ["Hạng mục: số tiền + đơn vị - TẤT CẢ"],
  "legal": ["Văn bản pháp lý - số hiệu - TẤT CẢ"],
  "deadlines": ["Công việc: thời hạn cụ thể - TẤT CẢ"],
  "requirements": "yêu cầu và điều kiện đầy đủ",
  "risks": "rủi ro và điểm cần lưu ý",
  "otherData": ["dữ kiện quan trọng khác"],
  "keywords": ["từ khóa đặc trưng - tối đa 20"]
}
DỮ LIỆU TỪ TỪNG PHẦN:
${allData}`

const buildSinglePrompt = (text, fileName) => `
Phân tích chi tiết văn bản hành chính Việt Nam. Trả về JSON:
{
  "summary": "Tóm tắt tổng quan 8-12 câu",
  "keyPoints": ["điểm quan trọng với số liệu"],
  "members": ["Họ tên - chức vụ/vai trò"],
  "technicalSpecs": ["Tên thiết bị: thông số đầy đủ"],
  "financial": ["Hạng mục: số tiền + đơn vị"],
  "legal": ["Văn bản pháp lý - số hiệu"],
  "deadlines": ["Công việc: thời hạn cụ thể"],
  "requirements": "yêu cầu và điều kiện",
  "risks": "rủi ro và điểm lưu ý",
  "otherData": ["dữ kiện khác"],
  "keywords": ["từ khóa - tối đa 20"]
}
Tên file: ${fileName}
NỘI DUNG:
---
${text}
---`

// ── Phân tích toàn bộ văn bản với chunking ──────────────────────
export const analyzeFullDocument = async (text, fileName = '', onStep = null) => {
  const step = (msg) => { if (onStep) onStep(msg) }
  const CHUNK_SIZE = 10000
  const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ')

  if (clean.length <= CHUNK_SIZE) {
    step('🤖 Đang phân tích văn bản...')
    return await callAI(buildSinglePrompt(clean, fileName), 3000)
  }

  const chunks = []
  for (let i = 0; i < clean.length; i += CHUNK_SIZE) {
    chunks.push(clean.slice(i, i + CHUNK_SIZE))
  }
  step(`📚 Văn bản ${Math.round(clean.length / 1000)}K ký tự · Chia ${chunks.length} phần`)

  const results = []
  for (let i = 0; i < chunks.length; i++) {
    step(`🔍 Đang đọc phần ${i + 1}/${chunks.length}...`)
    try {
      const result = await callAI(buildChunkPrompt(chunks[i], i + 1, chunks.length, fileName), 1500)
      results.push(`=== PHẦN ${i + 1}/${chunks.length} ===\n${result}`)
      if (i < chunks.length - 1) await new Promise(r => setTimeout(r, 1000))
    } catch (e) {
      results.push(`=== PHẦN ${i + 1}/${chunks.length} ===\n{"error": "Không đọc được"}`)
    }
  }

  step(`🧠 Đang tổng hợp ${chunks.length} phần...`)
  const final = await callAI(buildFinalPrompt(results.join('\n\n'), fileName, chunks.length), 3000)
  step(`✅ Hoàn thành! Đã đọc ${chunks.length} phần`)
  return final
}

// ── RAG: Tìm đoạn văn bản liên quan ────────────────────────────
export const findRelevantChunks = (text, question) => {
  if (!text || !question) return ''
  const stopWords = new Set(['là','gì','có','của','và','các','cho','trong','được','không','về','này','đó','với','những','theo','từ','khi','hay','hoặc','như','thì','mà','để','tôi','bạn','hãy','cần','phải','làm','nào','ai'])
  const keywords = question.toLowerCase().replace(/[?.,!;:]/g, ' ').split(/\s+/).filter(w => w.length > 1 && !stopWords.has(w))
  if (!keywords.length) return text.slice(0, 3000)

  const chunks = []
  for (let i = 0; i < text.length; i += 300) chunks.push({ text: text.slice(i, i + 400), pos: i })

  const scored = chunks.map(c => {
    const lower = c.text.toLowerCase()
    let score = keywords.reduce((s, kw) => s + (lower.includes(kw) ? 3 : 0), 0)
    return { ...c, score }
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).sort((a, b) => a.pos - b.pos)

  return scored.length ? scored.map(c => c.text).join('\n---\n').slice(0, 3000) : text.slice(0, 2000)
}

export function useAI() {
  const [loading, setLoading] = useState(false)

  // ── analyzeText (dùng khi thêm văn bản) ──
  const analyzeText = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? `\nTên file: ${fileName}` : ''
    const clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, ' ').slice(0, 6000)
    const prompt = `${SYSTEM}\n\nPhân tích văn bản:${hint}\n---\n${clean}\n---`
    try {
      const gem = await callGemini(prompt, 1000)
      if (gem) return gem
      const groq = await callGroq(prompt, 1000, SYSTEM)
      if (groq) return groq
      // AI không khả dụng → regex fallback (luôn trả về kết quả)
      return parseVietnameseDoc(text, hint, fileName)
    } finally { setLoading(false) }
  }

  // ── analyzeImages ──
  // Chain: Groq Vision → Gemini Vision → Tesseract.js OCR + AI text → basic JSON
  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? ` (${fileName})` : ''
    try {
      // 1. Groq Vision
      const keys = getGroqKeys()
      for (const key of keys) {
        try {
          const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: GROQ_VISION_MODEL, max_tokens: 1000, temperature: 0.05,
              messages: [{ role: 'user', content: [
                ...base64Images.slice(0, 3).map(b64 => ({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } })),
                { type: 'text', text: `${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` }
              ]}],
            }),
          })
          if (!res.ok) { if (res.status === 429) continue; throw new Error(`HTTP ${res.status}`) }
          const result = (await res.json()).choices?.[0]?.message?.content || ''
          if (result) return result
        } catch { continue }
      }

      // 2. Gemini Vision qua proxy
      try {
        const gemRes = await fetch('/api/gemini-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parts: [
              { text: `${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` },
              ...base64Images.slice(0, 3).map(b64 => ({ inline_data: { mime_type: 'image/jpeg', data: b64 } })),
            ],
            maxTokens: 1000,
          }),
        })
        if (gemRes.ok) {
          const d = await gemRes.json()
          if (d.text) return d.text
        }
      } catch {}

      // 3. Tesseract.js — chỉ OCR trang 1 (metadata luôn ở trang đầu)
      try {
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker(['vie', 'eng'])
        // Chỉ cần 2 trang đầu: số ký hiệu, ngày, cơ quan, nội dung chính
        let ocrText = ''
        for (const b64 of base64Images.slice(0, 2)) {
          const { data: { text } } = await worker.recognize(`data:image/jpeg;base64,${b64}`)
          ocrText += (text || '') + '\n'
        }
        await worker.terminate()

        if (ocrText.trim().length > 30) {
          // Thử AI phân tích text vừa OCR (nhanh hơn vision)
          const textPrompt = `${SYSTEM}\n\nPhân tích văn bản (OCR từ scan)${hint}:\n---\n${ocrText.slice(0, 4000)}\n---`
          const aiResult = await callGemini(textPrompt, 1000) || await callGroq(textPrompt, 1000)
          if (aiResult) return aiResult

          // AI fail → regex trực tiếp từ OCR text (không cần AI)
          return parseVietnameseDoc(ocrText, hint, fileName)
        }
      } catch (e) {
        console.warn('[analyzeImages] Tesseract lỗi:', e.message)
      }

      return ''
    } finally { setLoading(false) }
  }

  // ── analyzeDeepForMemory ──
  const analyzeDeepForMemory = async (text, fileName = '', onStep = null) => {
    setLoading(true)
    resetIdxIfNewDay()
    try {
      return await analyzeFullDocument(text, fileName, onStep)
    } finally { setLoading(false) }
  }

  // ── askDeep: hỏi đáp sâu với RAG ──
  const askDeep = async (question, memory, chatHistory = [], relevantText = '') => {
    setLoading(true)
    resetIdxIfNewDay()

    const ctx = `BỘ NHỚ VĂN BẢN:
📋 Tóm tắt: ${memory.summary || ''}
📌 Điểm quan trọng: ${(memory.keyPoints || []).join('; ')}
👥 Thành viên: ${(memory.members || []).join('; ')}
⚙️ Thông số kỹ thuật: ${(memory.technicalSpecs || []).join('; ')}
💰 Tài chính: ${(memory.financial || []).join('; ')}
⚖️ Pháp lý: ${(memory.legal || []).join('; ')}
📅 Tiến độ: ${(memory.deadlines || []).join('; ')}
📋 Yêu cầu: ${memory.requirements || ''}
⚠️ Rủi ro: ${memory.risks || ''}
📊 Dữ liệu khác: ${(memory.otherData || []).join('; ')}`

    const ragSection = relevantText
      ? `\n📄 ĐOẠN VĂN BẢN GỐC LIÊN QUAN:\n---\n${relevantText}\n---`
      : ''

    const historyCtx = chatHistory.slice(-4).map(m =>
      `${m.role === 'user' ? 'Hỏi' : 'Trả lời'}: ${m.content}`).join('\n')

    const prompt = `Bạn là trợ lý tra cứu văn bản hành chính Việt Nam.

NGUYÊN TẮC:
- Ưu tiên dùng ĐOẠN VĂN BẢN GỐC (nếu có) — chính xác nhất
- Bổ sung từ BỘ NHỚ TỔNG HỢP nếu cần
- Trích dẫn NGUYÊN VĂN câu chữ từ văn bản
- KHÔNG bịa thêm thông tin
- Nếu không có thông tin → nói: "Văn bản không có thông tin này"
${ragSection}

${ctx}
${historyCtx ? '\nLỊCH SỬ:\n' + historyCtx : ''}

CÂU HỎI: ${question}
Trả lời tiếng Việt, chính xác, trích dẫn từ văn bản:`

    try {
      // Gemini trước cho chat — nhanh và ít rate limit
      const gem = await callGemini(prompt, 2000)
      if (gem) return gem
      const groq = await callGroq(prompt, 2000)
      if (groq) return groq
      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  // ── ask: chat thông thường về dự án ──
  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, chi tiết và hữu ích.${context ? '\n\nDỮ LIỆU DỰ ÁN:\n' + context : ''}`
    try {
      const gem = await callGemini(`${sys}\n\nCâu hỏi: ${question}`, 1200)
      if (gem) return gem
      const groq = await callGroq(question, 1200, sys)
      if (groq) return groq
      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    getKey: () => getGroqKeys()[0] || getGemKeys()[0],
    saveKey,
    isReal: () => Boolean(getGroqKeys().length || getGemKeys().length),
    loading,
  }
}
