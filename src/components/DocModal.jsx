import { useState } from 'react'
import { useAI } from '../hooks/useAI'
import { useCloudinaryStorage } from '../hooks/useCloudinaryStorage'

const ST = [{ value:'done',label:'✅ Hoàn thành'},{ value:'pending',label:'🔄 Đang thực hiện'},{ value:'prep',label:'⬜ Chưa thực hiện'}]
const DT = ['Quyết định','Nghị quyết','Công văn','Tờ trình','Báo cáo','Hợp đồng','Biên bản','Thông báo','Hồ sơ','Bản vẽ','Khác']

const loadPdfJs = () => new Promise((res,rej) => {
  if (window.pdfjsLib){res(window.pdfjsLib);return}
  const s=document.createElement('script'); s.src='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'
  s.onload=()=>{window.pdfjsLib.GlobalWorkerOptions.workerSrc='https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';res(window.pdfjsLib)}
  s.onerror=rej; document.head.appendChild(s)
})
const extractPdfText = async (buf) => {
  const lib=await loadPdfJs(); const pdf=await lib.getDocument({data:buf}).promise
  const maxPages = buf.byteLength > 10*1024*1024 ? 3 : Math.min(pdf.numPages, 15)
  let text=''
  for(let i=1;i<=maxPages;i++){
    const page=await pdf.getPage(i); const c=await page.getTextContent()
    text+=c.items.map(it=>it.str).join(' ')+'\n'
  }
  return text.trim().replace(/\s+/g,' ').slice(0,8000)
}

// ── Đọc text thô từ PDF bằng pdfjs ──────────────────────────────
const extractPdfTextFull = async (buf) => {
  const lib = await loadPdfJs()
  const pdf = await lib.getDocument({ data: buf }).promise
  let text = ''
  for(let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const c = await page.getTextContent()
    text += c.items.map(it => it.str).join(' ') + '\n'
  }
  return text.trim().replace(/\s+/g, ' ').slice(0, 100000)
}

// ── Hàm chính: pdfjs (luôn dùng được) ───────────────────────────
// Gemini bị xóa hoàn toàn (AQ. key không dùng được).
// extractPdfFull chỉ còn pdfjs — đủ cho "AI tự điền" vì chỉ cần 3-5 trang đầu.
const extractPdfFull = async (buf, fileName = '', docId = null, onStatus = null) => {
  if (onStatus) onStatus('📄 Đang đọc văn bản...')
  return await extractPdfTextFull(buf.slice(0))
}

// Chỉ render phần header (30% trên trang 1) ở scale thấp → OCR nhanh hơn 4-5x
const renderPdfHeaderImage = async (buf) => {
  const lib=await loadPdfJs(); const pdf=await lib.getDocument({data:buf}).promise
  const page=await pdf.getPage(1); const vp=page.getViewport({scale:1.5})
  const cropH=Math.floor(vp.height*0.30) // chỉ lấy 30% trên
  const canvas=document.createElement('canvas'); canvas.width=vp.width; canvas.height=cropH
  const ctx=canvas.getContext('2d')
  await page.render({canvasContext:ctx,viewport:vp}).promise
  return [canvas.toDataURL('image/jpeg',0.8).split(',')[1]]
}
const loadScript = (src,check) => new Promise((res,rej)=>{
  if(check()){res();return}
  const s=document.createElement('script'); s.src=src; s.onload=res; s.onerror=rej; document.head.appendChild(s)
})
const extractDocxText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js',()=>window.mammoth)
  return (await window.mammoth.extractRawText({arrayBuffer:buf})).value.slice(0,8000)
}
const extractXlsxText = async (buf) => {
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',()=>window.XLSX)
  const wb=window.XLSX.read(buf,{type:'array'}); let text=''
  wb.SheetNames.slice(0,3).forEach(n=>{text+=`[${n}]\n`+window.XLSX.utils.sheet_to_txt(wb.Sheets[n])+'\n'})
  return text.slice(0,8000)
}
// Xóa quốc hiệu/tiêu ngữ bị dính vào "Cơ quan ban hành" do PDF header 2 cột
// (cột trái: cơ quan ban hành, cột phải: quốc hiệu/tiêu ngữ) bị gộp chung 1 dòng khi extract text
const cleanOrgField = (s = '') => {
  if (!s) return s
  return s
    .split(/(?=Cộng\s*hòa\s*xã\s*hội|Độc\s*lập\s*[-–—]?\s*Tự\s*do)/i)[0]
    .replace(/[-–—,.\s]+$/, '')
    .trim()
}

