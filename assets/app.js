import { APP_CONFIG } from './config.js';
import { db, isConfigured, saveStoredConfig, clearStoredConfig, getConfig } from './supabase-client.js';
import { parseFile, validateQuestions, parseAnswerKeyPdf, mergeAnswerKey } from './importers.js';

const app = document.getElementById('app');
const topbar = document.getElementById('topbar');
const footer = document.getElementById('footer');
const modalRoot = document.getElementById('modalRoot');
const toast = document.getElementById('toast');
const ACTIVE_KEY = 'banqo_active_session_v1';
const THEME_KEY = 'banqo_theme_v1';

const state = {
  user: null,
  profile: null,
  route: 'home',
  adminTab: 'questions',
  active: null,
  lastResult: null,
  importPreview: null,
  importValidation: null,
  currentImportFile: null,
  currentAnswerFile: null,
  answerKeyStats: null,
  importMeta: null,
  busy: false
};

const esc = (v='') => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt = d => d ? new Date(d).toLocaleString('es-PE',{dateStyle:'short',timeStyle:'short'}) : '—';
const pct = (a,b) => b ? Math.round((a/b)*100) : 0;
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const shuffle = arr => [...arr].sort(()=>Math.random()-.5);
const chunk = (arr,n) => Array.from({length:Math.ceil(arr.length/n)},(_,i)=>arr.slice(i*n,(i+1)*n));

function notify(message, ms=2600){
  toast.textContent = message; toast.classList.add('show');
  clearTimeout(notify.t); notify.t=setTimeout(()=>toast.classList.remove('show'),ms);
}
function setBusy(v){state.busy=v;document.body.style.cursor=v?'progress':'';}
function saveActive(){ if(state.active) localStorage.setItem(ACTIVE_KEY,JSON.stringify(state.active)); else localStorage.removeItem(ACTIVE_KEY); }
function loadActive(){ try{return JSON.parse(localStorage.getItem(ACTIVE_KEY)||'null')}catch{return null} }
function applyTheme(){document.documentElement.dataset.theme=localStorage.getItem(THEME_KEY)||'light';}
function initials(){
  const name=state.profile?.full_name || state.user?.email || 'BQ';
  const parts=name.trim().split(/\s+/); return ((parts[0]?.[0]||'B')+(parts[1]?.[0]||parts[0]?.[1]||'Q')).toUpperCase();
}
function setShell(show){topbar.classList.toggle('hide',!show);footer.classList.toggle('hide',!show)}
function updateChrome(){
  document.getElementById('avatarBtn').textContent=initials();
  document.getElementById('streakCount').textContent=state.profile?.streak||0;
  document.getElementById('adminNav').classList.toggle('hide',state.profile?.role!=='admin');
}

async function init(){
  applyTheme();
  const themeBtn=document.getElementById('themeBtn');if(themeBtn)themeBtn.onclick=()=>{localStorage.setItem(THEME_KEY,(document.documentElement.dataset.theme==='dark'?'light':'dark'));applyTheme()};
  const avatarBtn=document.getElementById('avatarBtn');if(avatarBtn)avatarBtn.onclick=()=>showAccountModal();
  if(!isConfigured()){setShell(false);renderSetup();return;}
  const supa=db();
  const {data:{session}}=await supa.auth.getSession();
  if(!session){setShell(false);renderAuth();}
  else await bootUser(session.user);
  supa.auth.onAuthStateChange(async (_event, session)=>{
    if(session?.user && session.user.id!==state.user?.id) await bootUser(session.user);
    if(!session?.user){state.user=null;state.profile=null;state.active=null;setShell(false);renderAuth();}
  });
  window.addEventListener('beforeunload',e=>{if(state.active && !state.active.finished){e.preventDefault();e.returnValue='';}});
  window.addEventListener('hashchange',async()=>{
    const r=location.hash.replace('#','')||'home';
    if(!['home','practice','simulations','stats','errors','admin','quiz','results'].includes(r)) return;
    if(r==='admin' && state.profile?.role!=='admin'){location.hash='home';return;}
    state.route=r; await renderRoute();
  });
}

async function bootUser(user){
  state.user=user;
  const supa=db();
  let {data:profile,error}=await supa.from('profiles').select('*').eq('id',user.id).maybeSingle();
  if(error) console.warn(error);
  if(!profile){
    const full=user.user_metadata?.full_name||'';
    const ins=await supa.from('profiles').upsert({id:user.id,full_name:full}).select().single();
    profile=ins.data;
  }
  state.profile=profile;
  if(profile?.role!=='admin'){
    const ok=await enforceDeviceLock();
    if(!ok)return;
  }
  state.active=loadActive();
  setShell(true);updateChrome();
  const hash=location.hash.replace('#','');
  state.route=['home','practice','simulations','stats','errors','admin','quiz','results'].includes(hash)?hash:'home';
  if(state.route==='admin' && profile?.role!=='admin') state.route='home';
  await renderRoute();
}


function getDeviceId(){
  let id=localStorage.getItem('banqo_device_id_v1');
  if(!id){id=(crypto.randomUUID?crypto.randomUUID():`dev-${Date.now()}-${Math.random().toString(36).slice(2)}`);localStorage.setItem('banqo_device_id_v1',id);}
  return id;
}
async function enforceDeviceLock(){
  const id=getDeviceId();
  const name=`${navigator.platform||'Dispositivo'} · ${navigator.userAgent.includes('Mobile')?'móvil':'navegador'}`;
  const {data,error}=await db().rpc('claim_device',{p_device_id:id,p_device_name:name});
  if(error){console.warn('Device lock no disponible:',error.message);return true;}
  if(data?.ok!==false){
    clearInterval(enforceDeviceLock.t);
    enforceDeviceLock.t=setInterval(()=>db().rpc('claim_device',{p_device_id:id,p_device_name:name}),5*60*1000);
    return true;
  }
  setShell(false);
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">SEGURIDAD DE CUENTA</div><h2>Cuenta activa en otro dispositivo</h2></div></div><p class="muted">BANQO está configurado para una sesión de dispositivo por cuenta. El otro dispositivo figura como <strong>${esc(data.device_name||'otro dispositivo')}</strong>.</p><p class="small muted">Última actividad: ${fmt(data.last_seen_at)}</p><button id="deviceLogout" class="btn btn-primary">Cerrar sesión</button></div></section>`;
  document.getElementById('deviceLogout').onclick=()=>db().auth.signOut();
  return false;
}

function renderSetup(){
  const c=getConfig();
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card">
    <div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">BANQO PERÚ</div><h2>Conectar Supabase</h2></div></div>
    <p class="muted">Esta versión funciona con GitHub Pages + Supabase. Primero crea un proyecto gratuito, ejecuta <span class="code">supabase/schema.sql</span> y pega aquí la URL y la anon key.</p>
    <div class="stack">
      <div class="field"><label>Project URL</label><input id="setupUrl" placeholder="https://xxxxx.supabase.co" value="${esc(c.url||'')}" /></div>
      <div class="field"><label>Anon / publishable key</label><textarea id="setupKey" class="textarea-md" placeholder="eyJ...">${esc(c.anonKey||'')}</textarea></div>
      <button id="saveSetup" class="btn btn-primary">Guardar y conectar</button>
    </div>
    <div class="notice" style="margin-top:18px"><strong>Importante:</strong> no coloques la <span class="code">service_role</span> key en el navegador. La app usa únicamente la anon/publishable key y las políticas RLS del esquema.</div>
  </div></section>`;
  document.getElementById('saveSetup').onclick=()=>{
    const url=document.getElementById('setupUrl').value.trim(),key=document.getElementById('setupKey').value.trim();
    if(!url||!key){notify('Completa URL y anon key');return;} saveStoredConfig(url,key);location.reload();
  };
}

function renderAuth(){
  app.innerHTML=`<section class="auth-shell"><div class="card auth-card">
    <div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">BANQO PERÚ</div><h2>Entrar</h2></div></div>
    <div class="auth-tabs"><button class="tab-btn active" data-auth="login">Iniciar sesión</button><button class="tab-btn" data-auth="register">Crear cuenta</button></div>
    <div id="authBody"></div>
    <div class="divider"></div><button id="changeConfig" class="btn btn-soft">Cambiar conexión Supabase</button>
  </div></section>`;
  const show=(mode)=>{
    document.querySelectorAll('[data-auth]').forEach(b=>b.classList.toggle('active',b.dataset.auth===mode));
    document.getElementById('authBody').innerHTML=mode==='login'?`
      <div class="stack"><div class="field"><label>Correo</label><input id="authEmail" type="email" /></div><div class="field"><label>Contraseña</label><input id="authPass" type="password" /></div><button id="authSubmit" class="btn btn-primary">Entrar</button></div>`:`
      <div class="stack"><div class="field"><label>Nombre y apellido</label><input id="authName" /></div><div class="field"><label>Correo</label><input id="authEmail" type="email" /></div><div class="field"><label>Contraseña</label><input id="authPass" type="password" placeholder="Mín. 5 caracteres, 1 mayúscula y 1 número" /></div><button id="authSubmit" class="btn btn-primary">Crear cuenta</button></div>`;
    document.getElementById('authSubmit').onclick=async()=>{
      const email=document.getElementById('authEmail').value.trim(),pass=document.getElementById('authPass').value;
      if(!email||!pass){notify('Completa correo y contraseña');return;}
      setBusy(true);
      try{
        if(mode==='login'){
          const {error}=await db().auth.signInWithPassword({email,password:pass}); if(error) throw error;
        }else{
          if(pass.length<5 || !/[A-Z]/.test(pass) || !/\d/.test(pass)){notify('La contraseña debe tener 5+ caracteres, 1 mayúscula y 1 número');return;}
          const full_name=document.getElementById('authName').value.trim();
          const {data,error}=await db().auth.signUp({email,password:pass,options:{data:{full_name}}}); if(error) throw error;
          if(!data.session) notify('Cuenta creada. Revisa tu correo para confirmar el registro.',5000);
        }
      }catch(e){notify(e.message||'No se pudo autenticar',5000)} finally{setBusy(false)}
    };
  };
  document.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>show(b.dataset.auth));show('login');
  document.getElementById('changeConfig').onclick=()=>{if(confirm('¿Cambiar la conexión guardada?')){clearStoredConfig();location.reload();}};
}

async function go(route, force=false){
  if(!force && state.active && !state.active.finished && state.route==='quiz' && route!=='quiz'){
    if(!confirm('Hay una sesión en curso. ¿Salir? El progreso queda guardado para continuar después.')) return;
  }
  state.route=route;
  const nextHash = `#${route}`;
  if(location.hash !== nextHash){
    location.hash=route; // hashchange hará el render una sola vez
  }else{
    await renderRoute();
  }
  window.scrollTo(0,0);
}

