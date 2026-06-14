// src/components/LoginRegister.jsx
import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'

export default function LoginRegister() {
  const { login, register, requestReset } = useAuth()
  const [tab, setTab] = useState('login')
  return (
    <div style={{ minHeight:'100vh', background:'linear-gradient(135deg,#e8f4fd 0%,#bdd9f0 100%)', display:'flex', alignItems:'center', justifyContent:'center', padding:20 }}>
      <div style={{ background:'#fff', borderRadius:24, boxShadow:'0 16px 48px rgba(0,0,0,.12)', maxWidth:480, width:'100%', overflow:'hidden' }}>
        <div style={{ background:'linear-gradient(135deg,#0a2342,#1a4a7a)', padding:'32px 40px 24px', textAlign:'center', color:'#fff' }}>
          <img src="/vatm-logo.png" alt="VATM" style={{ width:72, height:72, borderRadius:'50%', objectFit:'cover', marginBottom:12, border:'3px solid rgba(255,255,255,.3)' }}/>
          <div style={{ fontSize:20, fontWeight:700, marginBottom:4 }}>VATM-PMU</div>
          <div style={{ fontSize:13, opacity:.8 }}>Hệ thống Quản lý Dự án</div>
        </div>
        {tab !== 'forgot' && (
          <div style={{ display:'flex', borderBottom:'0.5px solid #e5e7eb' }}>
            {[['login','🔑 Đăng nhập'],['register','📝 Đăng ký']].map(([v,l]) => (
              <button key={v} onClick={() => setTab(v)}
                style={{ flex:1, padding:'14px', border:'none', cursor:'pointer', fontSize:14, fontWeight:600,
                  background: tab===v?'#fff':'#f9fafb', color: tab===v?'#0a2342':'#9ca3af',
                  borderBottom: tab===v?'2.5px solid #0a2342':'2.5px solid transparent' }}>{l}</button>
            ))}
          </div>
        )}
        <div style={{ padding:'32px 40px 36px' }}>
          {tab==='login'    && <LoginForm    onSwitch={()=>setTab('register')} onForgot={()=>setTab('forgot')} login={login}/>}
          {tab==='register' && <RegisterForm onSwitch={()=>setTab('login')} register={register}/>}
          {tab==='forgot'   && <ForgotForm   onBack={()=>setTab('login')} requestReset={requestReset}/>}
        </div>
      </div>
    </div>
  )
}

