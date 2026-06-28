// src/hooks/useAI.js
// Keys KHÔNG bao giờ nằm ở browser — mọi call AI đi qua /api/groq-proxy và /api/gemini-proxy.
// Vercel đọc process.env.GROQ_API_KEY và GEMINI_API_KEY ở server side (không có prefix VITE_).
import { useState } from 'react'

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day', today)
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.

BƯỚC 1 — Xác định loại văn bản trước, vì mỗi loại có cách đọc khác nhau:

(A) NẾU là Quyết định/Nghị quyết/Công văn/Tờ trình/Báo cáo/Thông báo:
Header LUÔN có cấu trúc cố định 2 cột:
[Cơ quan chủ quản cấp trên]          [CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM]
[Cơ quan ban hành]                   [Độc lập - Tự do - Hạnh phúc]
[Số: .../...]                        [Địa danh, ngày ... tháng ... năm ...]
(PDF có thể gộp 2 cột dính liền thành 1 dòng — tự suy luận tách đúng theo cấu trúc trên)
→ "org" CHỈ lấy [Cơ quan ban hành] (dòng ngay TRƯỚC "Số:"). TUYỆT ĐỐI KHÔNG lấy [Cơ quan chủ quản cấp trên] (dòng phía trên, ví dụ Tổng công ty/Bộ/UBND cấp trên — khác cấp, không lấy), KHÔNG lấy "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM", KHÔNG lấy "Độc lập - Tự do - Hạnh phúc".

(B) NẾU là Hợp đồng/Biên bản/Hồ sơ/Bản vẽ hoặc bất kỳ loại nào KHÔNG theo mẫu trên:
KHÔNG áp đặt cấu trúc 2 cột — tự đọc và suy luận từ ngữ cảnh trang đầu:
- "code": tìm cụm "Số:" hoặc "Hợp đồng số:" xuất hiện ở bất kỳ vị trí nào trong trang đầu (có thể ở đầu, giữa dòng tiêu đề, hoặc cuối trang).
- "date": tìm ngày ký/lập — với Hợp đồng/Biên bản thường nằm trong câu mở đầu dạng "Hôm nay, ngày... tháng... năm..., tại...", hoặc gần phần ký tên cuối văn bản.
- "org": đơn vị/cơ quan chủ trì chính, hoặc "Bên A" nếu là hợp đồng giữa 2 bên. Nếu không xác định rõ → để trống, KHÔNG suy đoán bừa.

QUY TẮC CHUNG cho cả 2 trường hợp:
- "code": chỉ lấy số/ký hiệu thật của văn bản, KHÔNG lấy số điều/khoản/trang/năm.
- "date": đọc CHÍNH XÁC từng chữ số ngày/tháng/năm, không đoán. Nếu chữ số bị mờ/không rõ → để chuỗi rỗng "", TUYỆT ĐỐI KHÔNG bịa số. Trả về dạng "D/M/YYYY".
- "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM" và "Độc lập - Tự do - Hạnh phúc" là quốc hiệu/tiêu ngữ CỐ ĐỊNH có trong MỌI văn bản — không bao giờ là tên cơ quan/đơn vị, loại bỏ hoàn toàn khỏi tất cả các trường.

- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

// ── Gọi proxy server — key nằm server, browser không bao giờ thấy ──
const withTimeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))
])

const callGemini = async (prompt, maxTokens = 1000) => {
  try {
    const res = await withTimeout(fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, maxTokens }),
    }), 25000)
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
}

// callGeminiVision → /api/gemini-proxy với parts (text + inline_data ảnh)
// Dùng route riêng (/api/gemini-proxy) — không bị ảnh hưởng nếu /api/groq-proxy lỗi route.
const callGeminiVision = async (b64, promptText, maxTokens = 700) => {
  try {
    const res = await withTimeout(fetch('/api/gemini-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [
          { text: promptText },
          { inline_data: { mime_type: 'image/jpeg', data: b64 } },
        ],
        maxTokens,
      }),
    }), 25000)
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
}