// Chỉ enrich dữ liệu AI đã trích — KHÔNG đoán/lấy từ tên file (tên file do người
// dùng đặt tùy ý, không phản ánh nội dung văn bản thật, không đáng tin để điền dữ liệu).
const enrichParsed = (obj) => {
  if (!obj) return obj
  if (obj.org) obj.org = cleanOrgField(obj.org)
  // Đánh dấu để người dùng biết cần tự kiểm tra lại — không để sai lệch âm thầm
  if (!obj.code || !obj.date || /^Văn bản /i.test(obj.subject || '')) obj.needsReview = true
  return obj
}

const parseJ = (s) => {
  try {
    const m = s.match(/\{[\s\S]*\}/)
    const obj = JSON.parse(m ? m[0] : s.replace(/```json|```/g, '').trim())
    return enrichParsed(obj)
  } catch { return null }
}

// ── Lưu Markdown lên Firestore documentMarkdown ──────────────────
const saveMarkdownToFirestore = async (markdown, fileName) => {
  try {
    const { collection, addDoc, serverTimestamp } = await import('firebase/firestore')
    const { db } = await import('../firebase')
    const mdDoc = await addDoc(collection(db, 'documentMarkdown'), {
      fileName,
      markdown,
      charCount: markdown.length,
      createdAt: serverTimestamp()
    })
    return mdDoc.id
  } catch(e) {
    console.warn('Lưu markdown lỗi:', e.message)
    return null
  }
}