// ── Đăng nhập ──────────────────────────────────────────────────
function LoginForm({ onSwitch, onForgot, login }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [err,      setErr]      = useState('')
  const [loading,  setLoading]  = useState(false)
  const [showPw,   setShowPw]   = useState(false)
  const [ready,    setReady]    = useState(false)
  const pwRef = useRef(null)
  const unRef = useRef(null)

  useEffect(() => {
    const clear = () => {
      setPassword(''); setUsername('')
      if (pwRef.current) pwRef.current.value = ''
      if (unRef.current) unRef.current.value = ''
    }
    clear()
    const t1 = setTimeout(clear, 100)
    const t2 = setTimeout(clear, 300)
    const t3 = setTimeout(() => { clear(); setReady(true) }, 600)
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3) }
  }, [])

  const handleSubmit = async () => {
    if (!username.trim() || !password) { setErr('Vui lòng nhập đầy đủ thông tin.'); return }
    setLoading(true); setErr('')
    try { await login(username, password) }
    catch(e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <input type="text" style={{ display:'none' }} autoComplete="username"/>
      <input type="password" style={{ display:'none' }} autoComplete="current-password"/>
      <h3 style={{ fontSize:18, fontWeight:700, color:'#0a2342', marginBottom:20, textAlign:'center' }}>Chào mừng trở lại!</h3>

      <label style={lSt}>Tên đăng nhập</label>
      <input ref={unRef} value={username} onChange={e=>setUsername(e.target.value)}
        onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
        placeholder="Nhập tên đăng nhập" autoComplete="off" name="vatm_un"
        readOnly={!ready} onFocus={e=>e.target.removeAttribute('readOnly')} style={iSt}/>

      <label style={lSt}>Mật khẩu</label>
      <div style={{ position:'relative', marginBottom:8 }}>
        <input ref={pwRef} value={password} onChange={e=>setPassword(e.target.value)}
          onKeyDown={e=>e.key==='Enter'&&handleSubmit()}
          type={showPw?'text':'password'} placeholder="Nhập mật khẩu"
          autoComplete="new-password" name="vatm_pw"
          readOnly={!ready} onFocus={e=>e.target.removeAttribute('readOnly')}
          style={{ ...iSt, marginBottom:0, paddingRight:44 }}/>
        <button onClick={()=>setShowPw(v=>!v)}
          style={{ position:'absolute', right:12, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', cursor:'pointer', fontSize:16, color:'#888' }}>
          {showPw?'🙈':'👁️'}
        </button>
      </div>

      <div style={{ textAlign:'right', marginBottom:16 }}>
        <span onClick={onForgot} style={{ fontSize:12, color:'#2563eb', cursor:'pointer', textDecoration:'underline' }}>
          Quên mật khẩu?
        </span>
      </div>

      {err && <ErrBox msg={err}/>}

      <button onClick={handleSubmit} disabled={loading} style={{ ...btnSt, background:loading?'#6b7280':'#0a2342' }}>
        {loading?'⏳ Đang đăng nhập...':'🔑 Đăng nhập'}
      </button>
      <p style={{ textAlign:'center', fontSize:13, color:'#888', marginTop:16 }}>
        Chưa có tài khoản?{' '}
        <span onClick={onSwitch} style={{ color:'#0a2342', fontWeight:600, cursor:'pointer', textDecoration:'underline' }}>Đăng ký ngay</span>
      </p>
    </div>
  )
}

// ── Đăng ký ────────────────────────────────────────────────────
function RegisterForm({ onSwitch, register }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirm,  setConfirm]  = useState('')
  const [name,     setName]     = useState('')
  const [unit,     setUnit]     = useState('')
  const [email,    setEmail]    = useState('')
  const [err,      setErr]      = useState('')
  const [loading,  setLoading]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [showPw,   setShowPw]   = useState(false)
  const [ready,    setReady]    = useState(false)

  useEffect(() => {
    const clear = () => { setPassword(''); setConfirm('') }
    clear()
    const t1 = setTimeout(clear, 100)
    const t2 = setTimeout(() => { clear(); setReady(true) }, 500)
    return () => { clearTimeout(t1); clearTimeout(t2) }
  }, [])

  const handleSubmit = async () => {
    setErr('')
    if (!username.trim()) { setErr('Vui lòng nhập tên đăng nhập.'); return }
    if (!/^[a-z0-9_]{3,30}$/.test(username.trim().toLowerCase())) { setErr('Tên đăng nhập chỉ gồm chữ thường, số, dấu _ (3–30 ký tự).'); return }
    if (password.length < 8) { setErr('Mật khẩu phải có ít nhất 8 ký tự.'); return }
    if (!/[A-Z]/.test(password)) { setErr('Mật khẩu phải có ít nhất 1 chữ HOA (A-Z).'); return }
    if (!/[a-z]/.test(password)) { setErr('Mật khẩu phải có ít nhất 1 chữ thường (a-z).'); return }
    if (!/[0-9]/.test(password)) { setErr('Mật khẩu phải có ít nhất 1 chữ số (0-9).'); return }
    if (!/[!@#$%^&*()_+\-=\[\]{};:\'",.<>?/|`~]/.test(password)) { setErr('Mật khẩu phải có ít nhất 1 ký tự đặc biệt (!@#$%...).'); return }
    if (password !== confirm) { setErr('Mật khẩu xác nhận không khớp.'); return }
    if (!name.trim()) { setErr('Vui lòng nhập họ tên.'); return }
    if (!unit.trim()) { setErr('Vui lòng nhập đơn vị công tác.'); return }
    if (!email.trim() || !email.includes('@')) { setErr('Vui lòng nhập email hợp lệ.'); return }
    setLoading(true)
    try { await register({ username:username.trim().toLowerCase(), password, name, unit, email }); setDone(true) }
    catch(e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  if (done) return (
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:56, marginBottom:12 }}>🎉</div>
      <h3 style={{ fontSize:17, fontWeight:700, color:'#15803d', marginBottom:8 }}>Đăng ký thành công!</h3>
      <p style={{ fontSize:13, color:'#555', lineHeight:1.8, marginBottom:16 }}>
        Tài khoản <strong>"{username}"</strong> đã được tạo.<br/>Vui lòng chờ quản trị viên xét duyệt.
      </p>
      <div style={{ background:'#fef9c3', borderRadius:10, padding:'12px', border:'0.5px solid #fde047', fontSize:12, color:'#854d0e', marginBottom:20 }}>
        📧 Liên hệ: <strong>hoangductudhbk@gmail.com</strong>
      </div>
      <button onClick={onSwitch} style={{ ...btnSt, background:'#0a2342' }}>← Quay lại đăng nhập</button>
    </div>
  )

  return (
    <div>
      <input type="text" style={{ display:'none' }} autoComplete="username"/>
      <input type="password" style={{ display:'none' }} autoComplete="new-password"/>
      <h3 style={{ fontSize:17, fontWeight:700, color:'#0a2342', marginBottom:4, textAlign:'center' }}>Tạo tài khoản mới</h3>
      <p style={{ fontSize:12, color:'#888', textAlign:'center', marginBottom:20 }}>Quản trị viên sẽ phê duyệt trước khi bạn đăng nhập được</p>

      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
        <div>
          <label style={lSt}>Tên đăng nhập <Req/></label>
          <input value={username} onChange={e=>setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,''))}
            placeholder="vd: nguyenvana" autoComplete="off" style={iSt}/>
        </div>
        <div>
          <label style={lSt}>Họ và tên <Req/></label>
          <input value={name} onChange={e=>setName(e.target.value)} placeholder="Nguyễn Văn A" autoComplete="off" style={iSt}/>
        </div>
      </div>

      <label style={lSt}>Mật khẩu <Req/></label>
      <div style={{ position:'relative' }}>
        <input value={password} onChange={e=>setPassword(e.target.value)}
          type={showPw?'text':'password'} placeholder="Mật khẩu bao gồm chữ viết Hoa, viết thường, số, ký tự đặc biệt"
          autoComplete="new-password" readOnly={!ready} onFocus={e=>e.target.removeAttribute('readOnly')}
          style={{ ...iSt, paddingRight:44 }}/>
        <button onClick={()=>setShowPw(v=>!v)}
          style={{ position:'absolute', right:12, top:14, background:'none', border:'none', cursor:'pointer', fontSize:16, color:'#888' }}>
          {showPw?'🙈':'👁️'}
        </button>
      </div>

      <label style={lSt}>Xác nhận mật khẩu <Req/></label>
      <input value={confirm} onChange={e=>setConfirm(e.target.value)}
        type="password" placeholder="Nhập lại mật khẩu"
        autoComplete="new-password" readOnly={!ready} onFocus={e=>e.target.removeAttribute('readOnly')} style={iSt}/>

      <label style={lSt}>Đơn vị công tác <Req/></label>
      <input value={unit} onChange={e=>setUnit(e.target.value)}
        placeholder="Ban QLDA chuyên ngành Quản lý bay" autoComplete="off" style={iSt}/>

      <label style={lSt}>Email liên hệ <Req/> <span style={{ fontWeight:400, color:'#888' }}>(dùng khi quên mật khẩu)</span></label>
      <input value={email} onChange={e=>setEmail(e.target.value)}
        placeholder="example@vatm.vn" type="email" autoComplete="email"
        style={{ ...iSt, marginBottom:err?8:20 }}/>

      {err && <ErrBox msg={err}/>}

      <button onClick={handleSubmit} disabled={loading} style={{ ...btnSt, background:loading?'#6b7280':'#0a2342' }}>
        {loading?'⏳ Đang xử lý...':'📨 Gửi đăng ký'}
      </button>
      <p style={{ textAlign:'center', fontSize:13, color:'#888', marginTop:16 }}>
        Đã có tài khoản?{' '}
        <span onClick={onSwitch} style={{ color:'#0a2342', fontWeight:600, cursor:'pointer', textDecoration:'underline' }}>Đăng nhập</span>
      </p>
    </div>
  )
}

// ── Quên mật khẩu ──────────────────────────────────────────────
function ForgotForm({ onBack, requestReset }) {
  const [username,     setUsername]     = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [err,          setErr]          = useState('')
  const [loading,      setLoading]      = useState(false)
  const [done,         setDone]         = useState(false)

  const handleSubmit = async () => {
    setErr('')
    if (!username.trim()) { setErr('Vui lòng nhập tên đăng nhập.'); return }
    if (!contactEmail.trim() || !contactEmail.includes('@')) { setErr('Vui lòng nhập email hợp lệ.'); return }
    setLoading(true)
    try { await requestReset(username.trim().toLowerCase(), contactEmail.trim()); setDone(true) }
    catch(e) { setErr(e.message) }
    finally { setLoading(false) }
  }

  if (done) return (
    <div style={{ textAlign:'center' }}>
      <div style={{ fontSize:56, marginBottom:12 }}>📨</div>
      <h3 style={{ fontSize:17, fontWeight:700, color:'#15803d', marginBottom:8 }}>Yêu cầu đã được gửi!</h3>
      <p style={{ fontSize:13, color:'#555', lineHeight:1.8, marginBottom:16 }}>
        Quản trị viên sẽ xem xét và liên hệ lại với bạn<br/>qua email hoặc điện thoại trong thời gian sớm nhất.
      </p>
      <div style={{ background:'#f0fdf4', borderRadius:10, padding:'12px', border:'0.5px solid #bbf7d0', fontSize:12, color:'#15803d', marginBottom:20 }}>
        📧 Hoặc liên hệ trực tiếp: <strong>hoangductudhbk@gmail.com</strong>
      </div>
      <button onClick={onBack} style={{ ...btnSt, background:'#0a2342' }}>← Quay lại đăng nhập</button>
    </div>
  )

  return (
    <div>
      <button onClick={onBack} style={{ background:'none', border:'none', cursor:'pointer', color:'#888', fontSize:13, marginBottom:16, padding:0, display:'flex', alignItems:'center', gap:4 }}>
        ← Quay lại
      </button>
      <div style={{ textAlign:'center', marginBottom:24 }}>
        <div style={{ fontSize:40, marginBottom:8 }}>🔐</div>
        <h3 style={{ fontSize:18, fontWeight:700, color:'#0a2342', marginBottom:6 }}>Quên mật khẩu</h3>
        <p style={{ fontSize:13, color:'#888', lineHeight:1.6 }}>
          Điền thông tin bên dưới, quản trị viên sẽ<br/>liên hệ và đặt lại mật khẩu cho bạn.
        </p>
      </div>

      <label style={lSt}>Tên đăng nhập <Req/></label>
      <input value={username} onChange={e=>setUsername(e.target.value.toLowerCase().replace(/\s/g,''))}
        placeholder="Nhập tên đăng nhập của bạn" autoComplete="off" style={iSt}/>

      <label style={lSt}>Email liên hệ <Req/></label>
      <input value={contactEmail} onChange={e=>setContactEmail(e.target.value)}
        placeholder="Email để admin liên hệ lại" type="email"
        style={{ ...iSt, marginBottom:err?8:20 }}/>

      {err && <ErrBox msg={err}/>}

      <button onClick={handleSubmit} disabled={loading} style={{ ...btnSt, background:loading?'#6b7280':'#0a2342' }}>
        {loading?'⏳ Đang gửi...':'📨 Gửi yêu cầu đặt lại mật khẩu'}
      </button>
    </div>
  )
}

const Req  = () => <span style={{ color:'#e53e3e' }}>*</span>
function ErrBox({ msg }) {
  return <div style={{ fontSize:12, color:'#dc2626', marginBottom:14, padding:'9px 12px', background:'#fef2f2', borderRadius:8, border:'0.5px solid #fecaca', display:'flex', alignItems:'center', gap:6 }}>⚠️ {msg}</div>
}
const iSt   = { width:'100%', padding:'11px 14px', border:'0.5px solid #ddd', borderRadius:10, fontSize:13, outline:'none', boxSizing:'border-box', marginBottom:14, fontFamily:'inherit' }
const lSt   = { fontSize:12, fontWeight:600, color:'#374151', display:'block', marginBottom:5 }
const btnSt = { width:'100%', padding:'13px', color:'#fff', border:'none', borderRadius:12, cursor:'pointer', fontSize:14, fontWeight:600 }
