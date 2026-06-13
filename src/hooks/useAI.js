// src/hooks/useAI.js
// Hỗ trợ nhiều Groq key xoay vòng + Gemini fallback
// Tổng quota ~3-5 triệu token/ngày nếu có nhiều key

import { useState } from 'react'

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'

const GROQ_TEXT_MODELS   = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile']
const GROQ_VISION_MODEL  = 'meta-llama/llama-4-scout-17b-16e-instruct'
const GEMINI_MODELS      = ['gemini-2.0-flash', 'gemini-2.0-flash-lite']
const GEM_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${key}`

const resetIdxIfNewDay = () => {
  const today = new Date().toDateString()
  if (localStorage.getItem('ai_day') !== today) {
    localStorage.setItem('ai_day',      today)
    localStorage.setItem('ai_groq_idx', '0')
    localStorage.setItem('ai_gem_idx',  '0')
  }
}

const SYSTEM = `Bạn là chuyên gia phân tích văn bản hành chính Việt Nam.
Đọc nội dung (3 trang đầu) và trả về JSON duy nhất, không giải thích thêm.
- "code": số ký hiệu dạng "404/NQ-HĐTV"
- "date": CHỈ dạng số D/M/YYYY hoặc M/YYYY (KHÔNG viết chữ, KHÔNG kèm địa danh)
- "org": cơ quan BAN HÀNH
- "docType": Quyết định|Nghị quyết|Công văn|Tờ trình|Báo cáo|Hợp đồng|Biên bản|Thông báo|Hồ sơ|Bản vẽ|Khác
- "subject": câu mô tả NỘI DUNG VỀ VIỆC GÌ
- "detail": tóm tắt 2-3 điểm quan trọng
- "note": 1 câu nhận xét ý nghĩa
- "status": "done" nếu đã ban hành, "prep" nếu chưa
{"code":"","date":"","org":"","docType":"","subject":"","detail":"","note":"","status":"done"}`

export function useAI() {
  const [loading, setLoading] = useState(false)

  // ── Quản lý key ───────────────────────────────────────────────
  // Nhiều Groq key ngăn cách bằng dấu phẩy
  const getGroqKeys = () =>
    (localStorage.getItem('groq_key') || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean)
  const getGemKey   = () => localStorage.getItem('gemini_key') || ''
  const getKey      = () => getGroqKeys()[0] || getGemKey()
  const isReal      = () => Boolean(getKey())

  const saveKey = (k) => {
    k = k.trim()
    if (k.startsWith('gsk_')) {
      const existing = getGroqKeys()
      if (!existing.includes(k)) existing.push(k)
      localStorage.setItem('groq_key', existing.join(','))
    } else {
      localStorage.setItem('gemini_key', k)
    }
  }

  // ── Gọi Groq text — thử từng key × từng model ────────────────
  const callGroqText = async (model, userText) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model, max_tokens:1000, temperature:0.05,
            messages:[{ role:'system', content:SYSTEM },{ role:'user', content:userText }],
          }),
        })
        if (!res.ok) {
          const e = await res.json().catch(() => ({}))
          const msg = e?.error?.message || ''
          if (res.status === 429 || msg.includes('decommissioned') || msg.includes('rate')) continue
          throw new Error(msg || `HTTP ${res.status}`)
        }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  // ── Gọi Groq vision ───────────────────────────────────────────
  const callGroqVision = async (base64Images, hint) => {
    const keys = getGroqKeys()
    if (!keys.length) throw new Error('QUOTA')
    for (const key of keys) {
      try {
        const res = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
          body: JSON.stringify({
            model: GROQ_VISION_MODEL, max_tokens:1000, temperature:0.05,
            messages:[{ role:'user', content:[
              ...base64Images.slice(0,3).map(b64 => ({
                type:'image_url', image_url:{ url:`data:image/jpeg;base64,${b64}` }
              })),
              { type:'text', text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` }
            ]}],
          }),
        })
        if (!res.ok) {
          if (res.status === 429) continue
          throw new Error(`HTTP ${res.status}`)
        }
        return (await res.json()).choices?.[0]?.message?.content || ''
      } catch(e) { if(e.message !== 'QUOTA') throw e }
    }
    throw new Error('QUOTA')
  }

  // ── Gọi Gemini ───────────────────────────────────────────────
  const callGemini = async (model, parts) => {
    const key = getGemKey()
    if (!key) throw new Error('QUOTA')
    const res = await fetch(GEM_URL(model, key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents:[{ parts }],
        generationConfig:{ temperature:0.05, maxOutputTokens:1000 },
      }),
    })
    if (!res.ok) {
      const e = await res.json().catch(() => ({}))
      if (res.status === 429 || res.status === 503 || res.status === 404) throw new Error('QUOTA')
      throw new Error(e?.error?.message || `HTTP ${res.status}`)
    }
    return (await res.json()).candidates?.[0]?.content?.parts?.[0]?.text || ''
  }

  // ── Phân tích text — xoay vòng tất cả ───────────────────────
  const analyzeText = async (text, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint  = fileName ? `\nTên file: ${fileName}` : ''
    const clean = text.replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/[ \t]{3,}/g,' ').slice(0,6000)
    const prompt = `Phân tích văn bản (3 trang đầu):${hint}\n\n---\n${clean}\n---`
    try {
      // Groq: thử từng model
      let gIdx = parseInt(localStorage.getItem('ai_groq_idx') || '0')
      while (gIdx < GROQ_TEXT_MODELS.length) {
        try {
          const r = await callGroqText(GROQ_TEXT_MODELS[gIdx], prompt)
          localStorage.setItem('ai_groq_idx', gIdx)
          return r
        } catch(e) { if(e.message !== 'QUOTA') throw e; gIdx++; localStorage.setItem('ai_groq_idx', gIdx) }
      }
      // Gemini fallback
      let mIdx = parseInt(localStorage.getItem('ai_gem_idx') || '0')
      while (mIdx < GEMINI_MODELS.length) {
        try {
          const r = await callGemini(GEMINI_MODELS[mIdx], [{ text:`${SYSTEM}\n\n${prompt}` }])
          localStorage.setItem('ai_gem_idx', mIdx)
          return r
        } catch(e) { if(e.message !== 'QUOTA') throw e; mIdx++; localStorage.setItem('ai_gem_idx', mIdx) }
      }
      throw new Error('Tất cả AI hết quota hôm nay. Vui lòng thử lại sau hoặc thêm key mới.')
    } finally { setLoading(false) }
  }

  // ── Phân tích ảnh PDF scan ───────────────────────────────────
  const analyzeImages = async (base64Images, fileName = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const hint = fileName ? ` (${fileName})` : ''
    try {
      if (getGroqKeys().length) {
        try { return await callGroqVision(base64Images, hint) } catch(e) { if(e.message !== 'QUOTA') throw e }
      }
      let mIdx = parseInt(localStorage.getItem('ai_gem_idx') || '0')
      while (mIdx < GEMINI_MODELS.length) {
        try {
          const parts = [
            { text:`${SYSTEM}\n\nĐọc ảnh scan văn bản Việt Nam${hint} và trả về JSON.` },
            ...base64Images.slice(0,3).map(b64 => ({ inline_data:{ mime_type:'image/jpeg', data:b64 } }))
          ]
          return await callGemini(GEMINI_MODELS[mIdx], parts)
        } catch(e) { if(e.message !== 'QUOTA') throw e; mIdx++; localStorage.setItem('ai_gem_idx', mIdx) }
      }
      throw new Error('Tất cả AI hết quota. Thử lại sau.')
    } finally { setLoading(false) }
  }

  // ── Chat ─────────────────────────────────────────────────────
  const ask = async (question, context = '') => {
    setLoading(true)
    resetIdxIfNewDay()
    const sys = `Bạn là trợ lý quản lý dự án VATM. Trả lời tiếng Việt, ngắn gọn.${context?'\n\nDữ liệu:\n'+context:''}`
    try {
      let gIdx = parseInt(localStorage.getItem('ai_groq_idx') || '0')
      while (gIdx < GROQ_TEXT_MODELS.length) {
        try {
          const keys = getGroqKeys()
          for (const key of keys) {
            const res = await fetch(GROQ_URL, {
              method:'POST',
              headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${key}` },
              body:JSON.stringify({ model:GROQ_TEXT_MODELS[gIdx], max_tokens:800, temperature:0.1,
                messages:[{role:'system',content:sys},{role:'user',content:question}] }),
            })
            if (!res.ok) { if(res.status===429) continue; throw new Error(`HTTP ${res.status}`) }
            return (await res.json()).choices?.[0]?.message?.content || ''
          }
          gIdx++; localStorage.setItem('ai_groq_idx', gIdx)
        } catch(e) { if(e.message !== 'QUOTA') throw e; gIdx++ }
      }
      let mIdx = parseInt(localStorage.getItem('ai_gem_idx') || '0')
      while (mIdx < GEMINI_MODELS.length) {
        try { return await callGemini(GEMINI_MODELS[mIdx], [{text:`${sys}\n\nCâu hỏi: ${question}`}]) }
        catch(e) { if(e.message !== 'QUOTA') throw e; mIdx++ }
      }
      throw new Error('Tất cả AI hết quota.')
    } finally { setLoading(false) }
  }

  return { ask, analyzeText, analyzeImages, getKey, saveKey, isReal, loading }
}