// callGroq → /api/groq-proxy (server đọc GROQ_API_KEY, browser không thấy key)
const callGroq = async (prompt, maxTokens = 1000, system = null) => {
  try {
    const messages = system
      ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }]
    const res = await withTimeout(fetch('/api/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens }),
    }), 25000)
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
}

// callOpenRouter — Llama 4 Maverick :free, hạ tầng RIÊNG độc lập với Gemini/Groq.
// Dùng làm phương án 3 cho ask() — khi cả Gemini và Groq cùng bị rate-limit/lỗi
// (như đã gặp thực tế), vẫn còn 1 nguồn nữa thay vì báo "AI đang bận" ngay.
const callOpenRouter = async (prompt, maxTokens = 1000, system = null) => {
  try {
    const messages = system
      ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
      : [{ role: 'user', content: prompt }]
    const res = await withTimeout(fetch('/api/openrouter-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens }),
    }), 25000)
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
}

// callGroqVision → /api/groq-proxy với vision:true + base64 image
const callGroqVision = async (b64, promptText, maxTokens = 400) => {
  try {
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
      ]
    }]
    const res = await withTimeout(fetch('/api/groq-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, maxTokens, vision: true }),
    }), 25000)
    if (!res.ok) return null
    const data = await res.json()
    return data.text || null
  } catch { return null }
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
      // Cả Gemini và Groq đều không đọc được — KHÔNG đoán bằng regex/tên file.
      // Báo lỗi rõ ràng để người dùng biết và điền tay, thay vì âm thầm lưu dữ liệu sai.
      throw new Error('AI_EXTRACT_FAILED')
    } finally { setLoading(false) }
  }

  // ── analyzeImages ──
  // Chỉ dùng AI để đọc: 1) Groq Vision đọc ảnh trực tiếp → 2) nếu không đọc được,
  // OCR bằng Tesseract lấy text thô RỒI ĐƯA QUA AI (Gemini/Groq text) để trích xuất —
  // không dùng regex ở bất kỳ bước nào.
  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    try {
      const b64 = base64Images[0]

      const visionPrompt = `Đọc kỹ ảnh này — đây là TOÀN BỘ trang 1 của 1 văn bản tiếng Việt (có thể là văn bản hành chính nhà nước, hợp đồng, hoặc biên bản).

(A) NẾU là Quyết định/Nghị quyết/Công văn/Tờ trình/Báo cáo/Thông báo:
Header thường có 2 cột ở ĐẦU trang: cột trái [Cơ quan chủ quản]/[Cơ quan ban hành]/[Số:...], cột phải [CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM]/[Độc lập - Tự do - Hạnh phúc]/[Địa danh, ngày...tháng...năm...].
→ "org" CHỈ lấy [Cơ quan ban hành] (dòng ngay trên "Số:"). KHÔNG lấy cơ quan chủ quản cấp trên, KHÔNG lấy quốc hiệu/tiêu ngữ.

(B) NẾU là Hợp đồng: "Số:" thường nằm GIỮA trang (trong khối tiêu đề "HỢP ĐỒNG..."), KHÔNG ở đầu trang như (A). Ngày ký thường nằm Ở CUỐI trang (dạng "Hà Nội, ngày... tháng... năm..."), KHÔNG ở đầu trang — phải nhìn xuống cuối ảnh để tìm. "org" lấy 1 trong 2 bên ký hợp đồng (Bên A, thường là bên mời/chủ đầu tư) nếu xác định được.

(C) NẾU là Biên bản (họp/nghiệm thu/...): thường KHÔNG có header quốc hiệu — văn bản bắt đầu ngay bằng câu "Hôm nay, ngày... tháng... năm..., tại..., chúng tôi gồm có:". Đọc đúng ngày/tháng/năm trong câu này. "Số:" có thể không có — nếu không thấy, để trống.

(D) Loại khác không theo mẫu nào trên: tự đọc và suy luận từ toàn bộ nội dung nhìn thấy trong ảnh, không ép theo cấu trúc (A)/(B)/(C).

QUY TẮC CHUNG:
- "code": lấy đúng số/ký hiệu của văn bản — đọc CHÍNH XÁC từng chữ số/chữ cái nhìn thấy, không suy đoán. Nếu không tìm thấy ở đâu trong ảnh → để trống.
- "date": đọc CHÍNH XÁC từng chữ số ngày/tháng/năm, dù nó nằm ở đầu hay cuối trang. Nếu chữ số nào không rõ/không chắc → để trống, TUYỆT ĐỐI không bịa.
- "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM" và "Độc lập - Tự do - Hạnh phúc" là quốc hiệu/tiêu ngữ cố định — không bao giờ là tên cơ quan/đơn vị, loại bỏ khỏi mọi trường.
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ (dòng "V/v:", tên gói thầu/dự án trong hợp đồng, hoặc nội dung cuộc họp trong biên bản)
- "detail": tóm tắt ngắn 1-2 điểm chính thấy được trong ảnh
- "note": để trống ""
- "status": "done"

Trả về CHỈ 1 JSON duy nhất, không giải thích thêm:
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

      const tryParseVisionJson = (txt) => {
        if (!txt) return null
        const m = txt.match(/\{[\s\S]*\}/)
        if (!m) return null
        try {
          const parsed = JSON.parse(m[0])
          return JSON.stringify({ ...parsed, note: parsed.note || '', status: 'done' })
        } catch { return null }
      }

      // 1) Gemini Vision trước — Groq Vision (Llama 4 Scout) đã bị Groq deprecate
      //    ngày 27/6/2026, ngừng hẳn 17/7/2026, model thay thế Groq đề xuất
      //    (GPT-OSS-120B/Qwen3.6-27B) KHÔNG đọc được ảnh. Ưu tiên Gemini cho ổn định dài hạn.
      const geminiResult = tryParseVisionJson(await callGeminiVision(b64, visionPrompt, 700))
      if (geminiResult) return geminiResult

      // 2) Gemini lỗi → thử Groq Vision (vẫn còn dùng được đến 17/7/2026)
      const groqResult = tryParseVisionJson(await callGroqVision(b64, visionPrompt, 700))
      if (groqResult) return groqResult

      // 3) Cả 2 AI Vision đều không đọc trực tiếp được → OCR Tesseract lấy text thô,
      // sau đó đưa qua AI text (Gemini/Groq) để trích xuất — KHÔNG dùng regex.
      try {
        const { createWorker } = await import('tesseract.js')
        const worker = await createWorker(['vie', 'eng'])
        const { data: { text } } = await worker.recognize(`data:image/jpeg;base64,${b64}`)
        await worker.terminate()
        if ((text || '').trim().length > 30) return await analyzeText(text, fileName)
      } catch { /* ignore, rơi xuống lỗi cuối */ }

      throw new Error('AI_EXTRACT_FAILED')
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
      const gem = await callGemini(prompt, 2000)
      if (gem) return gem
      const groq = await callGroq(prompt, 2000)
      if (groq) return groq
      const or = await callOpenRouter(prompt, 2000)
      if (or) return or
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
      const gem = await callGemini(`${sys}\n\nCâu hỏi: ${question}`, 3000)
      if (gem) return gem
      const groq = await callGroq(question, 3000, sys)
      if (groq) return groq
      const or = await callOpenRouter(question, 3000, sys)
      if (or) return or
      const err = new Error('AI_RATE_LIMIT')
      err.waitSeconds = 30
      throw err
    } finally { setLoading(false) }
  }

  return {
    ask, analyzeText, analyzeImages, analyzeDeepForMemory, askDeep,
    loading,
  }
}