async function renderRoute(){
  if(!state.user) return;
  updateChrome();
  try{
    if(state.route==='home') await renderHome();
    else if(state.route==='practice') await renderPractice();
    else if(state.route==='simulations') await renderSimulations();
    else if(state.route==='stats') await renderStats();
    else if(state.route==='errors') await renderErrors();
    else if(state.route==='admin') await renderAdmin();
    else if(state.route==='quiz') renderQuiz();
    else if(state.route==='results') renderResults();
  }catch(e){console.error(e);app.innerHTML=`<section class="page"><div class="card"><h2>Ocurrió un error</h2><p class="danger-text">${esc(e.message||e)}</p><button class="btn" data-go="home">Volver</button></div></section>`;bindGo();}
}
function bindGo(){document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>go(b.dataset.go));}

async function renderHome(){
  const supa=db();
  const [q,se,a,sim]=await Promise.all([
    supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PUBLICADA'),
    supa.from('study_sessions').select('id',{count:'exact',head:true}).eq('user_id',state.user.id).eq('status','COMPLETADA'),
    supa.from('attempts').select('is_correct').eq('user_id',state.user.id).limit(5000),
    supa.from('simulation_sets').select('id',{count:'exact',head:true}).eq('status','PUBLICADO')
  ]);
  const attempts=a.data||[], correct=attempts.filter(x=>x.is_correct).length;
  const level=Math.max(1,Math.floor((state.profile?.xp||0)/250)+1);
  const xp=state.profile?.xp||0;
  const resume=state.active && !state.active.finished ? `<div class="card" style="margin-top:20px"><div class="space-between"><div><div class="kicker">SESIÓN GUARDADA</div><h3>${state.active.type==='SIMULATION'?'Simulacro':'Banqueo'} en curso</h3><p class="muted">Pregunta ${(state.active.index||0)+1} de ${state.active.questions.length}. Puedes continuar desde donde quedaste.</p></div><button id="resumeBtn" class="btn btn-primary">Continuar</button></div></div>`:'';
  app.innerHTML=`<section class="page">
    <div class="hero">
      <div>
        <div class="eyebrow">BANCO MÉDICO GAMIFICADO</div>
        <h1>Banquea. Aprende. Sube de nivel.</h1>
        <p class="lead">Practica preguntas de <strong>Residentado Médico, ENAM y EsSalud</strong> desde un solo lugar, con explicación inmediata, simulacros y progreso acumulado.</p>
        <div class="cta-row"><button class="btn btn-primary" data-go="practice">Empezar a banquear</button><button class="btn" data-go="simulations">Hacer simulacro</button></div>
        <div class="pill-row" style="margin-top:18px"><span class="tag">✓ Respuesta explicada</span><span class="tag">🎮 XP y mascota</span><span class="tag">📊 Estadísticas</span><span class="tag">☁️ Progreso sincronizado</span></div>
        ${resume}
      </div>
      <div class="pet-card">
        <div class="pet"><div class="pet-badge">${level}</div><div class="pet-mouth"></div></div>
        <h3>Baqi · nivel ${level}</h3><p class="muted small">Tu compañero de banqueo. Gana XP respondiendo.</p>
        <div class="progress"><span style="width:${(xp%250)/2.5}%"></span></div><p class="small muted">${xp} XP · faltan ${250-(xp%250)} XP para el siguiente nivel</p>
      </div>
    </div>

    <div class="grid grid-4">
      <div class="card stats-card"><span class="muted small">Respondidas</span><strong>${attempts.length}</strong><span class="small muted">sincronizado</span></div>
      <div class="card stats-card"><span class="muted small">Acierto</span><strong>${pct(correct,attempts.length)}%</strong><span class="small muted">${correct} correctas</span></div>
      <div class="card stats-card"><span class="muted small">Racha</span><strong>${state.profile?.streak||0}🔥</strong><span class="small muted">sesiones consecutivas</span></div>
      <div class="card stats-card"><span class="muted small">Preguntas</span><strong>${q.count||0}</strong><span class="small muted">publicadas</span></div>
    </div>

    <div class="section-head"><div><div class="kicker">ELIGE TU OBJETIVO</div><h2>¿Qué quieres repasar?</h2></div><span class="muted">Puedes mezclar bancos o estudiar uno solo.</span></div>
    <div class="grid grid-4">
      <div class="card card-click home-bank" data-home-exam="RESIDENTADO"><div class="bank-icon">🩺</div><h3>Residentado</h3><p class="muted">Preparación para Residentado Médico Perú</p><span class="tag">Banco Perú</span></div>
      <div class="card card-click home-bank" data-home-exam="ENAM"><div class="bank-icon">🇵🇪</div><h3>ENAM</h3><p class="muted">Preguntas y bancos históricos</p><span class="tag">ENAM</span></div>
      <div class="card card-click home-bank" data-home-exam="ESSALUD"><div class="bank-icon">🏥</div><h3>EsSalud</h3><p class="muted">Evaluaciones y simulacros</p><span class="tag">EsSalud</span></div>
      <div class="card card-click" data-home-go="simulations"><div class="bank-icon">🧪</div><h3>Simulacros</h3><p class="muted">Exámenes cargados desde Admin</p><span class="tag">${sim.count||0} publicados</span></div>
    </div>
  </section>`;
  bindGo();
  document.querySelectorAll('[data-home-go]').forEach(c=>c.onclick=()=>go(c.dataset.homeGo));
  document.querySelectorAll('[data-home-exam]').forEach(c=>c.onclick=()=>{
    sessionStorage.setItem('banqo_pref_exam',c.dataset.homeExam||'');
    go('practice');
  });
  const r=document.getElementById('resumeBtn');if(r)r.onclick=()=>{state.route='quiz';location.hash='quiz';renderQuiz();};
}
async function getPracticeMetadata(){
  const {data,error}=await db().from('questions').select('exam_type,bank_name,specialty,topic,subtopic').eq('status','PUBLICADA').limit(5000);
  if(error) throw error; return data||[];
}
function optionsFor(values,placeholder='Todos'){
  const arr=[...new Set(values.filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
  return `<option value="">${placeholder}</option>`+arr.map(v=>`<option value="${esc(v)}">${esc(v)}</option>`).join('');
}
async function renderPractice(){
  const md=await getPracticeMetadata();
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">BANQUEO</div><h2>Configura tu sesión</h2><p class="muted">Las preguntas se obtienen de Supabase y solo se muestran si están PUBLICADAS.</p></div></div>
    <div class="card"><div class="filters">
      <div class="field"><label>Examen</label><select id="pExam">${optionsFor(md.map(x=>x.exam_type),'Todos')}</select></div>
      <div class="field"><label>Banco</label><select id="pBank">${optionsFor(md.map(x=>x.bank_name),'Todos')}</select></div>
      <div class="field"><label>Especialidad</label><select id="pSpec">${optionsFor(md.map(x=>x.specialty),'Todas')}</select></div>
      <div class="field"><label>Tema</label><select id="pTopic">${optionsFor(md.map(x=>x.topic),'Todos')}</select></div>
      <div class="field"><label>Subtema</label><select id="pSubtopic">${optionsFor(md.map(x=>x.subtopic),'Todos')}</select></div>
      <div class="field"><label>Preguntas</label><select id="pCount"><option>5</option><option>10</option><option selected>15</option><option>20</option><option>30</option><option>50</option></select></div>
      <div class="field"><label>Corrección</label><select id="pMode"><option value="instant">Inmediata</option><option value="exam">Al final</option></select></div>
      <div class="field"><label>Orden</label><select id="pOrder"><option value="random">Aleatorio</option><option value="sequential">Secuencial</option></select></div>
    </div><div class="cta-row"><button id="startPractice" class="btn btn-primary">Comenzar banqueo</button><span class="tag">Plan ${esc(state.profile?.plan||'free')}</span>${state.profile?.role==='admin'?'<span class="tag">Admin ilimitado</span>':'<span class="tag">Free: 15 preguntas/día</span>'}</div></div>
    <div class="section-head"><div><h2>Funciones de estudio</h2></div></div><div class="grid grid-3"><div class="card"><h3>⭐ Marcar y favoritas</h3><p class="muted">Marca preguntas para revisar y guárdalas en tu colección.</p></div><div class="card"><h3>✂️ Descartar opciones</h3><p class="muted">Entrena el descarte sin perder la alternativa original.</p></div><div class="card"><h3>📝 Notas</h3><p class="muted">Guarda notas privadas por pregunta en Supabase.</p></div></div>
  </section>`;
  const prefExam=sessionStorage.getItem('banqo_pref_exam');
  if(prefExam){const sel=document.getElementById('pExam');if(sel && [...sel.options].some(o=>o.value===prefExam))sel.value=prefExam;sessionStorage.removeItem('banqo_pref_exam');}
  const startPracticeBtn=document.getElementById('startPractice');if(startPracticeBtn)startPracticeBtn.onclick=startPractice;
}

async function freeRemaining(){
  const {data,error}=await db().rpc('free_questions_remaining');
  if(!error && Number(data)===-1) return Infinity;
  if(!error && Number.isFinite(Number(data))) return Number(data);
  if(state.profile?.role==='admin' || ['pro','admin'].includes(state.profile?.plan)) return Infinity;
  return APP_CONFIG.freeDailyQuestions;
}

async function startPractice(){
  setBusy(true);
  try{
    let count=Number(document.getElementById('pCount').value)||15;
    const remaining=await freeRemaining();
    if(remaining<=0){notify('Ya alcanzaste las 15 preguntas gratuitas de hoy.',4500);return;}
    if(Number.isFinite(remaining) && count>remaining){count=remaining;notify(`Hoy te quedan ${remaining} preguntas gratuitas.`);}
    let q=db().from('questions').select('*').eq('status','PUBLICADA');
    const pairs=[['exam_type','pExam'],['bank_name','pBank'],['specialty','pSpec'],['topic','pTopic'],['subtopic','pSubtopic']];
    for(const [field,id] of pairs){const v=document.getElementById(id).value;if(v)q=q.eq(field,v)}
    const {data,error}=await q.limit(800);if(error)throw error;
    let questions=data||[];if(document.getElementById('pOrder').value==='random')questions=shuffle(questions);else questions.sort((a,b)=>(a.external_id||'').localeCompare(b.external_id||''));
    questions=questions.slice(0,count);if(!questions.length){notify('No hay preguntas publicadas con esos filtros');return;}
    const mode=document.getElementById('pMode').value;
    const filters={exam:document.getElementById('pExam').value,bank:document.getElementById('pBank').value,specialty:document.getElementById('pSpec').value,topic:document.getElementById('pTopic').value,subtopic:document.getElementById('pSubtopic').value};
    const {data:session,error:se}=await db().from('study_sessions').insert({user_id:state.user.id,session_type:'PRACTICE',filters,question_ids:questions.map(x=>x.id)}).select().single();if(se)throw se;
    state.active={sessionId:session.id,type:'PRACTICE',mode,questions,answers:{},revealed:{},marked:{},discarded:{},index:0,startedAt:Date.now(),finished:false};saveActive();
    await go('quiz',true);
  }catch(e){notify(e.message||'No se pudo iniciar',5000)}finally{setBusy(false)}
}

async function renderSimulations(){
  const {data,error}=await db().from('simulation_sets').select('*').eq('status','PUBLICADO').order('year',{ascending:false}).order('name');if(error)throw error;
  const sims=data||[];
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">SIMULACROS</div><h2>Exámenes completos</h2><p class="muted">Simulacros cargados y publicados desde el panel administrador.</p></div></div>
    ${sims.length?`<div class="grid grid-3">${sims.map(s=>`<div class="card card-click sim-card" data-sim="${s.id}"><div class="bank-icon">🧾</div><div class="pill-row"><span class="tag">${esc(s.exam_type)}</span>${s.year?`<span class="tag">${s.year}</span>`:''}</div><h3 style="margin-top:12px">${esc(s.name)}</h3><p class="muted">${s.question_count||0} preguntas${s.duration_minutes?` · ${s.duration_minutes} min`:''}</p></div>`).join('')}</div>`:'<div class="card empty">Aún no hay simulacros publicados.</div>'}
  </section>`;
  document.querySelectorAll('.sim-card').forEach(c=>c.onclick=()=>startSimulation(c.dataset.sim));
}

async function startSimulation(id){
  setBusy(true);
  try{
    const [{data:sim,error:e1},{data:rows,error:e2}]=await Promise.all([
      db().from('simulation_sets').select('*').eq('id',id).single(),
      db().from('simulation_questions').select('order_no,is_reserve,questions(*)').eq('simulation_id',id).eq('is_reserve',false).order('order_no')
    ]);if(e1)throw e1;if(e2)throw e2;
    const questions=(rows||[]).map(r=>r.questions).filter(Boolean);if(!questions.length){notify('Este simulacro no tiene preguntas');return;}
    if(!confirm(`¿Iniciar ${sim.name}?\n\n${questions.length} preguntas${sim.duration_minutes?` · ${sim.duration_minutes} minutos`:''}. El cronómetro comenzará al aceptar.`)) return;
    const remaining=await freeRemaining();
    if(Number.isFinite(remaining) && remaining<questions.length){notify(`Tu plan gratuito tiene ${remaining} preguntas disponibles hoy. Usa un banqueo corto o una cuenta admin/pro.`,5500);return;}
    const {data:session,error}=await db().from('study_sessions').insert({user_id:state.user.id,session_type:'SIMULATION',simulation_id:id,filters:{name:sim.name},question_ids:questions.map(x=>x.id)}).select().single();if(error)throw error;
    state.active={sessionId:session.id,type:'SIMULATION',simulation:sim,mode:'exam',questions,answers:{},revealed:{},marked:{},discarded:{},index:0,startedAt:Date.now(),durationMinutes:sim.duration_minutes||null,finished:false};saveActive();await go('quiz',true);
  }catch(e){notify(e.message||'No se pudo iniciar el simulacro',5000)}finally{setBusy(false)}
}

function currentQuestion(){return state.active?.questions?.[state.active.index||0]}
function elapsed(){return state.active?Math.floor((Date.now()-state.active.startedAt)/1000):0}
function timeText(sec){const m=Math.floor(sec/60),s=sec%60;return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`}
function resolveImage(url){return url||''}

function renderQuiz(){
  const s=state.active;if(!s||s.finished){go('home',true);return;}
  const q=currentQuestion();if(!q){go('home',true);return;}
  const selected=s.answers[q.id]||null,revealed=Boolean(s.revealed[q.id]);
  const discarded=new Set(s.discarded[q.id]||[]);
  const options=Object.entries(q.options||{}).map(([k,v])=>{
    const classes=['option'];if(selected===k)classes.push('selected');if(discarded.has(k))classes.push('discarded');if(revealed&&k===q.correct_answer)classes.push('correct');else if(revealed&&selected===k&&selected!==q.correct_answer)classes.push('wrong');
    return `<div class="${classes.join(' ')}" data-answer="${k}"><span class="option-letter">${k}</span><span>${esc(v)}</span><button class="discard-btn" data-discard="${k}" title="Descartar/recuperar opción">×</button></div>`;
  }).join('');
  const answered=Object.keys(s.answers).length;
  app.innerHTML=`<section class="page"><div class="quiz-shell"><div class="card quiz-card">
    <div class="quiz-meta"><div class="pill-row"><span class="tag">${esc(q.exam_type)}</span><span class="tag">${esc(q.bank_name)}</span><span class="tag">${esc(q.specialty)}</span></div><span class="tag">${s.index+1}/${s.questions.length}</span></div>
    <div class="source-chip">${esc(q.source_reference||q.external_id)}</div><p class="question">${esc(q.stem)}</p>${q.image_url?`<img class="question-image" src="${esc(resolveImage(q.image_url))}" alt="Imagen de la pregunta" />`:''}
    <div class="options">${options}</div>
    <div class="quiz-tools"><button id="markBtn" class="btn btn-soft mark-btn ${s.marked[q.id]?'active':''}">⭐ ${s.marked[q.id]?'Marcada':'Marcar'}</button><button id="favBtn" class="btn btn-soft">♡ Favorita</button><button id="reportBtn" class="btn btn-soft">⚑ Reportar</button></div>
    ${revealed?`<div class="explanation"><strong>Respuesta: ${esc(q.correct_answer||'—')}</strong><div class="divider"></div>${q.explanation?esc(q.explanation):'<span class="muted">Esta pregunta todavía no tiene explicación.</span>'}${q.galactic_tip?`<div class="notice" style="margin-top:12px"><strong>Dato galáctico:</strong> ${esc(q.galactic_tip)}</div>`:''}</div>`:''}
    <div class="quiz-actions"><button id="prevQ" class="btn" ${s.index===0?'disabled':''}>← Anterior</button><div class="inline">${s.index===s.questions.length-1?'<button id="finishQ" class="btn btn-primary">Finalizar</button>':'<button id="nextQ" class="btn btn-primary">Siguiente →</button>'}</div></div>
  </div><aside class="card quiz-side"><div class="space-between"><div><div class="kicker">PROGRESO</div><h3>${answered}/${s.questions.length}</h3></div><div id="timer" class="tag">${timeText(elapsed())}</div></div><div class="progress-line" style="margin:14px 0"><span style="width:${pct(answered,s.questions.length)}%"></span></div><div class="side-list">${s.questions.map((x,i)=>`<button class="qdot ${i===s.index?'current':''} ${s.answers[x.id]?'done':''} ${s.marked[x.id]?'warn':''}" data-qindex="${i}">${i+1}</button>`).join('')}</div><div class="divider"></div><div class="field"><label>Nota personal</label><textarea id="questionNote" class="textarea-md" placeholder="Escribe una nota privada..."></textarea><button id="saveNote" class="btn btn-soft" style="margin-top:8px">Guardar nota</button></div><div class="divider"></div><button id="leaveQuiz" class="btn btn-danger" style="width:100%">Salir de la sesión</button></aside></div></section>`;
  document.querySelectorAll('[data-answer]').forEach(o=>o.onclick=e=>{if(e.target.closest('[data-discard]'))return;answerQuestion(o.dataset.answer)});
  document.querySelectorAll('[data-discard]').forEach(b=>b.onclick=e=>{e.stopPropagation();toggleDiscard(b.dataset.discard)});
  document.querySelectorAll('[data-qindex]').forEach(b=>b.onclick=()=>{s.index=Number(b.dataset.qindex);saveActive();renderQuiz()});
  document.getElementById('prevQ').onclick=()=>{if(s.index>0){s.index--;saveActive();renderQuiz()}};
  const n=document.getElementById('nextQ');if(n)n.onclick=()=>{if(s.index<s.questions.length-1){s.index++;saveActive();renderQuiz()}};
  const f=document.getElementById('finishQ');if(f)f.onclick=finishStudy;
  document.getElementById('markBtn').onclick=()=>{s.marked[q.id]=!s.marked[q.id];saveActive();renderQuiz()};
  document.getElementById('favBtn').onclick=()=>toggleFavorite(q.id);
  document.getElementById('reportBtn').onclick=()=>showReportModal(q);
  document.getElementById('saveNote').onclick=()=>saveNote(q.id,document.getElementById('questionNote').value);
  document.getElementById('leaveQuiz').onclick=()=>go('home');
  loadNote(q.id);
  clearInterval(renderQuiz.timer);renderQuiz.timer=setInterval(()=>{const t=document.getElementById('timer');if(t)t.textContent=timeText(elapsed());if(s.durationMinutes && elapsed()>=s.durationMinutes*60){clearInterval(renderQuiz.timer);finishStudy();}},1000);
}

function toggleDiscard(letter){
  const s=state.active,q=currentQuestion();const arr=new Set(s.discarded[q.id]||[]);arr.has(letter)?arr.delete(letter):arr.add(letter);s.discarded[q.id]=[...arr];saveActive();renderQuiz();
}
async function answerQuestion(letter){
  const s=state.active,q=currentQuestion();if(s.revealed[q.id])return;s.answers[q.id]=letter;if(s.mode==='instant')s.revealed[q.id]=true;saveActive();
  const is_correct=letter===q.correct_answer;
  const {error}=await db().from('attempts').upsert({session_id:s.sessionId,user_id:state.user.id,question_id:q.id,selected_answer:letter,is_correct,marked:Boolean(s.marked[q.id]),discarded_options:s.discarded[q.id]||[],response_ms:Math.max(0,Date.now()-s.startedAt)},{onConflict:'session_id,question_id'});
  if(error)console.warn(error);renderQuiz();
}
async function toggleFavorite(questionId){
  const supa=db();const {data}=await supa.from('favorites').select('question_id').eq('user_id',state.user.id).eq('question_id',questionId).maybeSingle();
  if(data){await supa.from('favorites').delete().eq('user_id',state.user.id).eq('question_id',questionId);notify('Quitada de favoritas');}
  else{const {error}=await supa.from('favorites').insert({user_id:state.user.id,question_id:questionId});if(error)notify(error.message);else notify('Guardada en favoritas');}
}
async function loadNote(questionId){
  const {data}=await db().from('user_notes').select('note').eq('user_id',state.user.id).eq('question_id',questionId).maybeSingle();const t=document.getElementById('questionNote');if(t&&data)t.value=data.note||'';
}
async function saveNote(questionId,note){const {error}=await db().from('user_notes').upsert({user_id:state.user.id,question_id:questionId,note},{onConflict:'user_id,question_id'});notify(error?error.message:'Nota guardada');}

async function finishStudy(){
  const s=state.active;if(!s||s.finished)return;
  if(!confirm('¿Finalizar la sesión y ver resultados?'))return;
  clearInterval(renderQuiz.timer);
  const correct=s.questions.filter(q=>s.answers[q.id]===q.correct_answer).length;
  const blank=s.questions.filter(q=>!s.answers[q.id]).length;
  const incorrect=s.questions.length-correct-blank;
  s.finished=true;s.correct=correct;s.blank=blank;s.incorrect=incorrect;s.elapsedSeconds=elapsed();s.revealed=Object.fromEntries(s.questions.map(q=>[q.id,true]));saveActive();
  await db().from('study_sessions').update({status:'COMPLETADA',correct_count:correct,incorrect_count:incorrect,blank_count:blank,score:pct(correct,s.questions.length),elapsed_seconds:s.elapsedSeconds,finished_at:new Date().toISOString()}).eq('id',s.sessionId);
  const award=await db().rpc('award_session_progress',{p_session_id:s.sessionId});
  if(award.error) console.warn('No se pudo asignar XP:',award.error.message);
  else if(award.data){state.profile={...state.profile,xp:award.data.xp??state.profile?.xp,streak:award.data.streak??state.profile?.streak};updateChrome();}
  state.lastResult=s;state.route='results';location.hash='results';renderResults();
}
function renderResults(){
  const s=state.lastResult||state.active;if(!s||!s.finished){go('home',true);return;}
  const score=pct(s.correct,s.questions.length);
  app.innerHTML=`<section class="page"><div class="card" style="text-align:center"><div class="kicker">SESIÓN TERMINADA</div><h2>${s.type==='SIMULATION'?'Simulacro completado':'Banqueo completado'}</h2><div class="result-ring" style="--score:${score*3.6}deg"><span>${score}%</span></div><p class="muted">${s.correct} correctas · ${s.incorrect} incorrectas · ${s.blank} en blanco · ${timeText(s.elapsedSeconds||0)}</p><div class="cta-row" style="justify-content:center"><button id="newSession" class="btn btn-primary">Nuevo banqueo</button><button class="btn" data-go="stats">Ver progreso</button></div></div>
  <div class="section-head"><div><h2>Revisión</h2><p class="muted">Tu respuesta, clave oficial y explicación.</p></div></div><div class="grid">${s.questions.map((q,i)=>{const a=s.answers[q.id],ok=a===q.correct_answer;return `<div class="card review-card ${ok?'correct':'wrong'}"><div class="space-between"><strong>${i+1}. ${esc(q.external_id)}</strong><span class="tag">Tu respuesta: ${a||'—'} · Clave: ${q.correct_answer||'—'}</span></div><p>${esc(q.stem)}</p>${q.image_url?`<img class="question-image" src="${esc(resolveImage(q.image_url))}" />`:''}<div class="notice"><strong>${ok?'✅ Correcta':'❌ Revisa'}</strong>${q.explanation?`<div style="margin-top:8px">${esc(q.explanation)}</div>`:'<div class="muted" style="margin-top:8px">Sin explicación cargada todavía.</div>'}</div></div>`}).join('')}</div></section>`;
  bindGo();document.getElementById('newSession').onclick=()=>{state.active=null;state.lastResult=null;saveActive();go('practice',true)};
}

async function renderErrors(){
  const supa=db();
  const {data,error}=await supa.from('attempts').select('question_id,answered_at,questions(*)').eq('user_id',state.user.id).eq('is_correct',false).order('answered_at',{ascending:false}).limit(600);
  if(error) throw error;
  const unique=[];const seen=new Set();
  for(const row of data||[]){const q=row.questions;if(q?.id && !seen.has(q.id)){seen.add(q.id);unique.push(q);}}
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">REPASO INTELIGENTE</div><h2>Mis errores</h2><p class="muted">Preguntas que respondiste mal al menos una vez. Se actualiza con tus intentos sincronizados.</p></div></div>
  <div class="grid grid-3"><div class="card stats-card"><span class="muted small">Errores únicos</span><strong>${unique.length}</strong></div><div class="card stats-card"><span class="muted small">Modo</span><strong>Rebanqueo</strong></div><div class="card stats-card"><span class="muted small">Objetivo</span><strong>Corregir patrón</strong></div></div>
  <div class="card" style="margin-top:18px"><div class="space-between"><div><h3>Crear sesión desde tus errores</h3><p class="muted">BANQO toma primero los errores más recientes y evita repetir la misma pregunta dentro de la sesión.</p></div><div class="inline"><select id="errorCount"><option>5</option><option>10</option><option selected>15</option><option>20</option><option>30</option></select><button id="startErrors" class="btn btn-primary" ${unique.length?'':'disabled'}>Rebanquear errores</button></div></div></div>
  ${unique.length?`<div class="section-head"><div><h2>Últimos errores</h2></div></div><div class="grid">${unique.slice(0,20).map(q=>`<div class="card"><div class="pill-row"><span class="tag">${esc(q.exam_type)}</span><span class="tag">${esc(q.specialty)}</span></div><p style="margin-bottom:0"><strong>${esc(q.external_id)}</strong> · ${esc(q.stem).slice(0,260)}${q.stem.length>260?'…':''}</p></div>`).join('')}</div>`:'<div class="card empty" style="margin-top:18px">Todavía no tienes errores registrados. Empieza un banqueo para construir este repaso.</div>'}</section>`;
  const btn=document.getElementById('startErrors');if(btn)btn.onclick=()=>startErrorPractice(unique);
}

async function startErrorPractice(unique){
  setBusy(true);
  try{
    let count=Math.min(Number(document.getElementById('errorCount')?.value)||15,unique.length);
    const remaining=await freeRemaining();
    if(remaining<=0){notify('Ya alcanzaste las 15 preguntas gratuitas de hoy.',4500);return;}
    if(Number.isFinite(remaining) && count>remaining){count=remaining;notify(`Hoy te quedan ${remaining} preguntas gratuitas.`);}
    const questions=unique.slice(0,count);if(!questions.length){notify('No hay errores disponibles');return;}
    const {data:session,error}=await db().from('study_sessions').insert({user_id:state.user.id,session_type:'PRACTICE',filters:{mode:'MIS_ERRORES'},question_ids:questions.map(x=>x.id)}).select().single();if(error)throw error;
    state.active={sessionId:session.id,type:'PRACTICE',mode:'instant',questions,answers:{},revealed:{},marked:{},discarded:{},index:0,startedAt:Date.now(),finished:false};saveActive();await go('quiz',true);
  }catch(e){notify(e.message||'No se pudo crear el repaso',5000)}finally{setBusy(false)}
}

async function renderStats(){
  const supa=db();
  const [sessions,all,correct,favs]=await Promise.all([
    supa.from('study_sessions').select('*').eq('user_id',state.user.id).eq('status','COMPLETADA').order('started_at',{ascending:false}).limit(30),
    supa.from('attempts').select('id',{count:'exact',head:true}).eq('user_id',state.user.id),
    supa.from('attempts').select('id',{count:'exact',head:true}).eq('user_id',state.user.id).eq('is_correct',true),
    supa.from('favorites').select('question_id',{count:'exact',head:true}).eq('user_id',state.user.id)
  ]);
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">PROGRESO</div><h2>Tu rendimiento</h2><p class="muted">Sincronizado con tu cuenta de Supabase.</p></div></div>
  <div class="grid grid-4"><div class="card stats-card"><span class="muted small">Respondidas</span><strong>${all.count||0}</strong></div><div class="card stats-card"><span class="muted small">Correctas</span><strong>${correct.count||0}</strong></div><div class="card stats-card"><span class="muted small">Precisión</span><strong>${pct(correct.count||0,all.count||0)}%</strong></div><div class="card stats-card"><span class="muted small">Favoritas</span><strong>${favs.count||0}</strong></div></div>
  <div class="section-head"><div><h2>Sesiones recientes</h2></div></div>${sessions.data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Preguntas</th><th>Correctas</th><th>Incorrectas</th><th>Blanco</th><th>%</th></tr></thead><tbody>${sessions.data.map(x=>`<tr><td>${fmt(x.started_at)}</td><td>${esc(x.session_type)}</td><td>${(x.question_ids||[]).length}</td><td>${x.correct_count}</td><td>${x.incorrect_count}</td><td>${x.blank_count}</td><td>${x.score??0}%</td></tr>`).join('')}</tbody></table></div>`:'<div class="card empty">Aún no tienes sesiones completadas.</div>'}</section>`;
}

async function renderAdmin(){
  if(state.profile?.role!=='admin'){await go('home',true);return;}
  app.innerHTML=`<section class="page"><div class="section-head"><div><div class="kicker">ADMIN BANQO</div><h2>Centro de contenido</h2><p class="muted">Importa, revisa, publica y administra bancos y simulacros para Perú.</p></div><span class="badge-admin">ADMIN</span></div>
    <div class="admin-tabs"><button class="tab-btn ${state.adminTab==='questions'?'active':''}" data-admin-tab="questions">Preguntas</button><button class="tab-btn ${state.adminTab==='import'?'active':''}" data-admin-tab="import">Importar</button><button class="tab-btn ${state.adminTab==='simulations'?'active':''}" data-admin-tab="simulations">Simulacros</button><button class="tab-btn ${state.adminTab==='reports'?'active':''}" data-admin-tab="reports">Reportes</button><button class="tab-btn ${state.adminTab==='batches'?'active':''}" data-admin-tab="batches">Lotes</button></div><div id="adminContent"></div></section>`;
  document.querySelectorAll('[data-admin-tab]').forEach(b=>b.onclick=async()=>{state.adminTab=b.dataset.adminTab;await renderAdmin()});
  await loadAdminTab();
}
async function loadAdminTab(){
  if(!document.getElementById('adminContent')) return;
  if(state.adminTab==='questions')await renderAdminQuestions();
  else if(state.adminTab==='import')renderAdminImport();
  else if(state.adminTab==='simulations')await renderAdminSimulations();
  else if(state.adminTab==='reports')await renderAdminReports();
  else await renderAdminBatches();
}

async function renderAdminQuestions(){
  const el=document.getElementById('adminContent');if(!el)return;el.innerHTML='<div class="card">Cargando...</div>';
  const supa=db();
  const [total,pending,published,reports]=await Promise.all([
    supa.from('questions').select('id',{count:'exact',head:true}),supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PENDIENTE'),supa.from('questions').select('id',{count:'exact',head:true}).eq('status','PUBLICADA'),supa.from('question_reports').select('id',{count:'exact',head:true}).eq('status','PENDIENTE')
  ]);
  el.innerHTML=`<div class="grid grid-4"><div class="card stats-card"><span class="muted small">Total</span><strong>${total.count||0}</strong></div><div class="card stats-card"><span class="muted small">Pendientes</span><strong>${pending.count||0}</strong></div><div class="card stats-card"><span class="muted small">Publicadas</span><strong>${published.count||0}</strong></div><div class="card stats-card"><span class="muted small">Reportes</span><strong>${reports.count||0}</strong></div></div>
  <div class="section-head"><div><h2>Preguntas</h2></div></div><div class="card"><div class="admin-toolbar"><div class="field"><label>Buscar</label><input id="aqSearch" placeholder="ID o texto" /></div><div class="field"><label>Estado</label><select id="aqStatus"><option value="">Todos</option><option>PENDIENTE</option><option>APROBADA</option><option>PUBLICADA</option><option>ARCHIVADA</option></select></div><button id="aqLoad" class="btn btn-primary">Buscar</button></div><div id="aqTable" style="margin-top:14px"></div></div>
  <div class="card danger-zone"><div><h3>Zona de peligro</h3><p class="muted small">Elimina todas las preguntas cargadas. Los usuarios y el historial de importaciones se conservan; los simulacros quedan vacíos y vuelven a BORRADOR.</p></div><button id="deleteAllQuestions" class="btn btn-danger" ${total.count?'':'disabled'}>Eliminar todas las preguntas</button></div>`;
  const aqLoad=document.getElementById('aqLoad');if(aqLoad)aqLoad.onclick=loadAdminQuestionsTable;
  const delAll=document.getElementById('deleteAllQuestions');if(delAll)delAll.onclick=deleteAllQuestions;
  await loadAdminQuestionsTable();
}
async function loadAdminQuestionsTable(){
  const box=document.getElementById('aqTable');if(!box)return;box.innerHTML='Cargando...';
  let q=db().from('questions').select('id,external_id,exam_type,bank_name,specialty,topic,stem,correct_answer,status,requires_image,image_url,version,updated_at').order('updated_at',{ascending:false}).limit(120);
  const status=document.getElementById('aqStatus')?.value;if(status)q=q.eq('status',status);
  const term=document.getElementById('aqSearch')?.value.trim();if(term){const safe=term.replace(/[,()]/g,' ');q=q.or(`external_id.ilike.%${safe}%,stem.ilike.%${safe}%`)}
  const {data,error}=await q;if(error){box.innerHTML=`<div class="danger-text">${esc(error.message)}</div>`;return;}
  box.innerHTML=(data||[]).length?`<div class="table-wrap"><table class="table"><thead><tr><th>ID</th><th>Examen/Banco</th><th>Pregunta</th><th>Clave</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(x=>`<tr><td><span class="code">${esc(x.external_id)}</span><br><span class="muted small">v${x.version||1}</span></td><td>${esc(x.exam_type)}<br><span class="muted small">${esc(x.bank_name)}</span></td><td class="admin-question-stem">${esc(x.stem).slice(0,260)}${x.stem.length>260?'…':''}${x.requires_image&&!x.image_url?'<br><span class="warning-text small">⚠ imagen pendiente</span>':''}</td><td><strong>${esc(x.correct_answer||'—')}</strong></td><td class="status ${x.status==='PUBLICADA'?'ok':x.status==='PENDIENTE'?'warn':''}">${esc(x.status)}</td><td><button class="btn btn-soft" data-edit-q="${x.id}">Editar</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Sin resultados.</div>';
  document.querySelectorAll('[data-edit-q]').forEach(b=>b.onclick=()=>openQuestionEditor(b.dataset.editQ));
}

async function deleteAllQuestions(){
  const supa=db();
  const {count,error}=await supa.from('questions').select('id',{count:'exact',head:true});
  if(error){notify(error.message,5000);return;}
  if(!count){notify('No hay preguntas para eliminar');return;}
  if(!confirm(`Vas a eliminar ${count} preguntas de BANQO. Esta acción no se puede deshacer. ¿Continuar?`))return;
  const typed=prompt('Para confirmar, escribe exactamente: ELIMINAR TODO');
  if(typed!=='ELIMINAR TODO'){notify('Eliminación cancelada');return;}
  setBusy(true);
  try{
    // import_items tiene una referencia opcional a questions; la soltamos antes de borrar.
    const unlink=await supa.from('import_items').update({linked_question_id:null}).not('linked_question_id','is',null);
    if(unlink.error) throw unlink.error;
    let removed=0;
    while(true){
      const {data:ids,error:readErr}=await supa.from('questions').select('id').limit(500);
      if(readErr)throw readErr;
      if(!ids?.length)break;
      const {error:delErr}=await supa.from('questions').delete().in('id',ids.map(x=>x.id));
      if(delErr)throw delErr;
      removed+=ids.length;
    }
    // Al borrar questions, simulation_questions se limpia por cascade. Dejamos la definición del simulacro en borrador y con 0 preguntas.
    const reset=await supa.from('simulation_sets').update({question_count:0,status:'BORRADOR'}).not('id','is',null);
    if(reset.error)console.warn('No se pudieron resetear todos los simulacros:',reset.error.message);
    state.active=null;saveActive();
    notify(`Se eliminaron ${removed} preguntas.`,5000);
    await renderAdminQuestions();
  }catch(e){console.error(e);notify(e.message||'No se pudieron eliminar las preguntas',6000)}finally{setBusy(false)}
}

function renderAdminImport(){
  const el=document.getElementById('adminContent');if(!el)return;
  el.innerHTML=`<div class="grid"><div class="card"><div class="section-head" style="margin-top:0"><div><h2>Importar preguntas o simulacros</h2><p class="muted">Importador mejorado: reconoce PDFs a 1 o 2 columnas, respuestas resaltadas en verde y PDFs escaneados mediante OCR de respaldo.</p></div></div>
  <div class="form-grid-3"><div class="field"><label>Tipo</label><select id="iBankType"><option value="BANCO">Banco de preguntas</option><option value="SIMULACRO">Simulacro</option></select></div><div class="field"><label>Examen</label><select id="iExam">${APP_CONFIG.exams.map(x=>`<option value="${x.value}">${x.label}</option>`).join('')}</select></div><div class="field"><label>Año</label><input id="iYear" type="number" placeholder="2026" /></div><div class="field"><label>Nombre</label><input id="iName" placeholder="Ej. Banco Histórico - Bioética 1" /></div><div class="field"><label>Prefijo ID</label><input id="iPrefix" placeholder="Ej. BIO1 o SIM1" /></div><div class="field"><label>Duración (min, solo simulacro)</label><input id="iDuration" type="number" placeholder="Opcional" /></div><div class="field"><label>Especialidad por defecto</label><input id="iSpec" placeholder="Sin clasificar" /></div><div class="field"><label>Tema por defecto</label><input id="iTopic" placeholder="Sin clasificar" /></div><div class="field"><label>Subtema por defecto</label><input id="iSubtopic" placeholder="Sin clasificar" /></div></div>
  <div class="dropzone" style="margin-top:16px"><div class="form-grid"><div class="field"><label>Archivo principal</label><input id="importFile" type="file" accept=".xlsx,.xls,.csv,.json,.pdf" /><span class="muted small">Preguntas, banco o solucionario con preguntas completas.</span></div><div class="field"><label>PDF de claves / solucionario (opcional)</label><input id="answerKeyFile" type="file" accept=".pdf" /><span class="muted small">Úsalo cuando las preguntas y las claves vienen en archivos separados.</span></div></div><p class="muted small">BANQO cruza las claves por número de pregunta. Todo queda en PENDIENTE para revisión.</p><button id="parseImport" class="btn btn-primary">Analizar archivo</button></div>
  <div class="divider"></div><div class="inline"><strong>Ejemplos que me pasaste:</strong><button class="btn btn-soft" data-sample="bio">Cargar ejemplo Bioética 1</button><button class="btn btn-soft" data-sample="sim">Cargar ejemplo Simulacro 1</button></div></div><div id="importPreview"></div></div>`;
  const parseImport=document.getElementById('parseImport');if(parseImport)parseImport.onclick=analyseImportFile;
  document.querySelectorAll('[data-sample]').forEach(b=>b.onclick=()=>loadSampleImport(b.dataset.sample));
  if(state.importPreview)renderImportPreview();
}
function currentImportMeta(){return {bankType:document.getElementById('iBankType')?.value||'BANCO',examType:document.getElementById('iExam')?.value||'RESIDENTADO',year:document.getElementById('iYear')?.value||null,bankName:document.getElementById('iName')?.value.trim()||'BANQO',prefix:document.getElementById('iPrefix')?.value.trim()||'BANQO',duration:Number(document.getElementById('iDuration')?.value)||null,specialty:document.getElementById('iSpec')?.value.trim()||'Sin clasificar',topic:document.getElementById('iTopic')?.value.trim()||'Sin clasificar',subtopic:document.getElementById('iSubtopic')?.value.trim()||'Sin clasificar'};}
async function analyseImportFile(){
  const file=document.getElementById('importFile')?.files?.[0];if(!file){notify('Selecciona un archivo principal');return;}
  const keyFile=document.getElementById('answerKeyFile')?.files?.[0]||null;
  const meta=currentImportMeta();if(!meta.bankName||!meta.prefix){notify('Indica nombre y prefijo');return;}
  state.currentImportFile=file;state.currentAnswerFile=keyFile;state.answerKeyStats=null;state.importMeta=meta;const box=document.getElementById('importPreview');box.innerHTML='<div class="card">Analizando...</div>';setBusy(true);
  const progress=p=>{box.innerHTML=`<div class="card"><strong>${esc(p.stage||'Analizando')}</strong>${p.page?`<p class="muted">Página ${p.page} de ${p.total}</p><div class="progress-line"><span style="width:${pct(p.page,p.total)}%"></span></div>`:''}</div>`};
  try{
    let questions=await parseFile(file,meta,progress);
    if(keyFile){
      const keyMap=await parseAnswerKeyPdf(keyFile,meta,progress);
      const merged=await mergeAnswerKey(questions,keyMap,keyFile.name);questions=merged.questions;
      state.answerKeyStats={matched:merged.matched,totalKeys:merged.totalKeys};
    }
    state.importPreview=questions;state.importValidation=validateQuestions(questions);renderImportPreview();
  }catch(e){console.error(e);box.innerHTML=`<div class="card"><h3>Error de importación</h3><p class="danger-text">${esc(e.message||e)}</p><p class="muted small">Si es un PDF escaneado, el OCR puede tardar más y requiere conexión a Internet.</p></div>`;}finally{setBusy(false)}
}
async function loadSampleImport(kind){
  const path=kind==='bio'?'data/sample_bioetica1.json':'data/sample_simulacro1.json';const data=await (await fetch(path)).json();state.importPreview=data;state.importValidation=validateQuestions(data);state.currentImportFile=null;state.currentAnswerFile=null;state.answerKeyStats=null;state.importMeta={bankType:kind==='bio'?'BANCO':'SIMULACRO',examType:'RESIDENTADO',year:null,bankName:kind==='bio'?'Banco Histórico - Bioética 1':'Simulacro 1',prefix:kind==='bio'?'BIO1':'SIM1',duration:null,specialty:kind==='bio'?'Salud Pública y Gestión':'Sin clasificar',topic:kind==='bio'?'Bioética y Deontología':'Sin clasificar',subtopic:kind==='bio'?'Bioética':'Sin clasificar'};renderImportPreview();
}
function renderImportPreview(){
  const box=document.getElementById('importPreview');if(!box||!state.importPreview)return;const v=state.importValidation||validateQuestions(state.importPreview),s=v.summary;
  const critical=v.rows.filter(r=>r.errors.length).slice(0,80);
  const keyInfo=state.answerKeyStats?`<div class="notice success"><strong>Claves cruzadas:</strong> ${state.answerKeyStats.matched} preguntas coincidieron con el solucionario (${state.answerKeyStats.totalKeys} claves detectadas).</div>`:'';
  const missingInfo=s.missingNumbers?`<div class="notice warning"><strong>Numeración incompleta:</strong> faltan ${s.missingNumbers} números: ${s.missingNumberList.join(', ')}${s.missingNumbers>s.missingNumberList.length?'…':''}</div>`:'';
  const issues=critical.length?`<details class="issue-panel" open><summary><strong>${critical.length}${v.rows.filter(r=>r.errors.length).length>critical.length?'+' : ''} preguntas con error crítico</strong></summary><div class="issue-grid">${critical.map(r=>`<div><span class="code">${esc(r.question.external_id)}</span> — ${r.errors.map(esc).join(' · ')}</div>`).join('')}</div></details>`:'';
  box.innerHTML=`<div class="card"><div class="space-between"><div><div class="kicker">PREVISUALIZACIÓN</div><h2>${state.importPreview.length} preguntas detectadas</h2></div><button id="commitImport" class="btn btn-primary">Importar a Supabase</button></div>
  <div class="import-status" style="margin:18px 0"><div class="mini-stat"><span class="muted small">Total</span><strong>${s.total}</strong></div><div class="mini-stat"><span class="muted small">Sin error crítico</span><strong>${s.valid}</strong></div><div class="mini-stat"><span class="muted small">Con error</span><strong>${s.errors}</strong></div><div class="mini-stat"><span class="muted small">Sin clave</span><strong>${s.missingAnswer}</strong></div><div class="mini-stat"><span class="muted small">Clave dudosa</span><strong>${s.lowConfidence||0}</strong></div><div class="mini-stat"><span class="muted small">Imagen pendiente</span><strong>${s.needsImage}</strong></div></div>
  ${keyInfo}${missingInfo}${issues}
  <div class="notice warning"><strong>Seguridad editorial:</strong> ninguna pregunta importada se publica automáticamente. Todas entran como <span class="code">PENDIENTE</span>.</div>
  <div class="import-preview table-wrap" style="margin-top:14px"><table class="table"><thead><tr><th>#</th><th>ID</th><th>Pregunta</th><th>Clave</th><th>Validación</th></tr></thead><tbody>${v.rows.slice(0,300).map((r,i)=>`<tr class="${r.errors.length?'row-error':r.warnings.length?'row-warning':''}"><td>${r.question._order||i+1}</td><td><span class="code">${esc(r.question.external_id)}</span></td><td>${esc(r.question.stem).slice(0,260)}</td><td><strong>${esc(r.question.correct_answer||'—')}</strong></td><td>${r.errors.length?`<div class="danger-text">${r.errors.map(esc).join('<br>')}</div>`:''}${r.warnings.length?`<div class="warning-text">${r.warnings.map(esc).join('<br>')}</div>`:'<span class="success-text">OK</span>'}</td></tr>`).join('')}</tbody></table></div></div>`;
  const commitImportBtn=document.getElementById('commitImport');if(commitImportBtn)commitImportBtn.onclick=commitImport;
}

async function commitImport(){
  if(!state.importPreview?.length)return;if(!confirm(`¿Importar ${state.importPreview.length} preguntas a Supabase como PENDIENTE?`))return;
  setBusy(true);const supa=db();
  try{
    const meta=state.importMeta||currentImportMeta();
    const importType=!state.currentImportFile?'JSON':state.currentImportFile.name.toLowerCase().endsWith('.pdf')?'PDF_RESALTADO':state.currentImportFile.name.toLowerCase().endsWith('.json')?'JSON':state.currentImportFile.name.toLowerCase().endsWith('.csv')?'CSV':'XLSX';
    const {data:batch,error:be}=await supa.from('import_batches').insert({import_type:importType,bank_type:meta.bankType,exam_type:meta.examType,name:meta.bankName,file_name:state.currentImportFile?.name||'ejemplo-integrado.json',status:'IMPORTANDO',total_rows:state.importPreview.length,metadata:{...meta,answer_key_file:state.currentAnswerFile?.name||null,answer_key_matched:state.answerKeyStats?.matched||0},created_by:state.user.id}).select().single();if(be)throw be;
    let storagePath=null;
    if(state.currentImportFile){storagePath=`${state.user.id}/${batch.id}/${state.currentImportFile.name.replace(/[^A-Za-z0-9._-]/g,'_')}`;const up=await supa.storage.from('import-files').upload(storagePath,state.currentImportFile,{upsert:true});if(up.error)console.warn('No se pudo guardar archivo fuente:',up.error.message);else await supa.from('import_batches').update({storage_path:storagePath}).eq('id',batch.id);}
    if(state.currentAnswerFile){const keyPath=`${state.user.id}/${batch.id}/CLAVES_${state.currentAnswerFile.name.replace(/[^A-Za-z0-9._-]/g,'_')}`;const keyUp=await supa.storage.from('import-files').upload(keyPath,state.currentAnswerFile,{upsert:true});if(keyUp.error)console.warn('No se pudo guardar el archivo de claves:',keyUp.error.message);}
    const validation=validateQuestions(state.importPreview);const issueMap=new Map(validation.rows.map(x=>[x.question.external_id,[...x.errors,...x.warnings]]));
    const existingMap=new Map();
    for(const part of chunk(state.importPreview.map(x=>x.external_id),100)){const {data,error}=await supa.from('questions').select('*').in('external_id',part);if(error)throw error;(data||[]).forEach(x=>existingMap.set(x.external_id,x));}
    const incomingIds=new Set(state.importPreview.map(x=>x.external_id));
    const {data:bankExisting,error:bankError}=await supa.from('questions').select('external_id').eq('bank_name',meta.bankName).limit(5000);if(bankError)throw bankError;
    const sync={new:0,modified:0,unchanged:0,missing:(bankExisting||[]).filter(x=>!incomingIds.has(x.external_id)).length};
    const actions=new Map();
    const rows=[];
    for(const q of state.importPreview){
      const prior=existingMap.get(q.external_id);
      if(prior && prior.source_hash && prior.source_hash===q.source_hash){sync.unchanged++;actions.set(q.external_id,'SIN_CAMBIOS');continue;}
      const copy=Object.fromEntries(Object.entries(q).filter(([k])=>!k.startsWith('_')));const issues=issueMap.get(q.external_id)||[];copy.review_notes=[copy.review_notes,issues.length?`Validación: ${issues.join(' | ')}`:''].filter(Boolean).join(' ');copy.status='PENDIENTE';copy.created_by=prior?undefined:state.user.id;copy.updated_by=state.user.id;
      if(copy.created_by===undefined) delete copy.created_by;
      if(prior){copy.version=(prior.version||1)+1;sync.modified++;actions.set(q.external_id,'MODIFICADA');}
      else{copy.version=1;sync.new++;actions.set(q.external_id,'NUEVA');}
      rows.push(copy);
    }
    const versionSnapshots=[];
    for(const q of state.importPreview){const prior=existingMap.get(q.external_id);if(prior && actions.get(q.external_id)==='MODIFICADA')versionSnapshots.push({question_id:prior.id,version:prior.version||1,snapshot:prior,changed_by:state.user.id});}
    for(const part of chunk(versionSnapshots,100)){if(!part.length)continue;const {error}=await supa.from('question_versions').upsert(part,{onConflict:'question_id,version',ignoreDuplicates:true});if(error)throw error;}
    for(const part of chunk(rows,100)){if(!part.length)continue;const {error}=await supa.from('questions').upsert(part,{onConflict:'external_id'});if(error)throw error;}
    const idMap=new Map();for(const part of chunk(state.importPreview.map(x=>x.external_id),100)){const {data,error}=await supa.from('questions').select('id,external_id').in('external_id',part);if(error)throw error;(data||[]).forEach(x=>idMap.set(x.external_id,x.id));}
    const importItems=state.importPreview.map((q,i)=>{const action=actions.get(q.external_id)||'NUEVA';const issues=[...(issueMap.get(q.external_id)||[]),`Sincronización: ${action}`];return {batch_id:batch.id,row_number:q._order||i+1,external_id:q.external_id,raw_data:{source:state.currentImportFile?.name||'sample'},normalized_data:Object.fromEntries(Object.entries(q).filter(([k])=>!k.startsWith('_'))),status:action==='SIN_CAMBIOS'?'OMITIDO':'IMPORTADO',errors:issues,linked_question_id:idMap.get(q.external_id)||null};});
    for(const part of chunk(importItems,100)){const {error}=await supa.from('import_items').insert(part);if(error)console.warn(error);}
    if(meta.bankType==='SIMULACRO'){
      const code=(meta.prefix||meta.bankName).toUpperCase().replace(/[^A-Z0-9_-]/g,'-');
      const {data:sim,error}=await supa.from('simulation_sets').upsert({code,name:meta.bankName,exam_type:meta.examType,year:Number(meta.year)||null,duration_minutes:meta.duration||null,question_count:state.importPreview.length,status:'BORRADOR',source_reference:state.currentImportFile?.name||meta.bankName,created_by:state.user.id},{onConflict:'code'}).select().single();if(error)throw error;
      await supa.from('simulation_questions').delete().eq('simulation_id',sim.id);
      const links=state.importPreview.map((q,i)=>({simulation_id:sim.id,question_id:idMap.get(q.external_id),order_no:q._order||i+1,is_reserve:false})).filter(x=>x.question_id);
      for(const part of chunk(links,100)){const {error:e}=await supa.from('simulation_questions').insert(part);if(e)throw e;}
    }
    const report={...validation.summary,sync};
    await supa.from('import_batches').update({status:validation.summary.errors?'CON_ERRORES':'COMPLETADO',valid_rows:validation.summary.valid,error_rows:validation.summary.errors,report}).eq('id',batch.id);
    notify(`Importación: ${sync.new} nuevas · ${sync.modified} modificadas · ${sync.unchanged} sin cambios.`,6000);state.importPreview=null;state.importValidation=null;state.currentImportFile=null;state.currentAnswerFile=null;state.answerKeyStats=null;state.adminTab='questions';await renderAdmin();
  }catch(e){console.error(e);notify(e.message||'Falló la importación',6000)}finally{setBusy(false)}
}

async function renderAdminSimulations(){
  const el=document.getElementById('adminContent');if(!el)return;const {data,error}=await db().from('simulation_sets').select('*').order('created_at',{ascending:false});if(error)throw error;
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Simulacros</h2><p class="muted">Un simulacro queda en BORRADOR al importarse y se publica cuando termines de revisar sus preguntas.</p></div></div>${data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Nombre</th><th>Examen</th><th>Preguntas</th><th>Duración</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(s=>`<tr><td><span class="code">${esc(s.code)}</span></td><td>${esc(s.name)}</td><td>${esc(s.exam_type)}</td><td>${s.question_count}</td><td>${s.duration_minutes||'—'}</td><td class="status ${s.status==='PUBLICADO'?'ok':'warn'}">${s.status}</td><td><button class="btn btn-soft" data-toggle-sim="${s.id}" data-status="${s.status}">${s.status==='PUBLICADO'?'Pasar a borrador':'Publicar'}</button></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No hay simulacros.</div>'}</div>`;
  document.querySelectorAll('[data-toggle-sim]').forEach(b=>b.onclick=()=>toggleSimulation(b.dataset.toggleSim,b.dataset.status));
}
async function toggleSimulation(id,status){const next=status==='PUBLICADO'?'BORRADOR':'PUBLICADO';const {error}=await db().from('simulation_sets').update({status:next}).eq('id',id);if(error)notify(error.message);else{notify(`Simulacro ${next.toLowerCase()}`);renderAdminSimulations();}}

async function renderAdminReports(){
  const el=document.getElementById('adminContent');if(!el)return;
  const {data,error}=await db().from('question_reports').select('id,reason,comment,status,created_at,user_id,questions(id,external_id,stem,status)').order('created_at',{ascending:false}).limit(100);
  if(error)throw error;
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Reportes de alumnos</h2><p class="muted">Errores de clave, OCR, actualización o imágenes reportados desde el banqueo.</p></div></div>${data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Pregunta</th><th>Motivo</th><th>Comentario</th><th>Estado</th><th></th></tr></thead><tbody>${data.map(r=>`<tr><td>${fmt(r.created_at)}</td><td><span class="code">${esc(r.questions?.external_id||'—')}</span><br><span class="muted small">${esc(r.questions?.stem||'').slice(0,160)}</span></td><td>${esc(r.reason)}</td><td>${esc(r.comment||'—')}</td><td class="status ${r.status==='PENDIENTE'?'warn':r.status==='RESUELTO'?'ok':''}">${esc(r.status)}</td><td><div class="inline"><button class="btn btn-soft" data-report-status="REVISADO" data-report-id="${r.id}">Revisado</button><button class="btn btn-soft" data-report-status="RESUELTO" data-report-id="${r.id}">Resolver</button>${r.questions?.id?`<button class="btn" data-edit-report-q="${r.questions.id}">Abrir pregunta</button>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No hay reportes.</div>'}</div>`;
  document.querySelectorAll('[data-report-status]').forEach(b=>b.onclick=async()=>{const {error}=await db().from('question_reports').update({status:b.dataset.reportStatus}).eq('id',b.dataset.reportId);if(error)notify(error.message);else renderAdminReports();});
  document.querySelectorAll('[data-edit-report-q]').forEach(b=>b.onclick=()=>openQuestionEditor(b.dataset.editReportQ));
}

async function renderAdminBatches(){
  const el=document.getElementById('adminContent');if(!el)return;const {data,error}=await db().from('import_batches').select('*').order('created_at',{ascending:false}).limit(50);if(error)throw error;
  el.innerHTML=`<div class="card"><div class="section-head" style="margin-top:0"><div><h2>Historial de importaciones</h2><p class="muted">Trazabilidad de archivos, lotes y errores.</p></div></div>${data?.length?`<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Nombre</th><th>Tipo</th><th>Total</th><th>Válidas</th><th>Errores</th><th>Estado</th></tr></thead><tbody>${data.map(x=>`<tr><td>${fmt(x.created_at)}</td><td>${esc(x.name)}<br><span class="muted small">${esc(x.file_name||'')}</span>${x.report?.sync?`<br><span class="muted small">${x.report.sync.new||0} nuevas · ${x.report.sync.modified||0} mod. · ${x.report.sync.unchanged||0} iguales${x.report.sync.missing?` · ${x.report.sync.missing} ausentes`:''}</span>`:''}</td><td>${esc(x.import_type)} / ${esc(x.bank_type)}</td><td>${x.total_rows}</td><td>${x.valid_rows}</td><td>${x.error_rows}</td><td class="status ${x.status==='COMPLETADO'?'ok':x.status==='CON_ERRORES'?'warn':''}">${esc(x.status)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">Sin importaciones todavía.</div>'}</div>`;
}

async function openQuestionEditor(id){
  const {data:q,error}=await db().from('questions').select('*').eq('id',id).single();if(error){notify(error.message);return;}
  const opts=q.options||{};
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal"><div class="space-between"><div><div class="kicker">${esc(q.external_id)}</div><h2>Editar pregunta</h2></div><button id="closeModal" class="btn">Cerrar</button></div>
    <div class="form-grid-3" style="margin-top:16px"><div class="field"><label>Examen</label><select id="eExam">${APP_CONFIG.exams.map(x=>`<option ${q.exam_type===x.value?'selected':''} value="${x.value}">${x.label}</option>`).join('')}</select></div><div class="field"><label>Banco</label><input id="eBank" value="${esc(q.bank_name)}" /></div><div class="field"><label>Año</label><input id="eYear" type="number" value="${q.year||''}" /></div><div class="field"><label>Especialidad</label><input id="eSpec" value="${esc(q.specialty)}" /></div><div class="field"><label>Tema</label><input id="eTopic" value="${esc(q.topic)}" /></div><div class="field"><label>Subtema</label><input id="eSub" value="${esc(q.subtopic)}" /></div></div>
    <div class="field" style="margin-top:12px"><label>Enunciado</label><textarea id="eStem" class="textarea-lg">${esc(q.stem)}</textarea></div>
    <div class="form-grid" style="margin-top:12px">${['A','B','C','D','E'].map(k=>`<div class="field"><label>Opción ${k}</label><textarea id="e${k}" class="textarea-md">${esc(opts[k]||'')}</textarea></div>`).join('')}<div class="field"><label>Respuesta correcta</label><select id="eAnswer">${['','A','B','C','D','E'].map(k=>`<option ${q.correct_answer===k?'selected':''}>${k}</option>`).join('')}</select></div></div>
    <div class="field" style="margin-top:12px"><label>Explicación</label><textarea id="eExplanation" class="textarea-lg">${esc(q.explanation||'')}</textarea></div><div class="field" style="margin-top:12px"><label>Dato galáctico</label><textarea id="eTip" class="textarea-md">${esc(q.galactic_tip||'')}</textarea></div>
    <div class="form-grid" style="margin-top:12px"><div class="field"><label>Imagen</label><input id="eImage" value="${esc(q.image_url||'')}" placeholder="URL o ruta" /><div class="inline" style="margin-top:8px"><input id="eImageFile" type="file" accept="image/*" /><button id="uploadImage" class="btn btn-soft" type="button">Subir a Storage</button></div></div><div class="field"><label>Observaciones internas</label><textarea id="eNotes" class="textarea-md">${esc(q.review_notes||'')}</textarea></div></div>
    <label class="checkbox" style="margin-top:12px"><input id="eRequiresImage" type="checkbox" ${q.requires_image?'checked':''}/> Esta pregunta requiere imagen</label>
    <div class="modal-actions"><button class="btn btn-danger" data-qstatus="ARCHIVADA">Archivar</button><button class="btn" data-qstatus="PENDIENTE">Pendiente</button><button class="btn" data-qstatus="APROBADA">Aprobar</button><button class="btn btn-primary" data-qstatus="PUBLICADA">Publicar</button><button id="saveQuestion" class="btn btn-primary">Guardar cambios</button></div></div></div>`;
  document.getElementById('closeModal').onclick=closeModal;document.querySelector('.modal-backdrop').onclick=e=>{if(e.target.classList.contains('modal-backdrop'))closeModal()};
  document.getElementById('uploadImage').onclick=()=>uploadQuestionImage(q);
  const collect=()=>{const options={};['A','B','C','D','E'].forEach(k=>{const v=document.getElementById(`e${k}`).value.trim();if(v)options[k]=v});return {exam_type:document.getElementById('eExam').value,bank_name:document.getElementById('eBank').value.trim(),year:Number(document.getElementById('eYear').value)||null,specialty:document.getElementById('eSpec').value.trim()||'Sin clasificar',topic:document.getElementById('eTopic').value.trim()||'Sin clasificar',subtopic:document.getElementById('eSub').value.trim()||'Sin clasificar',stem:document.getElementById('eStem').value.trim(),options,correct_answer:document.getElementById('eAnswer').value||null,explanation:document.getElementById('eExplanation').value.trim(),galactic_tip:document.getElementById('eTip').value.trim(),image_url:document.getElementById('eImage').value.trim()||null,requires_image:document.getElementById('eRequiresImage').checked,review_notes:document.getElementById('eNotes').value.trim(),updated_by:state.user.id};};
  const save=async status=>{const payload=collect();if(status)payload.status=status;if(payload.status==='PUBLICADA' || status==='PUBLICADA'){if(!payload.correct_answer||Object.keys(payload.options).length<2||!payload.stem){notify('No se puede publicar: revisa enunciado, opciones y clave.',4500);return;}if(payload.requires_image&&!payload.image_url&&!confirm('La pregunta requiere imagen pero no tiene URL. ¿Publicar de todas formas?'))return;}const {error}=await db().from('questions').update(payload).eq('id',id);if(error)notify(error.message);else{notify('Pregunta guardada');closeModal();loadAdminQuestionsTable();}};
  document.getElementById('saveQuestion').onclick=()=>save(null);document.querySelectorAll('[data-qstatus]').forEach(b=>b.onclick=()=>save(b.dataset.qstatus));
}
async function uploadQuestionImage(q){
  const input=document.getElementById('eImageFile');const file=input?.files?.[0];if(!file){notify('Selecciona una imagen');return;}
  setBusy(true);
  try{
    const ext=(file.name.split('.').pop()||'png').replace(/[^A-Za-z0-9]/g,'').toLowerCase();
    const safe=(q.external_id||q.id).replace(/[^A-Za-z0-9_-]/g,'_');
    const path=`questions/${safe}-${Date.now()}.${ext}`;
    const {error}=await db().storage.from('question-assets').upload(path,file,{upsert:false,contentType:file.type||undefined});if(error)throw error;
    const {data}=db().storage.from('question-assets').getPublicUrl(path);
    const url=data?.publicUrl;if(!url)throw new Error('No se pudo obtener la URL pública');
    document.getElementById('eImage').value=url;document.getElementById('eRequiresImage').checked=true;notify('Imagen subida. Guarda la pregunta para aplicar el cambio.');
  }catch(e){notify(e.message||'No se pudo subir la imagen',5000)}finally{setBusy(false)}
}

function closeModal(){modalRoot.innerHTML='';}

function showReportModal(q){
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal" style="max-width:580px"><h2>Reportar pregunta</h2><p class="muted">${esc(q.external_id)}</p><div class="field"><label>Motivo</label><select id="reportReason"><option>Clave incorrecta</option><option>Pregunta desactualizada</option><option>Error de redacción/OCR</option><option>Imagen faltante</option><option>Otro</option></select></div><div class="field" style="margin-top:12px"><label>Comentario</label><textarea id="reportComment" class="textarea-md"></textarea></div><div class="modal-actions"><button class="btn" id="cancelReport">Cancelar</button><button class="btn btn-primary" id="sendReport">Enviar reporte</button></div></div></div>`;
  document.getElementById('cancelReport').onclick=closeModal;document.getElementById('sendReport').onclick=async()=>{const {error}=await db().from('question_reports').insert({user_id:state.user.id,question_id:q.id,reason:document.getElementById('reportReason').value,comment:document.getElementById('reportComment').value.trim()});notify(error?error.message:'Reporte enviado');if(!error)closeModal();};
}
function showAccountModal(){
  if(!state.user)return;
  modalRoot.innerHTML=`<div class="modal-backdrop"><div class="modal" style="max-width:520px"><div class="space-between"><div><div class="kicker">CUENTA</div><h2>${esc(state.profile?.full_name||'Usuario')}</h2></div><button id="closeAccount" class="btn">Cerrar</button></div><p>${esc(state.user.email)}</p><div class="pill-row"><span class="tag">Rol: ${esc(state.profile?.role)}</span><span class="tag">Plan: ${esc(state.profile?.plan)}</span><span class="tag">Objetivo: ${esc(state.profile?.target_exam)}</span></div><div class="divider"></div><button id="signOut" class="btn btn-danger">Cerrar sesión</button></div></div>`;
  document.getElementById('closeAccount').onclick=closeModal;document.getElementById('signOut').onclick=async()=>{if(state.active&&!state.active.finished&&!confirm('Tienes una sesión guardada. ¿Cerrar sesión de todas formas?'))return;await db().auth.signOut();closeModal();};
}

document.addEventListener('click',e=>{const b=e.target.closest('[data-go]');if(b){e.preventDefault();go(b.dataset.go)}});
init().catch(e=>{console.error('BANQO init error',e);setShell(false);app.innerHTML=`<section class="auth-shell"><div class="card auth-card"><div class="auth-logo"><span class="brand-mark">B</span><div><div class="kicker">BANQO PERÚ</div><h2>No se pudo iniciar BANQO</h2></div></div><p class="danger-text">${esc(e?.message||e||'Error desconocido')}</p><p class="muted small">Actualiza con Ctrl + F5. Si continúa, revisaremos el error sin cambiar la interfaz.</p><button class="btn btn-primary" onclick="location.reload()">Reintentar</button></div></section>`;});