export default function DocModal({ doc, onSave, onClose }) {
  const isEdit = Boolean(doc?.id)
  const { ask, analyzeText, analyzeImages } = useAI()
  const { uploadFile, uploading, getCloudName, saveCloudName } = useCloudinaryStorage()

  const [form, setForm] = useState({ code:'',date:'',org:'',subject:'',docType:'Công văn',status:'prep',detail:'',note:'', ...(doc||{}) })
  const [mode, setMode]     = useState('ai')
  const [aiTab, setAiTab]   = useState('file')
  const [rawText, setRaw]   = useState('')
  const [status, setSt]     = useState('')
  const [loading, setLoad]  = useState(false)
  const [fileQueue, setFQ]  = useState([])
  const [processing, setProc] = useState(false)
  const [pendingFile, setPF]  = useState(null)
  const [extractedText, setExtractedText] = useState('')

  const set = (k,v) => setForm(f=>({...f,[k]:v}))

  const sColor = status.startsWith('✅')?'#15803d':status.startsWith('❌')||status.startsWith('⚠️')?'#b91c1c':'#1d4ed8'
  const sBg    = status.startsWith('✅')?'#f0fdf4':status.startsWith('❌')||status.startsWith('⚠️')?'#fef2f2':'#eff6ff'

  const handleSave = async () => {
    if (!form.subject?.trim()) return alert('Nhập nội dung văn bản')
    let final = {...form, ...(extractedText ? { extractedText: extractedText.slice(0, 100000) } : {})}
    if (pendingFile) {
      setSt('⏳ Đang upload file...')
      setLoad(true)
      try {
        const fi = await uploadFile(pendingFile, pct => setSt(`⏳ Đang upload... ${pct}%`))
        if (!fi?.fileUrl) throw new Error('Không nhận được URL')
        final = {...final, ...fi, fileName: pendingFile.name, fileSize: pendingFile.size}
        setSt('✅ Upload xong!')
        await new Promise(r => setTimeout(r, 400))
      } catch(e) {
        alert('❌ Upload thất bại: ' + (e.message||'Lỗi không xác định'))
        setLoad(false)
        return
      } finally {
        setLoad(false)
      }
    }
    onSave(final)
  }

  // Phát hiện lớp text bị lỗi bảng mã (CMap hỏng) — chữ hiển thị đúng khi xem/in
  // nhưng dữ liệu text ẩn bên dưới bị trỏ sai ký tự (VD: "QUYÊT ĐINH" → "QUYET D1NH",
  // mất dấu "Đ"→"D" v.v). Tín hiệu: tỷ lệ ký tự CÓ DẤU bất thường thấp.
  // Văn bản hành chính VN thật ~16-19%, văn bản lỗi CMap ~4.68% (đã verify dữ liệu thật).
  const accentRatio = (text) => {
    const matches = text.match(/[àáâãèéêìíòóôõùúýăđơưạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỷỹ]/gi) || []
    return matches.length / Math.max(text.length, 1)
  }

  const isRealContent = (text) => {
    if (text.length < 150) return false
    if (accentRatio(text) < 0.08) return false // text có vẻ dài/hợp lệ nhưng lỗi CMap → để rơi xuống nhánh OCR ảnh
    return /căn cứ|điều \d|khoản|quyết định|nghị quyết|tờ trình|báo cáo|cộng hòa|chương \d/i.test(text)
  }

  const processOnePdf = async (buf, fileName='') => {
    // Đọc text nhanh bằng pdfjs (< 0.5s)
    const text = await extractPdfText(buf.slice(0))
    if (isRealContent(text)) {
      return await analyzeText(text.slice(0, 1500), fileName)
    }
    // PDF scan → Groq Vision header (30% trên trang 1, timeout 5s)
    setSt('⏳ Đang đọc header văn bản...')
    const imgs = await renderPdfHeaderImage(buf.slice(0))
    return await analyzeImages(imgs, fileName)
  }

  const handleFile = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    // Không bắt buộc API key — Tesseract.js sẽ OCR nếu AI không khả dụng

    if (files.length === 1) {
      const file = files[0]; const ext = file.name.split('.').pop().toLowerCase()
      setPF(file)
      setLoad(true); setSt('⏳ Đang xử lý...')
      try {
        let result = ''
        let rawExtracted = ''
        const buf = await file.arrayBuffer()
        if (ext === 'pdf') {
          setSt('⏳ Đang đọc PDF...')
          // Chỉ đọc 2 trang đầu để lấy header (nhanh hơn extractPdfFull)
          rawExtracted = await extractPdfText(buf.slice(0))
          if (!isRealContent(rawExtracted)) {
            // Thử lại với full extract (đề phòng extractPdfText bỏ sót)
            rawExtracted = await extractPdfFull(buf.slice(0), file.name, null, null)
          }
          if (isRealContent(rawExtracted)) {
            result = await analyzeText(rawExtracted.slice(0, 1500), file.name)
          } else {
            setSt('⏳ Đang đọc header văn bản...')
            const imgs = await renderPdfHeaderImage(buf.slice(0))
            result = await analyzeImages(imgs, file.name)
          }
        } else if (['doc','docx'].includes(ext)) {
          rawExtracted = await extractDocxText(buf)
          result = await analyzeText(rawExtracted.slice(0, 1500), file.name)
          rawExtracted = rawExtracted.slice(0, 100000)
        } else if (['xls','xlsx'].includes(ext)) {
          rawExtracted = await extractXlsxText(buf)
          result = await analyzeText(rawExtracted.slice(0, 1500), file.name)
          rawExtracted = rawExtracted.slice(0, 100000)
        } else if (['txt', 'md', 'csv'].includes(ext)) {
          const t = await new Promise((r)=>{const rd=new FileReader();rd.onload=ev=>r(ev.target.result.slice(0,100000));rd.readAsText(file,'utf-8')})
          rawExtracted = t.slice(0, 100000)
          if (['md','csv'].includes(ext)) {
            setSt('📋 Lưu nội dung vào bộ nhớ...')
            await saveMarkdownToFirestore(rawExtracted, file.name)
            setSt('✅ Đã lưu vào bộ nhớ! Điền thêm thông tin văn bản nếu cần.')
            setExtractedText(rawExtracted); setLoad(false); return
          }
          result = await analyzeText(t.slice(0, 1500), file.name)
        } else { setSt('⚠️ Định dạng chưa hỗ trợ'); setLoad(false); return }
        setExtractedText(rawExtracted)
        // Lưu markdown lên Firestore ngay (không cần docId)
        if (rawExtracted.length > 100) {
          saveMarkdownToFirestore(rawExtracted, file.name).then(ref => {
            if (ref) setForm(f => ({...f, markdownRef: ref}))
          })
        }
        const p = parseJ(result)
        if (p) {
          setForm(f=>({...f,...p,fileName:file.name})); setMode('manual')
          setSt(p.needsReview
            ? '⚠️ AI điền xong nhưng thiếu Số/Ngày hoặc chưa chắc đúng — vui lòng kiểm tra lại trước khi lưu'
            : '✅ AI điền xong!')
        }
        else setSt('⚠️ Không phân tích được. Điền thủ công.')
      } catch(e) {
        if (e.message==='NO_KEY') alert('Chưa có API key!')
        else if (e.message === 'AI_EXTRACT_FAILED') setSt('⚠️ Cả Gemini và Groq đều không đọc được văn bản này. Vui lòng thử lại hoặc điền thủ công.')
        else setSt(e.message === 'AI_QUOTA' ? '⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!' : '❌ Lỗi: '+e.message)
      } finally { setLoad(false) }
      return
    }

    // Batch
    const queue = files.map(f=>({name:f.name,status:'⏳ Chờ',parsed:null}))
    setFQ(queue); setProc(true)
    for (let i=0;i<files.length;i++) {
      const file=files[i]; const ext=file.name.split('.').pop().toLowerCase()
      queue[i].status='🔄 Đang xử lý...'; setFQ([...queue])
      try {
        let result=''
        let batchExtracted = ''
        const bBuf = await file.arrayBuffer()
        if (ext==='pdf') {
          batchExtracted = await extractPdfFull(bBuf.slice(0), file.name, null, (msg) => { queue[i].status=msg; setFQ([...queue]) })
          result = isRealContent(batchExtracted) ? await analyzeText(batchExtracted.slice(0,1500),file.name) : await processOnePdf(bBuf,file.name)
        } else if (['doc','docx'].includes(ext)) {
          batchExtracted = (await extractDocxText(bBuf)).slice(0,100000)
          result = await analyzeText(batchExtracted.slice(0,1500),file.name)
        } else if (['xls','xlsx'].includes(ext)) {
          batchExtracted = (await extractXlsxText(bBuf)).slice(0,100000)
          result = await analyzeText(batchExtracted.slice(0,1500),file.name)
        } else { queue[i].status='⚠️ Không hỗ trợ'; setFQ([...queue]); continue }
        const p=parseJ(result)
        if (p) {
          queue[i].status='⏳ Đang upload... 0%'; setFQ([...queue])
          let fi={}
          try {
            fi = await uploadFile(file, pct => { queue[i].status=`⏳ Đang upload... ${pct}%`; setFQ([...queue]) })
          } catch(ue) {
            console.warn('Upload err:', ue.message)
            queue[i].status='⚠️ Lưu văn bản (không có file)'
          }
          // Lưu tên file, kích thước và extractedText
          // Lưu markdown lên Firestore cho batch
          let markdownRef = null
          if (batchExtracted.length > 100) {
            markdownRef = await saveMarkdownToFirestore(batchExtracted, file.name)
          }
          onSave({...p, fileName:file.name, fileSize:file.size, extractedText: batchExtracted, ...(markdownRef ? {markdownRef} : {}), ...fi}, true)
          queue[i].status = p.needsReview ? '⚠️ Xong (thiếu Số/Ngày — cần kiểm tra)' : '✅ Xong'
        } else queue[i].status='⚠️ Không đọc được'
      } catch(e) { queue[i].status = e.message === 'AI_EXTRACT_FAILED' ? '⚠️ AI không đọc được, cần điền tay' : '❌ '+(e.message||'Lỗi') }
      setFQ([...queue])
    }
    setProc(false); setSt(`✅ Xong ${queue.filter(q=>q.status==='✅ Xong').length}/${files.length} văn bản`)
  }

  const aiFill = async () => {
    if (!rawText.trim()) return
    setLoad(true); setSt('🤖 AI đang phân tích...')
    try {
      const r=await analyzeText(rawText); const p=parseJ(r)
      if (p) {
        setForm(f=>({...f,...p})); setMode('manual')
        setSt(p.needsReview ? '⚠️ Xong nhưng thiếu Số/Ngày — vui lòng kiểm tra lại' : '✅ Xong!')
      }
      else setSt('⚠️ Không phân tích được')
    } catch(e) {
      if(e.message==='NO_KEY') alert('Chưa có key!')
      else if (e.message === 'AI_EXTRACT_FAILED') setSt('⚠️ Cả Gemini và Groq đều không đọc được. Vui lòng thử lại hoặc điền thủ công.')
      else setSt(e.message === 'AI_QUOTA' ? '⚠️ AI đã hết lượt sử dụng hôm nay. Vui lòng quay lại sau!' : '❌ Lỗi: '+e.message)
    }
    finally { setLoad(false) }
  }

  return (
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.4)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:100,padding:20}} onClick={e=>e.target===e.currentTarget&&!processing&&onClose()}>
      <div style={{background:'#fff',borderRadius:14,padding:'24px 28px',width:'100%',maxWidth:600,maxHeight:'90vh',overflowY:'auto',boxShadow:'0 8px 32px rgba(0,0,0,.15)'}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:16}}>
          <h3 style={{fontSize:15,fontWeight:600,margin:0}}>{isEdit?'Chỉnh sửa':'Thêm văn bản mới'}</h3>
          {!processing&&<button onClick={onClose} style={{background:'none',border:'none',cursor:'pointer',fontSize:18,color:'#888'}}>✕</button>}
        </div>

        {!processing&&<div style={{display:'flex',gap:8,marginBottom:16}}>
          {[['ai','✨ AI tự điền'],['manual','✏️ Nhập thủ công']].map(([v,l])=>(
            <button key={v} onClick={()=>setMode(v)} style={{flex:1,padding:'9px',borderRadius:8,fontSize:13,cursor:'pointer',border:mode===v?'2px solid #1a1a1a':'0.5px solid #ddd',background:mode===v?'#1a1a1a':'#fff',color:mode===v?'#fff':'#555',fontWeight:mode===v?600:400}}>{l}</button>
          ))}
        </div>}

        {fileQueue.length > 1 && (
          <div>
            <div style={{fontSize:13,fontWeight:600,marginBottom:10}}>{processing?'⏳ Đang xử lý hàng loạt...':'📋 Kết quả:'}</div>
            <div style={{maxHeight:260,overflowY:'auto',display:'flex',flexDirection:'column',gap:6}}>
              {fileQueue.map((f,i)=>(
                <div key={i} style={{padding:'8px 12px',borderRadius:8,fontSize:12,background:f.status.startsWith('✅')?'#f0fdf4':f.status.startsWith('❌')||f.status.startsWith('⚠️')?'#fef2f2':'#eff6ff',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                  <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:'70%'}}>{f.name}</span>
                  <span style={{color:f.status.startsWith('✅')?'#15803d':f.status.startsWith('❌')||f.status.startsWith('⚠️')?'#b91c1c':'#1d4ed8',flexShrink:0,marginLeft:8}}>{f.status}</span>
                </div>
              ))}
            </div>
            {!processing&&(
              <div style={{marginTop:12}}>
                <div style={{padding:'10px 14px',borderRadius:8,background:'#f0fdf4',border:'0.5px solid #bbf7d0',fontSize:13,color:'#15803d',marginBottom:10,textAlign:'center'}}>
                  ✅ Tất cả văn bản đã được <strong>lưu tự động</strong> vào hệ thống
                </div>
                <div style={{display:'flex',justifyContent:'flex-end'}}>
                  <button onClick={onClose} style={sBtn}>✓ Đóng</button>
                </div>
              </div>
            )}
            {status&&<div style={{marginTop:10,padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
          </div>
        )}

        {mode==='ai'&&fileQueue.length<=1&&!processing&&(
          <div>
            <div style={{display:'flex',gap:0,marginBottom:14,border:'0.5px solid #ddd',borderRadius:8,overflow:'hidden'}}>
              {[['file','📎 File'],['paste','📋 Dán text']].map(([v,l],i,arr)=>(
                <button key={v} onClick={()=>{setAiTab(v);setSt('');setRaw('')}} style={{flex:1,padding:'9px',fontSize:12,border:'none',borderRight:i<arr.length-1?'0.5px solid #ddd':'none',background:aiTab===v?'#1a1a1a':'#fff',color:aiTab===v?'#fff':'#555',fontWeight:aiTab===v?600:400,cursor:'pointer'}}>{l}</button>
              ))}
            </div>
            {aiTab==='file'&&(
              <label style={{display:'flex',flexDirection:'column',alignItems:'center',gap:8,padding:'28px 20px',border:'2px dashed #ddd',borderRadius:10,cursor:loading?'not-allowed':'pointer',background:'#fafaf8'}}>
                <input type="file" accept=".pdf,.txt,.md,.csv,.doc,.docx,.xlsx,.xls,.pptx,.ppt" onChange={handleFile} style={{display:'none'}} disabled={loading} multiple/>
                {loading?<><span style={{fontSize:20}}>⏳</span><span style={{fontSize:13,color:'#555'}}>Đang xử lý...</span></>:<><span style={{fontSize:36}}>📎</span><span style={{fontSize:13,color:'#555',fontWeight:600}}>Nhấn để chọn file</span><span style={{fontSize:11,color:'#9b9b9b'}}>PDF, Word, Excel, TXT, MD, CSV (Ctrl+Click nhiều file)</span></>}
              </label>
            )}
            {aiTab==='paste'&&<textarea value={rawText} onChange={e=>setRaw(e.target.value)} placeholder="Dán nội dung văn bản vào đây..." rows={8} style={{...iSt,resize:'vertical',minHeight:160}}/>}
            {status&&<div style={{margin:'10px 0 4px',padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
            {rawText.trim()&&!loading&&<button onClick={aiFill} style={{width:'100%',marginTop:8,padding:'12px',background:'#7F77DD',color:'#fff',border:'none',borderRadius:8,fontSize:13,fontWeight:600,cursor:'pointer'}}>✨ AI phân tích & điền tự động</button>}
          </div>
        )}

        {mode==='manual'&&!processing&&fileQueue.length<=1&&(
          <div>
            {status&&<div style={{marginBottom:12,padding:'9px 12px',borderRadius:8,fontSize:12,background:sBg,color:sColor}}>{status}</div>}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:'0 12px'}}>
              <div style={{marginBottom:12}}><label style={lSt}>Số ký hiệu</label><input value={form.code||''} onChange={e=>set('code',e.target.value)} placeholder="VD: 404/NQ-HĐTV" style={iSt}/></div>
              <div style={{marginBottom:12}}><label style={lSt}>Ngày ban hành</label><input value={form.date||''} onChange={e=>set('date',e.target.value)} placeholder="VD: 08/2025" style={iSt}/></div>
            </div>
            <div style={{marginBottom:12}}><label style={lSt}>Cơ quan ban hành</label><input value={form.org||''} onChange={e=>set('org',e.target.value)} placeholder="VD: Tổng công ty VATM" style={iSt}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Loại văn bản</label><select value={form.docType} onChange={e=>set('docType',e.target.value)} style={iSt}>{DT.map(t=><option key={t}>{t}</option>)}</select></div>
            <div style={{marginBottom:12}}><label style={lSt}>Nội dung / Về việc <span style={{color:'#e53e3e'}}>*</span></label><input value={form.subject||''} onChange={e=>set('subject',e.target.value)} placeholder="Tóm tắt nội dung chính" style={iSt}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Trích yếu chi tiết</label><textarea value={form.detail||''} onChange={e=>set('detail',e.target.value)} rows={3} style={{...iSt,resize:'vertical'}}/></div>
            <div style={{marginBottom:12}}><label style={lSt}>Ghi chú</label><textarea value={form.note||''} onChange={e=>set('note',e.target.value)} rows={2} style={{...iSt,resize:'vertical'}}/></div>
            <div style={{marginBottom:16}}>
              <label style={lSt}>Trạng thái</label>
              <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
                {ST.map(s=><button key={s.value} onClick={()=>set('status',s.value)} style={{padding:'6px 14px',borderRadius:20,fontSize:12,border:form.status===s.value?'2px solid #1a1a1a':'0.5px solid #ddd',background:form.status===s.value?'#1a1a1a':'#fff',color:form.status===s.value?'#fff':'#555',cursor:'pointer'}}>{s.label}</button>)}
              </div>
            </div>
            <div style={{marginBottom:16}}>
              <label style={lSt}>📎 Đính kèm file (PDF, Word, Excel...)</label>
              {pendingFile ? (
                <div style={{padding:'10px 12px',borderRadius:8,background:'#eff6ff',border:'0.5px solid #bfdbfe',fontSize:12,color:'#1d4ed8',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                  <span>📎 {pendingFile.name} ({(pendingFile.size/1024/1024).toFixed(1)} MB)</span>
                  <button onClick={()=>setPF(null)} style={{background:'none',border:'none',cursor:'pointer',color:'#e53e3e',fontSize:14}}>✕</button>
                </div>
              ) : (
                <label style={{display:'flex',alignItems:'center',gap:10,padding:'10px 14px',border:'1.5px dashed #ddd',borderRadius:8,cursor:'pointer',background:'#fafaf8'}}>
                  <input type="file" accept=".pdf,.txt,.md,.csv,.doc,.docx,.xlsx,.xls" onChange={e=>{if(e.target.files[0]) setPF(e.target.files[0])}} style={{display:'none'}}/>
                  <span style={{fontSize:20}}>📎</span>
                  <span style={{fontSize:13,color:'#888'}}>Nhấn để chọn file đính kèm</span>
                </label>
              )}
            </div>
            <div style={{display:'flex',gap:8,justifyContent:'flex-end'}}>
              <button onClick={onClose} style={cBtn}>Hủy</button>
              <button onClick={handleSave} disabled={loading} style={sBtn}>{loading?'⏳ Đang lưu...':(isEdit?'💾 Lưu':'➕ Thêm văn bản')}</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
const iSt = {width:'100%',padding:'8px 10px',fontSize:13,border:'0.5px solid #ddd',borderRadius:8,outline:'none',boxSizing:'border-box',background:'#fff',color:'#1a1a1a'}
const lSt = {fontSize:12,color:'#6b6b6b',display:'block',marginBottom:4}
const cBtn = {padding:'8px 18px',border:'0.5px solid #ddd',borderRadius:8,cursor:'pointer',background:'#fff',color:'#555',fontSize:13}
const sBtn = {padding:'8px 20px',border:'none',borderRadius:8,cursor:'pointer',background:'#1a1a1a',color:'#fff',fontSize:13,fontWeight:500}
